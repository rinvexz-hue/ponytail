"""Event journal + in-process bus.

Every desk event (signal, rejection, order, fill, risk, alert, trade) is persisted to SQLite with
exchange ts and local ts, then fanned out to subscribers (alerts, dashboard). Subscribers must be
non-blocking; a failing subscriber is logged, never allowed to break the trading path.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from collections.abc import Callable
from dataclasses import asdict, is_dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

from kolibri.core.models import DeskEvent

log = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, local_ts INTEGER NOT NULL,
  kind TEXT NOT NULL, symbol TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_events_kind_ts ON events(kind, ts);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def to_jsonable(obj: Any) -> Any:
    if is_dataclass(obj) and not isinstance(obj, type):
        return {k: to_jsonable(v) for k, v in asdict(obj).items()}
    if isinstance(obj, dict):
        return {str(k): to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, list | tuple):
        return [to_jsonable(v) for v in obj]
    if isinstance(obj, Decimal):
        return str(obj)
    return obj


class Journal:
    def __init__(self, path: str | Path = ":memory:", commit_every: int = 1) -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), isolation_level=None)
        if str(path) != ":memory:":
            self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(_SCHEMA)
        self._subs: list[Callable[[DeskEvent], None]] = []
        self._pending: list[tuple[int, int, str, str, str]] = []
        self._commit_every = commit_every

    def subscribe(self, fn: Callable[[DeskEvent], None]) -> None:
        self._subs.append(fn)

    def emit(self, kind: str, ts: int, symbol: str = "", **data: Any) -> DeskEvent:
        ev = DeskEvent(kind=kind, ts=ts, symbol=symbol, data=to_jsonable(data))
        self._pending.append((ev.ts, int(time.time() * 1000), kind, symbol, json.dumps(ev.data)))
        if len(self._pending) >= self._commit_every:
            self.flush()
        for fn in self._subs:
            try:
                fn(ev)
            except Exception:
                log.exception("journal subscriber failed")
        return ev

    def flush(self) -> None:
        if self._pending:
            self._db.execute("BEGIN")
            self._db.executemany(
                "INSERT INTO events(ts, local_ts, kind, symbol, data) VALUES (?,?,?,?,?)", self._pending
            )
            self._db.execute("COMMIT")
            self._pending.clear()

    def query(self, kind: str, since_ts: int = 0, limit: int = 100_000) -> list[DeskEvent]:
        self.flush()
        rows = self._db.execute(
            "SELECT ts, kind, symbol, data FROM events WHERE kind=? AND ts>=? ORDER BY id LIMIT ?",
            (kind, since_ts, limit),
        ).fetchall()
        return [DeskEvent(kind=k, ts=t, symbol=s, data=json.loads(d)) for t, k, s, d in rows]

    # durable key/value state: halts, equity peak, week anchor ... survive restarts
    def get_state(self, key: str, default: Any = None) -> Any:
        row = self._db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set_state(self, key: str, value: Any) -> None:
        self._db.execute(
            "INSERT INTO state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(to_jsonable(value))),
        )

    def close(self) -> None:
        self.flush()
        self._db.close()
