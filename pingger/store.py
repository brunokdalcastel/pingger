"""Persistência em SQLite: sessões, rotas, amostras, configurações, alertas e eventos."""
import json
import math
import sqlite3
import threading
import time
from array import array

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, host TEXT, name TEXT, settings TEXT,
    created REAL, last REAL, open INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS routes (session TEXT, idx INTEGER, ts REAL, ips TEXT, PRIMARY KEY(session, idx));
CREATE TABLE IF NOT EXISTS samples (session TEXT, ts REAL, route INTEGER, rtts BLOB);
CREATE INDEX IF NOT EXISTS samples_by_session ON samples(session, ts);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, kind TEXT,
    session TEXT, alert TEXT, message TEXT);
"""


class Store:
    def __init__(self, path):
        self.path = path
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.executescript(SCHEMA)
        self.lock = threading.Lock()

    # ---- chave/valor (settings, alertas, summaries, workspaces)
    def get(self, k, default=None):
        with self.lock:
            row = self.db.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
        return json.loads(row[0]) if row else default

    def put(self, k, v):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO kv VALUES (?,?)", (k, json.dumps(v)))

    # ---- sessões
    def save_session(self, s, open_=True):
        with self.lock:
            self.db.execute("INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?,?,?)",
                            (s.id, s.host, s.name, json.dumps(s.settings), s.created,
                             s.ts[-1] if len(s.ts) else s.created, 1 if open_ else 0))

    def set_open(self, sid, open_):
        with self.lock:
            self.db.execute("UPDATE sessions SET open=? WHERE id=?", (1 if open_ else 0, sid))

    def list_sessions(self):
        with self.lock:
            rows = self.db.execute("SELECT s.id, s.host, s.name, s.settings, s.created, s.last, s.open, "
                                   "(SELECT COUNT(*) FROM samples WHERE session=s.id) FROM sessions s "
                                   "ORDER BY s.last DESC").fetchall()
        return [{"id": r[0], "host": r[1], "name": r[2], "settings": json.loads(r[3]), "created": r[4],
                 "last": r[5], "open": bool(r[6]), "samples": r[7]} for r in rows]

    def delete_session(self, sid):
        with self.lock:
            self.db.execute("DELETE FROM sessions WHERE id=?", (sid,))
            self.db.execute("DELETE FROM routes WHERE session=?", (sid,))
            self.db.execute("DELETE FROM samples WHERE session=?", (sid,))

    def delete_samples(self, sid):
        with self.lock:
            self.db.execute("DELETE FROM routes WHERE session=?", (sid,))
            self.db.execute("DELETE FROM samples WHERE session=?", (sid,))

    def flush(self, s):
        pending = s.take_pending()
        if not pending:
            return
        with self.lock:
            self.db.execute("BEGIN")
            for t, ridx, route, vals in pending:
                if route is not None:
                    self.db.execute("INSERT OR REPLACE INTO routes VALUES (?,?,?,?)",
                                    (s.id, ridx, t, json.dumps(route)))
                self.db.execute("INSERT INTO samples VALUES (?,?,?,?)",
                                (s.id, t, ridx, array("f", vals).tobytes()))
            self.db.execute("UPDATE sessions SET last=? WHERE id=?", (pending[-1][0], s.id))
            self.db.execute("COMMIT")

    def load_into(self, s, since=None):
        with self.lock:
            routes = self.db.execute("SELECT idx, ts, ips FROM routes WHERE session=? ORDER BY idx",
                                     (s.id,)).fetchall()
            q = "SELECT ts, route, rtts FROM samples WHERE session=?" + (" AND ts>=?" if since else "") + " ORDER BY ts"
            rows = self.db.execute(q, (s.id, since) if since else (s.id,)).fetchall()
        doc_routes, doc_times = [], []
        by_idx = {r[0]: (r[1], json.loads(r[2])) for r in routes}
        last = []
        for i in range(max(by_idx) + 1 if by_idx else 0):
            t, ips = by_idx.get(i, (0, last))
            doc_routes.append(ips)
            doc_times.append(t)
            last = ips
        samples = []
        for t, r, blob in rows:
            vals = array("f")
            vals.frombytes(blob)
            samples.append([t, min(r, max(0, len(doc_routes) - 1)), [None if math.isnan(v) else v for v in vals]])
        s.load_document({"routes": doc_routes or [[]], "route_times": doc_times or [0], "samples": samples})

    def purge_older_than(self, days):
        if not days:
            return
        with self.lock:
            self.db.execute("DELETE FROM samples WHERE ts < ?", (time.time() - days * 86400,))

    # ---- eventos (log de alertas, mudanças de rota)
    def event(self, kind, session, alert, message):
        with self.lock:
            self.db.execute("INSERT INTO events (ts, kind, session, alert, message) VALUES (?,?,?,?,?)",
                            (time.time(), kind, session, alert, message))

    def events(self, limit=500):
        with self.lock:
            rows = self.db.execute("SELECT ts, kind, session, alert, message FROM events ORDER BY id DESC LIMIT ?",
                                   (limit,)).fetchall()
        return [{"ts": r[0], "kind": r[1], "session": r[2], "alert": r[3], "message": r[4]} for r in rows]

    def clear_events(self):
        with self.lock:
            self.db.execute("DELETE FROM events")
