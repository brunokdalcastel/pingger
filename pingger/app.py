"""Estado global do Pingger: sessões, resumos, workspaces, configurações e agente remoto."""
import gzip
import json
import os
import threading
import time
import urllib.request
import uuid

from . import icmp
from .alerts import AlertManager, build_sounds
from .core import DEFAULT_TARGET_SETTINGS, POOL, Session, resolve
from .store import Store

DEFAULT_SETTINGS = {
    "port": 7465,
    "bind": "127.0.0.1",          # 0.0.0.0 para acesso remoto ao painel web
    "web_password": "",
    "theme": "auto",
    "latency_warn": 100,
    "latency_bad": 200,
    "graph_scale": "auto",        # auto | número em ms
    "jitter_target": 30,
    "loss_scale": 30,             # escala do gráfico de perda (%)
    "show_jitter_graph": False,
    "show_route_changes": True,
    "default_period": 600,        # segundos visíveis na timeline
    "samples_to_include": 0,      # 0 = toda a janela visível
    "retention_days": 30,
    "flush_seconds": 5,
    "smtp_host": "", "smtp_port": 587, "smtp_security": "starttls", "smtp_user": "",
    "smtp_password": "", "smtp_from": "", "smtp_to": "",
    "allow_exec": False,
    "agent_enabled": False,
    "agent_key": "",
    "auto_export": {"enabled": False, "folder": "", "minutes": 60, "format": "csv"},
    "defaults": DEFAULT_TARGET_SETTINGS,
    "named_configs": {
        "VoIP / jogos (1s)": {"interval": 1, "packet_size": 56},
        "Monitoramento longo (15s)": {"interval": 15},
        "TCP 443 (firewall bloqueia ICMP)": {"engine": "tcp", "port": 443, "mode": "final"},
    },
}


