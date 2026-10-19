"""Servidor HTTP local: API JSON + interface web."""
import csv
import hmac
import io
import json
import mimetypes
import os
import socket
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .alerts import ACTIONS, CONDITIONS
from .core import _dns_cache, resolve

WEB = os.path.join(os.path.dirname(__file__), "web")


class ApiError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


def make_handler(app):
    class H(BaseHTTPRequestHandler):
        server_version = "Pingger/1.0"

        def log_message(self, *a):
            pass

        # ---- utilidades
        def _send(self, code, body, ctype="application/json; charset=utf-8", headers=None):
            if not isinstance(body, (bytes, bytearray)):
                body = json.dumps(body, default=str).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(n) if n else b""

        def _json(self):
            raw = self._body()
            return json.loads(raw) if raw else {}

        def _authorized(self, q):
            if self.client_address[0] in ("127.0.0.1", "::1"):
                return True
            pw = app.settings.get("web_password") or ""
            if not pw:
                return False   # acesso remoto exige senha configurada
            given = self.headers.get("X-Pingger-Key") or q.get("key", [""])[0]
            for part in (self.headers.get("Cookie") or "").split(";"):
                k, _, v = part.strip().partition("=")
                if k == "pk":
                    given = urllib.parse.unquote(v)
            return hmac.compare_digest(given, pw)

        def do_GET(self):
            self._route("GET")

        def do_POST(self):
            self._route("POST")

        def do_PUT(self):
            self._route("PUT")

        def do_DELETE(self):
            self._route("DELETE")

        def _route(self, method):
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            parts = [p for p in u.path.split("/") if p]
            try:
                if parts[:2] == ["api", "agent"]:
                    return self._agent(q)
                if not parts or parts[0] != "api":
                    if not self._authorized(q) and u.path not in ("/login.html", "/style.css"):
                        return self._send(302, b"", headers={"Location": "/login.html"})
                    return self._static(u.path)
                if parts == ["api", "login"] and method == "POST":
                    pw = self._json().get("password", "")
                    ok = bool(app.settings.get("web_password")) and hmac.compare_digest(pw, app.settings["web_password"])
                    return self._send(200 if ok else 403, {"ok": ok},
                                      headers={"Set-Cookie": f"pk={urllib.parse.quote(pw)}; Path=/; HttpOnly; SameSite=Strict"} if ok else None)
                if not self._authorized(q):
                    raise ApiError(401, "não autorizado")
                return self._api(method, parts[1:], q)
            except ApiError as e:
                self._send(e.code, {"error": str(e)})
            except KeyError as e:
                self._send(404, {"error": f"não encontrado: {e}"})
            except Exception as e:
                self._send(500, {"error": f"{type(e).__name__}: {e}"})

        def _static(self, path):
            if path in ("", "/"):
                path = "/index.html"
            full = os.path.normpath(os.path.join(WEB, path.lstrip("/")))
            if not full.startswith(WEB) or not os.path.isfile(full):
                return self._send(404, b"not found", "text/plain")
            with open(full, "rb") as fh:
                data = fh.read()
            ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            self._send(200, data, ctype)

        def _agent(self, q):
            if not app.settings.get("agent_enabled"):
                raise ApiError(403, "agente remoto desativado nesta máquina")
            key = app.settings.get("agent_key") or ""
            if not key or not hmac.compare_digest(q.get("key", [""])[0], key):
                raise ApiError(401, "chave do agente inválida")
            ttls = [int(x) for x in q.get("ttls", [""])[0].split(",") if x][:64]
            res = app.agent_probe(q["host"][0], ttls, q.get("final", ["0"])[0] == "1",
                                  int(q.get("timeout_ms", ["3000"])[0]), int(q.get("size", ["56"])[0]))
            self._send(200, res)

        def _download(self, data, filename, ctype):
            self._send(200, data, ctype, {"Content-Disposition": f'attachment; filename="{filename}"'})

        # ---- API
        def _api(self, m, p, q):
            g = lambda k, d=None: q.get(k, [d])[0]
            fnum = lambda k: float(g(k)) if g(k) not in (None, "") else None

            if p == ["state"]:
                return self._send(200, {
                    "version": app.version, "workspace": app.workspace,
                    "sessions": [s.info() for s in app.sessions.values()],
                    "summaries": app.summaries, "active_alerts": app.alerts.active(),
                    "notifications": [n for n in app.alerts.notifications if n["ts"] > (fnum("since") or 0)],
                    "server_time": time.time()})
            if p == ["meta"]:
                return self._send(200, {"conditions": CONDITIONS, "actions": ACTIONS,
                                        "sounds": sorted(f[:-4] for f in os.listdir(app.sound_dir) if f.endswith(".wav")),
                                        "hostname": socket.gethostname(), "data_dir": app.data_dir})

            # -- sessões
            if p == ["sessions"] and m == "POST":
                b = self._json()
                cfg = dict(app.settings["named_configs"].get(b.get("config") or "", {}))
                cfg.update(b.get("settings") or {})
                out = []
                for host in [h for h in str(b["host"]).replace(",", " ").split() if h]:
                    out.append(app.new_session(host, cfg, name=b.get("name") if len(out) == 0 else None).info())
                return self._send(200, out)
            if p == ["sessions", "saved"]:
                return self._send(200, app.store.list_sessions())
            if len(p) >= 2 and p[0] == "sessions":
                sid = p[1]
                if len(p) == 3 and p[2] == "open" and m == "POST":
                    s = app.open_saved(sid, start=self._json().get("start", False))
                    return self._send(200, s.info() if s else {"error": "não existe"})
                if m == "DELETE" and len(p) == 2:
                    if g("purge") == "1" and sid not in app.sessions:
                        app.store.delete_session(sid)
                    else:
                        app.close_session(sid, discard=g("discard") == "1")
                    return self._send(200, {"ok": True})
                s = app.sessions[sid]
                if len(p) == 2:
                    if m in ("POST", "PUT"):
                        return self._send(200, app.update_session(sid, self._json()).info())
                    return self._send(200, s.info())
                act = p[2]
                if act == "start":
                    s.start()
                    return self._send(200, s.info())
                if act == "stop":
                    s.stop()
                    return self._send(200, s.info())
                if act == "reset":
                    s.reset()
                    return self._send(200, s.info())
                if act == "hops":
                    return self._send(200, s.hops(fnum("start"), fnum("end"), fnum("last_n")))
                if act == "timeline":
                    return self._send(200, s.timeline(int(g("hop", "-1")), fnum("start"), fnum("end"),
                                                      max(10, min(4000, int(g("buckets", "600"))))))
                if act == "routes":
                    return self._send(200, {"routes": s.routes, "times": s.route_times,
                                            "names": {ip: _dns_cache.get(ip, "") for r in s.routes for ip in r if ip}})
                if act == "export.csv":
                    buf = io.StringIO()
                    csv.writer(buf, delimiter=g("sep", ",")).writerows(
                        s.export_rows(fnum("start"), fnum("end"), g("layout", "long")))
                    return self._download(buf.getvalue().encode("utf-8-sig"),
                                          f"{s.host}-{time.strftime('%Y%m%d-%H%M%S')}.csv", "text/csv")
                if act == "export.pgr":
                    return self._download(app.pgr_bytes(s, fnum("start"), fnum("end")),
                                          f"{s.host}-{time.strftime('%Y%m%d-%H%M%S')}.pgr", "application/gzip")
                if act == "text":
                    st = s.hops(fnum("start"), fnum("end"), fnum("last_n"))
                    lines = [f"Pingger — {s.name} ({s.ip}) — {st['samples']} amostras",
                             "Hop\tPerda%\tIP\tNome\tMédia\tMín\tAtual\tMáx\tJitter\tMOS"]
                    for h in st["hops"]:
                        lines.append("\t".join(str(x if x is not None else "-") for x in
                                               (h["hop"], h["loss_pct"], h["ip"], h["name"], h["avg"], h["min"],
                                                h["cur"], h["max"], h["jitter"], h["mos"])))
                    return self._send(200, "\n".join(lines).encode(), "text/plain; charset=utf-8")
                if act == "test-alert" and m == "POST":
                    a = next(x for x in app.alerts.alerts if x["id"] == self._json()["alert"])
                    app.alerts.fire(a, s, "teste", "teste manual", test=True)
                    return self._send(200, {"ok": True})
                raise KeyError(act)

            if p == ["import"] and m == "POST":
                return self._send(200, app.import_pgr(self._body()).info())
            if p == ["targets", "export"]:
                lines = [f"{s.host}\t{s.name}\t{json.dumps(s.settings)}" for s in app.sessions.values()]
                return self._download("\n".join(lines).encode(), "alvos.txt", "text/plain")
            if p == ["targets", "import"] and m == "POST":
                out = []
                for line in self._body().decode("utf-8-sig").splitlines():
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    cols = line.split("\t")
                    cfg = json.loads(cols[2]) if len(cols) > 2 and cols[2].startswith("{") else {}
                    out.append(app.new_session(cols[0], cfg, name=cols[1] if len(cols) > 1 and cols[1] else None).info())
                return self._send(200, out)

            # -- resumos
            if p == ["summaries"] and m == "POST":
                b = self._json()
                sm = next((x for x in app.summaries if x["id"] == b.get("id")), None)
                if sm:
                    sm.update({k: b[k] for k in ("name", "members") if k in b})
                else:
                    import uuid
                    sm = {"id": uuid.uuid4().hex[:8], "name": b.get("name") or "Resumo", "members": b.get("members", [])}
                    app.summaries.append(sm)
                app.save_summaries()
                return self._send(200, sm)
            if len(p) == 2 and p[0] == "summaries" and m == "DELETE":
                app.summaries = [x for x in app.summaries if x["id"] != p[1]]
                app.save_summaries()
                return self._send(200, {"ok": True})

            # -- workspaces
            if p == ["workspaces"]:
                if m == "POST":
                    b = self._json()
                    if b.get("action") == "load":
                        app.load_workspace(b["name"])
                    elif b.get("action") == "delete":
                        app.delete_workspace(b["name"])
                    elif b.get("action") == "new":
                        app.save_workspace(app.workspace)
                        for sid in list(app.sessions):
                            app.close_session(sid)
                        app.summaries = []
                        app.save_summaries()
                        app.save_workspace(b["name"])
                    else:
                        app.save_workspace(b.get("name") or app.workspace)
                return self._send(200, {"current": app.workspace, "all": app.workspaces()})

            # -- alertas
            if p == ["alerts"]:
                if m == "POST":
                    return self._send(200, app.alerts.upsert(self._json()))
                return self._send(200, app.alerts.alerts)
            if len(p) == 2 and p[0] == "alerts" and m == "DELETE":
                app.alerts.delete(p[1])
                return self._send(200, {"ok": True})
            if p == ["events"]:
                if m == "DELETE":
                    app.store.clear_events()
                return self._send(200, app.store.events(int(g("limit", "500"))))

            # -- configurações
            if p == ["settings"]:
                if m == "POST":
                    app.save_settings(self._json())
                safe = dict(app.settings)
                return self._send(200, safe)

            # -- ferramentas
            if p == ["whois"]:
                return self._send(200, app.whois(g("ip")))
            if p == ["dns"]:
                host = g("host")
                try:
                    infos = socket.getaddrinfo(host, None)
                    addrs = sorted({i[4][0] for i in infos})
                except OSError as e:
                    addrs, err = [], str(e)
                else:
                    err = ""
                rev = ""
                try:
                    rev = socket.gethostbyaddr(resolve(host))[0]
                except OSError:
                    pass
                return self._send(200, {"host": host, "addresses": addrs, "reverse": rev, "error": err})
            raise KeyError("/".join(p))

    return H


def serve(app, port, bind):
    httpd = ThreadingHTTPServer((bind, port), make_handler(app))
    httpd.daemon_threads = True
    return httpd
