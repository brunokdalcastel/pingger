"""Sessões de trace, motor de amostragem e estatísticas."""
import bisect
import ipaddress
import json
import math
import socket
import threading
import time
import urllib.parse
import urllib.request
import uuid
from array import array
from concurrent.futures import ThreadPoolExecutor

from . import icmp

NAN = float("nan")
POOL = ThreadPoolExecutor(max_workers=256, thread_name_prefix="probe")
# Amostras ficam em pool separado: elas esperam pelas sondas do POOL, e dividir o
# mesmo pool poderia travar com muitos alvos.
SAMPLE_POOL = ThreadPoolExecutor(max_workers=64, thread_name_prefix="sample")
DNS_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="dns")

DEFAULT_TARGET_SETTINGS = {
    "interval": 2.5,          # segundos entre amostras
    "engine": "icmp",         # icmp | tcp | udp | remote
    "mode": "full",           # full | final | hop
    "hop": 1,                 # para mode=hop
    "port": 443,              # tcp/udp
    "packet_size": 56,
    "timeout_ms": 3000,
    "max_hops": 30,
    "tos": 0,
    "dont_fragment": False,
    "resolve_names": True,
    "ip_version": "auto",     # auto | 4 | 6
    "agent_url": "",
    "agent_key": "",
    "keep": True,             # auto-save no banco
    "max_samples_memory": 200000,
}


# ---------------------------------------------------------------- DNS cache
_dns_cache = {}
_dns_lock = threading.Lock()


def reverse_name(ip):
    if not ip:
        return ""
    with _dns_lock:
        if ip in _dns_cache:
            return _dns_cache[ip]
        _dns_cache[ip] = ""   # marca "em andamento"

    def work():
        try:
            name = socket.gethostbyaddr(ip)[0]
        except OSError:
            name = ip
        with _dns_lock:
            _dns_cache[ip] = name
    DNS_POOL.submit(work)
    return ""


def resolve(host, version="auto"):
    host = host.strip()
    try:
        return str(ipaddress.ip_address(host.strip("[]")))
    except ValueError:
        pass
    fams = {"4": socket.AF_INET, "6": socket.AF_INET6}.get(str(version), 0)
    infos = socket.getaddrinfo(host, None, fams, socket.SOCK_RAW if fams else 0)
    if version == "auto":
        v4 = [i for i in infos if i[0] == socket.AF_INET]
        if v4:
            return v4[0][4][0]
    return infos[0][4][0]


# ---------------------------------------------------------------- estatísticas
def mos_score(avg, jitter, loss_pct):
    """MOS pelo modelo E simplificado (ITU-T G.107)."""
    if avg is None or math.isnan(avg):
        return None
    eff = avg + (jitter or 0) * 2 + 10
    r = 93.2 - eff / 40 if eff < 160 else 93.2 - (eff - 120) / 10
    r = max(r - loss_pct * 2.5, 0)
    mos = 1 + 0.035 * r + 0.000007 * r * (r - 60) * (100 - r)
    return round(max(1.0, min(4.5, mos)), 2)


def hop_stats(values):
    """values: lista de rtt (NaN = perdido)."""
    n = len(values)
    ok = [v for v in values if not math.isnan(v)]
    lost = n - len(ok)
    st = {"count": n, "lost": lost, "loss_pct": round(lost * 100.0 / n, 1) if n else 0.0,
          "min": None, "max": None, "avg": None, "cur": None, "jitter": None, "stddev": None, "mos": None}
    if values:
        last = values[-1]
        st["cur"] = None if math.isnan(last) else round(last, 1)
    if ok:
        avg = sum(ok) / len(ok)
        st["min"], st["max"], st["avg"] = round(min(ok), 1), round(max(ok), 1), round(avg, 1)
        if len(ok) > 1:
            diffs = [abs(ok[i] - ok[i - 1]) for i in range(1, len(ok))]
            st["jitter"] = round(sum(diffs) / len(diffs), 1)
            st["stddev"] = round(math.sqrt(sum((v - avg) ** 2 for v in ok) / len(ok)), 1)
        else:
            st["jitter"] = 0.0
            st["stddev"] = 0.0
        st["mos"] = mos_score(avg, st["jitter"], st["loss_pct"])
    return st