class App:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        os.makedirs(data_dir, exist_ok=True)
        self.sound_dir = os.path.join(data_dir, "sounds")
        build_sounds(self.sound_dir)
        self.store = Store(os.path.join(data_dir, "pingger.db"))
        self.settings = json.loads(json.dumps(DEFAULT_SETTINGS))
        saved = self.store.get("settings", {})
        for k, v in saved.items():
            if isinstance(v, dict) and isinstance(self.settings.get(k), dict) and k != "named_configs":
                self.settings[k].update(v)
            else:
                self.settings[k] = v
        self.sessions = {}
        self.summaries = self.store.get("summaries", [])
        self.workspace = self.store.get("current_workspace", "Padrão")
        self.alerts = AlertManager(self)
        self.version = 0          # incrementa a cada amostra; o front usa para saber se há novidade
        self._last_export = time.time()
        self.lock = threading.RLock()
        for row in self.store.list_sessions():
            if row["open"]:
                self.open_saved(row["id"], start=True)
        threading.Thread(target=self._housekeeping, daemon=True, name="housekeeping").start()

    # ---- configurações
    def save_settings(self, patch):
        for k, v in patch.items():
            if k in self.settings:
                self.settings[k] = v
        self.store.put("settings", self.settings)

    # ---- sessões
    def new_session(self, host, settings=None, start=True, name=None):
        merged = dict(self.settings["defaults"])
        merged.update(settings or {})
        s = Session(self, host, merged, name=name)
        with self.lock:
            self.sessions[s.id] = s
        if s.settings["keep"]:
            self.store.save_session(s)
        if start:
            s.start()
        return s

    def open_saved(self, sid, start=False):
        row = next((r for r in self.store.list_sessions() if r["id"] == sid), None)
        if not row:
            return None
        if sid in self.sessions:
            return self.sessions[sid]
        s = Session(self, row["host"], row["settings"], sid=sid, name=row["name"], created=row["created"])
        days = self.settings["retention_days"] or 30
        self.store.load_into(s, since=time.time() - days * 86400)
        cap = int(s.settings["max_samples_memory"])
        if len(s.ts) > cap:
            drop = len(s.ts) - cap
            del s.ts[:drop]
            del s.route_of[:drop]
            del s.rtts[:drop]
        with self.lock:
            self.sessions[sid] = s
        self.store.set_open(sid, True)
        if start:
            s.start()
        else:
            s.historical = True
        return s

    def close_session(self, sid, discard=False):
        s = self.sessions.pop(sid, None)
        if not s:
            return
        s.stop()
        if discard or not s.settings["keep"]:
            self.store.delete_session(sid)
        else:
            self.store.flush(s)
            self.store.save_session(s, open_=False)
        for sm in self.summaries:
            if sid in sm["members"]:
                sm["members"].remove(sid)
        self.store.put("summaries", self.summaries)

    def update_session(self, sid, patch):
        s = self.sessions[sid]
        name = patch.pop("name", None)
        if name:
            s.name = name
        mode_change = any(k in patch and patch[k] != s.settings.get(k)
                          for k in ("mode", "engine", "hop", "ip_version", "agent_url"))
        s.settings.update(patch)
        if mode_change:
            s.dest_ttl = None
            s.ip = None
        if s.settings["keep"]:
            self.store.save_session(s)
        return s

    def on_sample(self, s):
        self.version += 1
        self.alerts.check(s)

    def on_route_change(self, s, t):
        self.store.event("route_change", s.id, "", f"{s.host}: rota mudou")
        self.alerts.check(s, route_changed=True)

    # ---- arquivos .pgr (JSON gzip)
    def write_pgr(self, s, path, start=None, end=None):
        with gzip.open(path, "wt", encoding="utf-8") as fh:
            json.dump(s.to_document(start, end), fh)

    def pgr_bytes(self, s, start=None, end=None):
        return gzip.compress(json.dumps(s.to_document(start, end)).encode())

    def import_pgr(self, raw):
        try:
            doc = json.loads(gzip.decompress(raw))
        except OSError:
            doc = json.loads(raw)
        if doc.get("format") != "pingger-session":
            raise ValueError("arquivo não é uma sessão do Pingger")
        settings = dict(doc.get("settings") or {})
        settings["keep"] = False
        s = Session(self, doc["host"], settings, name=(doc.get("name") or doc["host"]) + " (importado)")
        s.load_document(doc)
        s.historical = True
        with self.lock:
            self.sessions[s.id] = s
        return s

    # ---- resumos
    def save_summaries(self):
        self.store.put("summaries", self.summaries)

    def summary_member(self, summary_id, sid, add):
        sm = next((x for x in self.summaries if x["id"] == summary_id or x["name"] == summary_id), None)
        if not sm:
            if not add:
                return
            sm = {"id": uuid.uuid4().hex[:8], "name": summary_id or "Alertas", "members": []}
            self.summaries.append(sm)
        if add and sid not in sm["members"]:
            sm["members"].append(sid)
        if not add and sid in sm["members"]:
            sm["members"].remove(sid)
        self.save_summaries()

    # ---- workspaces
    def workspaces(self):
        return self.store.get("workspaces", {})

    def save_workspace(self, name):
        ws = self.workspaces()
        ws[name] = {"sessions": [s.id for s in self.sessions.values() if s.settings["keep"]],
                    "running": [s.id for s in self.sessions.values() if s.running],
                    "summaries": self.summaries, "saved": time.time()}
        self.store.put("workspaces", ws)
        self.workspace = name
        self.store.put("current_workspace", name)

    def load_workspace(self, name):
        ws = self.workspaces().get(name)
        if ws is None:
            raise KeyError(name)
        self.save_workspace(self.workspace)
        for sid in list(self.sessions):
            self.close_session(sid)
        for sid in ws["sessions"]:
            self.open_saved(sid, start=sid in ws.get("running", ws["sessions"]))
        self.summaries = ws.get("summaries", [])
        self.save_summaries()
        self.workspace = name
        self.store.put("current_workspace", name)

    def delete_workspace(self, name):
        ws = self.workspaces()
        ws.pop(name, None)
        self.store.put("workspaces", ws)

    # ---- agente remoto: outra instância usa esta máquina para sondar
    def agent_probe(self, host, ttls, final, timeout_ms, size):
        ip = resolve(host)
        if final:
            return {"ip": ip, "results": {"0": icmp.ping(ip, 128, timeout_ms, size)}}
        futs = {t: POOL.submit(icmp.ping, ip, t, timeout_ms, size) for t in ttls}
        return {"ip": ip, "results": {str(t): f.result() for t, f in futs.items()}}

    # ---- whois / bloco IP (RDAP)
    @staticmethod
    def whois(ip):
        req = urllib.request.Request(f"https://rdap.org/ip/{ip}", headers={"Accept": "application/rdap+json"})
        with urllib.request.urlopen(req, timeout=20) as r:
            d = json.loads(r.read())
        ents = []

        def walk(es):
            for e in es or []:
                v = e.get("vcardArray", [None, []])[1]
                fn = next((x[3] for x in v if x[0] == "fn"), "")
                email = next((x[3] for x in v if x[0] == "email"), "")
                ents.append({"roles": e.get("roles", []), "name": fn, "email": email, "handle": e.get("handle")})
                walk(e.get("entities"))
        walk(d.get("entities"))
        return {"ip": ip, "name": d.get("name"), "handle": d.get("handle"), "country": d.get("country"),
                "start": d.get("startAddress"), "end": d.get("endAddress"), "type": d.get("type"),
                "cidr": [f"{c.get('v4prefix') or c.get('v6prefix')}/{c.get('length')}" for c in d.get("cidr0_cidrs", [])],
                "remarks": [" ".join(r.get("description", [])) for r in d.get("remarks", [])],
                "entities": ents, "source": d.get("port43") or "rdap.org"}

    # ---- manutenção periódica
    def _housekeeping(self):
        last_purge = 0
        while True:
            time.sleep(max(1, int(self.settings["flush_seconds"])))
            for s in list(self.sessions.values()):
                try:
                    if s.settings["keep"]:
                        self.store.flush(s)
                except Exception as e:
                    print("flush:", e)
            if time.time() - last_purge > 3600:
                last_purge = time.time()
                self.store.purge_older_than(self.settings["retention_days"])
            ae = self.settings["auto_export"]
            if ae.get("enabled") and time.time() - self._last_export > float(ae.get("minutes", 60)) * 60:
                self._last_export = time.time()
                self._auto_export(ae)

    def _auto_export(self, ae):
        import csv
        folder = ae.get("folder") or os.path.join(self.data_dir, "auto-export")
        os.makedirs(folder, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        start = time.time() - float(ae.get("minutes", 60)) * 60
        for s in list(self.sessions.values()):
            base = os.path.join(folder, f"{s.host.replace(':', '_')}-{stamp}")
            if ae.get("format") == "pgr":
                self.write_pgr(s, base + ".pgr", start)
            else:
                with open(base + ".csv", "w", newline="", encoding="utf-8") as fh:
                    csv.writer(fh).writerows(s.export_rows(start, None, "long"))

    def shutdown(self):
        for s in list(self.sessions.values()):
            s.stop()
            if s.settings["keep"]:
                self.store.flush(s)
                self.store.save_session(s)
