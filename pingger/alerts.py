"""Sistema de alertas: condições avaliadas a cada amostra e ações disparadas."""
import ipaddress
import json
import math
import os
import shlex
import smtplib
import ssl
import struct
import subprocess
import threading
import time
import urllib.request
import uuid
import wave
from email.message import EmailMessage

from .core import hop_stats

CONDITIONS = {
    "latency_loss": "Latência acima de X ms ou perda em N de M amostras",
    "loss_pct": "Perda média acima de P% nos últimos S segundos",
    "latency_avg": "Latência média acima de X ms nos últimos S segundos",
    "jitter": "Jitter acima de X ms nos últimos S segundos",
    "mos": "MOS médio abaixo de M nos últimos S segundos",
    "unreachable": "Destino sem resposta por N amostras seguidas",
    "route_change": "Rota mudou",
}
ACTIONS = {
    "sound": "Tocar um som",
    "notify": "Notificação na área de trabalho",
    "email": "Enviar e-mail",
    "log": "Gravar em arquivo de log",
    "exec": "Executar um programa",
    "webhook": "Chamada REST (http/https)",
    "save": "Salvar dados da sessão (.pgr)",
    "summary_add": "Adicionar ao resumo",
    "summary_remove": "Remover do resumo",
    "mode_full": "Mudar para trace de rota completa",
    "mode_final": "Mudar para trace só do destino",
}

DEFAULT_ALERT = {
    "name": "Novo alerta", "enabled": True,
    "condition": {"type": "latency_loss", "over_ms": 200, "samples_over": 5, "samples_examine": 10,
                  "seconds": 300, "percent": 10, "mos": 3.5, "min_samples": 10, "hop": "final"},
    "applies_to": [],       # ids de sessão; ou "*" ; ou CIDR em applies_cidr
    "applies_cidr": "",
    "notify_when": "start",  # start | end | both | always
    "repeat_seconds": 0,
    "actions": [{"type": "notify"}],
}

SOUNDS = {
    "sirene": [(880, .15), (660, .15)] * 3,
    "sino": [(1046, .6)],
    "sonar": [(1200, .08), (0, .35), (1200, .08)],
    "bip": [(1500, .1), (0, .08), (1500, .1)],
    "campainha": [(784, .2), (659, .2), (523, .35)],
}


def build_sounds(folder):
    os.makedirs(folder, exist_ok=True)
    rate = 22050
    for name, notes in SOUNDS.items():
        path = os.path.join(folder, name + ".wav")
        if os.path.exists(path):
            continue
        frames = bytearray()
        for freq, dur in notes:
            n = int(rate * dur)
            for i in range(n):
                env = min(1.0, i / 200, (n - i) / (n * 0.6 + 1)) if freq else 0
                v = int(12000 * env * math.sin(2 * math.pi * freq * i / rate)) if freq else 0
                frames += struct.pack("<h", v)
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(bytes(frames))


def fill_template(text, ctx):
    text = text or ""
    for k in sorted(ctx, key=len, reverse=True):
        text = text.replace("$" + k, str(ctx[k]))
    return text