# ---------------------------------------------------------------- sessão
class Session:
    def __init__(self, app, host, settings=None, sid=None, name=None, created=None):
        self.app = app
        self.id = sid or uuid.uuid4().hex[:12]
        self.host = host.strip()
        self.name = name or self.host
        self.settings = dict(DEFAULT_TARGET_SETTINGS)
        self.settings.update(settings or {})
        self.created = created or time.time()
        self.ip = None
        self.error = ""
        self.running = False
        self.historical = False      # importado / carregado sem trace ativo
        self.lock = threading.RLock()
        # Dados: rotas versionadas + amostras compactas
        self.routes = []             # lista de listas de IP por hop (índice 0 = TTL 1)
        self.route_times = []        # ts em que cada versão de rota apareceu
        self.ts = array("d")
        self.route_of = array("i")
        self.rtts = []               # lista de array('f') (NaN = perda)
        self._cur_route = []
        self.dest_ttl = None
        self._pending = []           # amostras ainda não gravadas no banco
        self._thread = None
        self._stop = threading.Event()
        self._seq = 0

    # ---- ciclo de vida
    def start(self):
        if self.running:
            return
        self._stop.clear()
        self.running = True
        self.historical = False
        self._thread = threading.Thread(target=self._loop, name=f"trace-{self.host}", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        self.running = False

    def reset(self):
        with self.lock:
            self.routes, self.route_times = [], []
            self.ts, self.route_of, self.rtts = array("d"), array("i"), []
            self._cur_route, self.dest_ttl = [], None
        self.app.store.delete_samples(self.id)

    def _loop(self):
        nxt = time.time()
        while not self._stop.is_set():
            try:
                if self.ip is None or self._seq % 300 == 0:
                    self.ip = resolve(self.host, self.settings["ip_version"]) \
                        if self.settings["engine"] != "remote" else self.host
                    self.error = ""
            except OSError as e:
                self.error = f"Não foi possível resolver {self.host}: {e}"
                self._stop.wait(5)
                continue
            self._seq += 1
            try:
                SAMPLE_POOL.submit(self._take_sample, time.time())
            except RuntimeError:  # interpretador encerrando
                return
            nxt += max(0.1, float(self.settings["interval"]))
            now = time.time()
            if nxt < now:
                nxt = now
            self._stop.wait(nxt - now)

    # ---- amostragem
    def _probe_ttls(self):
        s = self.settings
        if s["engine"] in ("tcp", "udp") or s["mode"] == "final":
            return None
        if s["mode"] == "hop":
            return [max(1, int(s["hop"]))]
        top = self.dest_ttl or int(s["max_hops"])
        return list(range(1, top + 1))

    def _probe(self, ttl):
        s = self.settings
        if s["engine"] == "tcp":
            return icmp.tcp_ping(self.ip, s["port"], s["timeout_ms"])
        if s["engine"] == "udp":
            return icmp.udp_ping(self.ip, s["port"], s["timeout_ms"], s["packet_size"])
        return icmp.ping(self.ip, ttl, s["timeout_ms"], s["packet_size"], int(s["tos"]), bool(s["dont_fragment"]))

    def _remote_sample(self, ttls):
        s = self.settings
        q = urllib.parse.urlencode({"host": self.host, "ttls": ",".join(map(str, ttls or [])),
                                    "final": "1" if ttls is None else "0", "timeout_ms": s["timeout_ms"],
                                    "size": s["packet_size"], "key": s["agent_key"]})
        url = s["agent_url"].rstrip("/") + "/api/agent/probe?" + q
        with urllib.request.urlopen(url, timeout=s["timeout_ms"] / 1000 + 10) as r:
            data = json.loads(r.read())
        self.ip = data.get("ip", self.ip)
        return {int(k): tuple(v) for k, v in data["results"].items()}

    def _take_sample(self, t):
        ttls = self._probe_ttls()
        try:
            if self.settings["engine"] == "remote":
                results = self._remote_sample(ttls)
            elif ttls is None:
                results = {0: self._probe(128)}
            else:
                futs = {ttl: POOL.submit(self._probe, ttl) for ttl in ttls}
                results = {ttl: f.result() for ttl, f in futs.items()}
        except Exception as e:  # agente remoto fora do ar etc.
            self.error = f"Erro na amostra: {e}"
            return
        self._record(t, ttls, results)

    def _record(self, t, ttls, results):
        with self.lock:
            if ttls is None:      # só destino
                addr, rtt, status = results[0]
                route = [addr or self.ip]
                vals = [rtt if status == icmp.IP_SUCCESS and rtt is not None else NAN]
                self.dest_ttl = 1
            else:
                dest = None
                for ttl in sorted(results):
                    addr, rtt, status = results[ttl]
                    if status == icmp.IP_SUCCESS:
                        dest = ttl
                        break
                if self.settings["mode"] == "hop":
                    top = max(results)
                elif dest is not None:
                    top = dest
                    self.dest_ttl = dest
                else:
                    self.dest_ttl = None  # rota cresceu ou destino mudo: volta a sondar até max_hops
                    responding = [ttl for ttl, r in results.items() if r[0]]
                    top = min(max(responding) + 1, max(results)) if responding else max(results)
                route, vals = [], []
                for ttl in range(1, top + 1):
                    addr, rtt, status = results.get(ttl, (None, None, icmp.IP_REQ_TIMED_OUT))
                    ok = status == icmp.IP_SUCCESS or status in icmp.TRANSIT
                    prev = self._cur_route[ttl - 1] if ttl - 1 < len(self._cur_route) else None
                    route.append(addr if addr else prev)
                    vals.append(rtt if ok and rtt is not None else NAN)
            # Versão de rota nova?
            changed = route != self._cur_route and any(route)
            if changed:
                self._cur_route = route
                self.routes.append(list(route))
                self.route_times.append(t)
                if len(self.routes) > 1:
                    self.app.on_route_change(self, t)
            ridx = len(self.routes) - 1 if self.routes else 0
            if not self.routes:
                self.routes.append(list(route))
                self.route_times.append(t)
            pos = bisect.bisect(self.ts, t)
            self.ts.insert(pos, t)
            self.route_of.insert(pos, ridx)
            self.rtts.insert(pos, array("f", vals))
            if self.settings["resolve_names"]:
                for ip in route:
                    reverse_name(ip)
            cap = int(self.settings["max_samples_memory"])
            if len(self.ts) > cap:
                drop = len(self.ts) - cap
                del self.ts[:drop]
                del self.route_of[:drop]
                del self.rtts[:drop]
            if self.settings["keep"]:
                self._pending.append((t, ridx, list(route) if changed or len(self.routes) == 1 else None, vals))
        self.app.on_sample(self)

    def take_pending(self):
        with self.lock:
            p, self._pending = self._pending, []
            return p

    # ---- consulta
    def _window(self, start=None, end=None, last_n=None):
        lo = 0 if start is None else bisect.bisect_left(self.ts, start)
        hi = len(self.ts) if end is None else bisect.bisect_right(self.ts, end)
        if last_n:
            lo = max(lo, hi - int(last_n))
        return lo, hi

    def hop_count(self, lo, hi):
        return max((len(self.rtts[i]) for i in range(max(lo, hi - 50), hi)), default=0)

    def hops(self, start=None, end=None, last_n=None):
        with self.lock:
            lo, hi = self._window(start, end, last_n)
            if hi <= lo:
                return {"hops": [], "samples": 0, "start": start, "end": end}
            n_hops = self.hop_count(lo, hi)
            route = self.routes[self.route_of[hi - 1]] if self.routes else []
            out = []
            for h in range(n_hops):
                # Amostras com menos hops (troca de modo/rota) alinham o destino ao último hop
                # e não contam como perda nos hops que não sondaram.
                vals = []
                for i in range(lo, hi):
                    row = self.rtts[i]
                    if h == n_hops - 1 and len(row):
                        vals.append(row[-1])
                    elif h < len(row) - 1:
                        vals.append(row[h])
                st = hop_stats(vals)
                ip = route[h] if h < len(route) else None
                st.update({"hop": h + 1 if self.settings["mode"] != "final" else self.dest_ttl or 1,
                           "index": h, "ip": ip or "", "name": _dns_cache.get(ip, "") if ip else ""})
                out.append(st)
            if self.settings["mode"] == "hop" and out:
                out = out[-1:]
                out[0]["hop"] = int(self.settings["hop"])
            return {"hops": out, "samples": hi - lo, "start": self.ts[lo], "end": self.ts[hi - 1]}

    def timeline(self, hop, start, end, buckets=600):
        """Agrega o hop em `buckets` faixas de tempo (min/avg/max/perda)."""
        with self.lock:
            lo, hi = self._window(start, end)
            span = max(end - start, 1e-6)
            bs = [{"n": 0, "lost": 0, "sum": 0.0, "min": None, "max": None, "jd": 0.0, "jn": 0}
                  for _ in range(buckets)]
            prev = None
            for i in range(lo, hi):
                row = self.rtts[i]
                if hop < 0:
                    h = len(row) - 1
                else:
                    h = hop
                if h >= len(row):
                    continue
                b = min(buckets - 1, int((self.ts[i] - start) / span * buckets))
                v = row[h]
                bk = bs[b]
                bk["n"] += 1
                if math.isnan(v):
                    bk["lost"] += 1
                else:
                    if prev is not None:
                        bk["jd"] += abs(v - prev)
                        bk["jn"] += 1
                    prev = v
                    bk["sum"] += v
                    bk["min"] = v if bk["min"] is None else min(bk["min"], v)
                    bk["max"] = v if bk["max"] is None else max(bk["max"], v)
            out = []
            for bk in bs:
                ok = bk["n"] - bk["lost"]
                out.append([bk["n"], round(bk["sum"] / ok, 1) if ok else None,
                            bk["min"] and round(bk["min"], 1), bk["max"] and round(bk["max"], 1),
                            round(bk["lost"] * 100 / bk["n"], 1) if bk["n"] else None,
                            round(bk["jd"] / bk["jn"], 1) if bk["jn"] else None])
            changes = [t for t in self.route_times[1:] if start <= t <= end]
            return {"buckets": out, "route_changes": changes, "start": start, "end": end}

    def final_values(self, start, end):
        with self.lock:
            lo, hi = self._window(start, end)
            return [self.rtts[i][-1] if len(self.rtts[i]) else NAN for i in range(lo, hi)]

    def last_values(self, n, hop=-1):
        with self.lock:
            lo, hi = self._window(last_n=n)
            vals = []
            for i in range(lo, hi):
                row = self.rtts[i]
                h = len(row) - 1 if hop < 0 else hop
                vals.append(row[h] if 0 <= h < len(row) else NAN)
            return vals

    def values_since(self, seconds, hop=-1):
        with self.lock:
            lo, hi = self._window(start=time.time() - seconds)
            return [(self.rtts[i][len(self.rtts[i]) - 1 if hop < 0 else hop]
                     if 0 <= (len(self.rtts[i]) - 1 if hop < 0 else hop) < len(self.rtts[i]) else NAN)
                    for i in range(lo, hi)]

    def info(self):
        with self.lock:
            last = None
            if self.rtts:
                v = self.rtts[-1][-1] if len(self.rtts[-1]) else NAN
                last = None if math.isnan(v) else round(v, 1)
            return {"id": self.id, "host": self.host, "name": self.name, "ip": self.ip or "",
                    "running": self.running, "historical": self.historical, "error": self.error,
                    "settings": self.settings, "samples": len(self.ts),
                    "first": self.ts[0] if len(self.ts) else None, "last": self.ts[-1] if len(self.ts) else None,
                    "last_rtt": last, "route_changes": max(0, len(self.routes) - 1), "created": self.created}

    # ---- exportação
    def export_rows(self, start=None, end=None, layout="long"):
        """Linhas CSV. long: 1 linha por hop x amostra; wide: 1 linha por amostra, colunas por hop."""
        with self.lock:
            lo, hi = self._window(start, end)
            n_hops = self.hop_count(lo, hi) if hi > lo else 0
            if layout == "wide":
                route = self.routes[self.route_of[hi - 1]] if hi > lo else []
                head = ["timestamp", "datetime"] + [f"hop{h + 1} {route[h] if h < len(route) and route[h] else ''}".strip()
                                                    for h in range(n_hops)]
                yield head
                for i in range(lo, hi):
                    row = self.rtts[i]
                    yield [f"{self.ts[i]:.3f}", time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self.ts[i]))] + \
                          ["" if h >= len(row) else ("*" if math.isnan(row[h]) else f"{row[h]:.1f}") for h in range(n_hops)]
            else:
                yield ["timestamp", "datetime", "hop", "ip", "name", "rtt_ms"]
                for i in range(lo, hi):
                    route = self.routes[self.route_of[i]]
                    dt = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self.ts[i]))
                    for h, v in enumerate(self.rtts[i]):
                        ip = route[h] if h < len(route) and route[h] else ""
                        yield [f"{self.ts[i]:.3f}", dt, h + 1, ip, _dns_cache.get(ip, ""),
                               "*" if math.isnan(v) else f"{v:.1f}"]

    def to_document(self, start=None, end=None):
        with self.lock:
            lo, hi = self._window(start, end)
            used = sorted(set(self.route_of[lo:hi]))
            remap = {r: i for i, r in enumerate(used)}
            return {"format": "pingger-session", "version": 1, "host": self.host, "name": self.name,
                    "ip": self.ip, "settings": self.settings, "created": self.created,
                    "names": {ip: _dns_cache.get(ip, "") for r in used for ip in self.routes[r] if ip},
                    "routes": [self.routes[r] for r in used],
                    "route_times": [self.route_times[r] for r in used],
                    "samples": [[self.ts[i], remap[self.route_of[i]],
                                 [None if math.isnan(v) else round(v, 3) for v in self.rtts[i]]]
                                for i in range(lo, hi)]}

    def load_document(self, doc):
        with self.lock:
            self.routes = [list(r) for r in doc["routes"]]
            self.route_times = list(doc.get("route_times") or [0] * len(self.routes))
            self.ts, self.route_of, self.rtts = array("d"), array("i"), []
            for t, r, vals in doc["samples"]:
                self.ts.append(t)
                self.route_of.append(r)
                self.rtts.append(array("f", [NAN if v is None else v for v in vals]))
            self.ip = doc.get("ip")
            self._cur_route = self.routes[-1] if self.routes else []
            with _dns_lock:
                for ip, nm in (doc.get("names") or {}).items():
                    if nm and not _dns_cache.get(ip):
                        _dns_cache[ip] = nm