class AlertManager:
    def __init__(self, app):
        self.app = app
        self.alerts = app.store.get("alerts", [])
        self.state = {}          # (alert_id, session_id) -> {"active": bool, "since": ts, "last_fire": ts}
        self.lock = threading.Lock()
        self.notifications = []  # fila de notificações para o navegador

    def save(self):
        self.app.store.put("alerts", self.alerts)

    def upsert(self, alert):
        a = json.loads(json.dumps(DEFAULT_ALERT))
        a.update(alert)
        a["condition"] = {**DEFAULT_ALERT["condition"], **(alert.get("condition") or {})}
        a.setdefault("id", uuid.uuid4().hex[:10])
        with self.lock:
            self.alerts = [x for x in self.alerts if x["id"] != a["id"]] + [a]
            self.save()
        return a

    def delete(self, aid):
        with self.lock:
            self.alerts = [x for x in self.alerts if x["id"] != aid]
            self.state = {k: v for k, v in self.state.items() if k[0] != aid}
            self.save()

    def _applies(self, a, s):
        if not a.get("enabled", True):
            return False
        targets = a.get("applies_to") or []
        if targets == "*" or "*" in targets or s.id in targets:
            return True
        cidr = (a.get("applies_cidr") or "").strip()
        if cidr.upper() == "ALL":
            return True
        if cidr and s.ip:
            try:
                return ipaddress.ip_address(s.ip) in ipaddress.ip_network(cidr, strict=False)
            except ValueError:
                return False
        return False

    # ---- avaliação
    def _evaluate(self, c, s, route_changed):
        hop = -1 if c.get("hop", "final") == "final" else int(c["hop"]) - 1
        t = c["type"]
        if t == "route_change":
            return route_changed, "rota alterada"
        if t == "latency_loss":
            vals = s.last_values(int(c["samples_examine"]), hop)
            if len(vals) < int(c["samples_examine"]):
                return False, ""
            bad = sum(1 for v in vals if math.isnan(v) or v > float(c["over_ms"]))
            return bad >= int(c["samples_over"]), f"{bad} de {len(vals)} amostras acima de {c['over_ms']} ms ou perdidas"
        if t == "unreachable":
            n = int(c["samples_over"])
            vals = s.last_values(n, hop)
            return len(vals) >= n and all(math.isnan(v) for v in vals), f"{n} amostras seguidas sem resposta"
        vals = s.values_since(float(c["seconds"]), hop)
        if len(vals) < int(c.get("min_samples", 1)):
            return False, ""
        st = hop_stats(vals)
        if t == "loss_pct":
            return st["loss_pct"] > float(c["percent"]), f"perda {st['loss_pct']}%"
        if t == "latency_avg":
            return (st["avg"] or 0) > float(c["over_ms"]) or st["avg"] is None, f"média {st['avg']} ms"
        if t == "jitter":
            return (st["jitter"] or 0) > float(c["over_ms"]), f"jitter {st['jitter']} ms"
        if t == "mos":
            return st["mos"] is None or st["mos"] < float(c["mos"]), f"MOS {st['mos']}"
        return False, ""

    def check(self, s, route_changed=False):
        for a in list(self.alerts):
            if not self._applies(a, s):
                continue
            try:
                hit, why = self._evaluate(a["condition"], s, route_changed)
            except Exception as e:
                hit, why = False, str(e)
            key = (a["id"], s.id)
            st = self.state.setdefault(key, {"active": False, "since": None, "last_fire": 0})
            now = time.time()
            when = a.get("notify_when", "start")
            if a["condition"]["type"] == "route_change":
                if hit:
                    self.fire(a, s, "start", why)
                continue
            if hit and not st["active"]:
                st.update(active=True, since=now, last_fire=now)
                self.app.store.event("alert_start", s.id, a["name"], f"{s.host}: {why}")
                if when in ("start", "both", "always"):
                    self.fire(a, s, "start", why)
            elif hit and st["active"]:
                rep = float(a.get("repeat_seconds") or 0)
                if (rep and now - st["last_fire"] >= rep) or (when == "always" and now - st["last_fire"] >= 1):
                    st["last_fire"] = now
                    self.fire(a, s, "repeat", why)
            elif not hit and st["active"]:
                st.update(active=False, since=None)
                self.app.store.event("alert_end", s.id, a["name"], f"{s.host}: condição encerrada")
                if when in ("end", "both"):
                    self.fire(a, s, "end", "condição encerrada")

    def active(self):
        return [{"alert": k[0], "session": k[1], "since": v["since"]} for k, v in self.state.items() if v["active"]]

    # ---- ações
    def context(self, a, s, state, why):
        st = s.hops(last_n=10).get("hops") or [{}]
        fin = st[-1]
        return {"host": s.host, "name": s.name, "ip": s.ip or "", "alertname": a["name"], "state": state,
                "reason": why, "time": time.strftime("%Y-%m-%d %H:%M:%S"), "latency": fin.get("avg"),
                "loss": fin.get("loss_pct"), "jitter": fin.get("jitter"), "mos": fin.get("mos"),
                "samples": fin.get("count"), "route": " > ".join(h.get("ip") or "*" for h in st)}

    def fire(self, a, s, state, why, test=False):
        ctx = self.context(a, s, state, why)
        if not test:
            self.app.store.event("alert_fire", s.id, a["name"], f"{s.host} [{state}]: {why}")
        for act in a.get("actions", []):
            threading.Thread(target=self._run_action, args=(act, a, s, ctx), daemon=True).start()

    def _run_action(self, act, a, s, ctx):
        t = act.get("type")
        cfg = self.app.settings
        try:
            if t == "sound":
                import winsound
                f = act.get("file") or "sirene"
                path = f if os.path.isabs(f) else os.path.join(self.app.sound_dir, f + ".wav")
                winsound.PlaySound(path, winsound.SND_FILENAME)
            elif t == "notify":
                self.notifications.append({"id": uuid.uuid4().hex, "ts": time.time(),
                                           "title": fill_template(act.get("title") or "Pingger: $alertname", ctx),
                                           "body": fill_template(act.get("body") or "$host ($ip) — $reason", ctx)})
                self.notifications = self.notifications[-50:]
            elif t == "email":
                msg = EmailMessage()
                msg["Subject"] = fill_template(act.get("subject") or "Pingger: $alertname em $host ($state)", ctx)
                msg["From"] = cfg["smtp_from"] or cfg["smtp_user"]
                msg["To"] = act.get("to") or cfg["smtp_to"]
                msg.set_content(fill_template(act.get("body") or
                                              "Alerta $alertname ($state) em $host ($ip) às $time.\n"
                                              "Motivo: $reason\nLatência média: $latency ms\nPerda: $loss%\n"
                                              "Jitter: $jitter ms\nMOS: $mos\nRota: $route", ctx))
                port = int(cfg["smtp_port"])
                if cfg["smtp_security"] == "ssl":
                    srv = smtplib.SMTP_SSL(cfg["smtp_host"], port, context=ssl.create_default_context(), timeout=30)
                else:
                    srv = smtplib.SMTP(cfg["smtp_host"], port, timeout=30)
                    if cfg["smtp_security"] == "starttls":
                        srv.starttls(context=ssl.create_default_context())
                with srv:
                    if cfg["smtp_user"]:
                        srv.login(cfg["smtp_user"], cfg["smtp_password"])
                    srv.send_message(msg)
            elif t == "log":
                path = act.get("path") or os.path.join(self.app.data_dir, "alertas.log")
                line = fill_template(act.get("format") or "$time\t$alertname\t$state\t$host\t$ip\t$reason\t"
                                                          "avg=$latency\tloss=$loss\tmos=$mos", ctx)
                with open(path, "a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            elif t == "exec":
                if not cfg.get("allow_exec"):
                    raise RuntimeError("execução de programas desabilitada nas configurações")
                args = [fill_template(x, ctx) for x in shlex.split(act.get("args") or "", posix=False)]
                subprocess.Popen([act["program"]] + args, close_fds=True)
            elif t == "webhook":
                method = (act.get("method") or "POST").upper()
                body = fill_template(act.get("body") or json.dumps({k: "$" + k for k in ctx}), ctx)
                url = fill_template(act["url"], ctx)
                req = urllib.request.Request(url, method=method,
                                             data=body.encode() if method != "GET" else None,
                                             headers={"Content-Type": act.get("content_type") or "application/json"})
                urllib.request.urlopen(req, timeout=20).read()
            elif t == "save":
                folder = act.get("folder") or os.path.join(self.app.data_dir, "alert-saves")
                os.makedirs(folder, exist_ok=True)
                fn = f"{s.host.replace(':', '_')}-{time.strftime('%Y%m%d-%H%M%S')}.pgr"
                self.app.write_pgr(s, os.path.join(folder, fn))
            elif t in ("summary_add", "summary_remove"):
                self.app.summary_member(act.get("summary"), s.id, t == "summary_add")
            elif t in ("mode_full", "mode_final"):
                s.settings["mode"] = "full" if t == "mode_full" else "final"
                s.dest_ttl = None
        except Exception as e:
            self.app.store.event("action_error", s.id, a["name"], f"Ação {t} falhou: {e}")
