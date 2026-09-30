"""Alerts: journal events -> severity-tagged messages -> Telegram (or log when no token).

- INFO / WARN / CRITICAL; CRITICAL repeats every `critical_repeat_s` until acknowledged
  (/ack in Telegram or the dashboard button).
- Rate limit `max_per_min` for INFO/WARN plus 60 s de-duplication; CRITICAL is never dropped.
- The bot token is read from env and never logged (errors are reported by type only)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import urllib.parse
import urllib.request
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from kolibri.core.config import Config
from kolibri.core.models import DeskEvent

log = logging.getLogger(__name__)
Sender = Callable[[str], Awaitable[None]]


@dataclass(slots=True)
class Alert:
    severity: str
    text: str
    ts: float


SETUP_NL = {"A_pullback": "Trend-terugval", "B_meanrev": "Terug naar gemiddelde", "C_breakout": "Uitbraak",
            "D_sweep": "Stop-jacht omkering", "orphan": "Onbekende positie"}
EXIT_NL = {"stop": "stop-loss geraakt", "trail": "meeschuivende stop", "tp1": "winstdoel", "tp2": "eindwinstdoel",
           "time_stop": "tijdslimiet (10 min)", "exit": "handmatig gesloten", "orphan": "onbekende positie gesloten"}


def format_event(ev: DeskEvent, cfg: Config) -> Alert | None:
    d, now = ev.data, time.time()
    if ev.kind == "position_open":
        side = "long (koop)" if d["direction"] == "long" else "short"
        return Alert("INFO", f"🟢 Positie geopend {ev.symbol} {side} · {SETUP_NL.get(d['setup'], d['setup'])}", now)
    if ev.kind == "trade":
        t = d["trade"]
        r = float(t["r"])
        why = EXIT_NL.get(str(t["exit_reason"]), str(t["exit_reason"]))
        return Alert("INFO", f"{'✅' if r > 0 else '🔻'} Positie gesloten {ev.symbol} · {why} · {r:+.2f}R "
                             f"({float(t['pnl']):+.2f} USDT)", now)
    if ev.kind == "kill":
        return Alert("CRITICAL", f"🛑 NOODSTOP: {d['reason']} — alles gesloten, handel gestopt"
                                 f"{'; handmatig hervatten nodig' if d.get('manual_rearm') else ''}", now)
    if ev.kind == "risk":
        return Alert("WARN", f"⚠️ Risico-melding {ev.symbol} {d.get('event')}", now)
    if ev.kind == "order_reject":
        return Alert("WARN", f"⚠️ Order geweigerd door beurs {ev.symbol} ({d['purpose']}): {d['reason']}", now) \
            if d["reason"] != "post_only_would_take" else None
    if ev.kind == "rejection" and cfg.alerts.send_rejected_high_score:
        sc = d.get("score")
        if sc is not None and sc >= cfg.alerts.rejected_score_alert:
            text = f"· Sterk signaal afgewezen {ev.symbol} {d['setup']} (score {sc:.0f}) door {d['gate']}"
            return Alert("INFO", text, now)
    if ev.kind == "alert":
        return Alert(str(d.get("severity", "INFO")), str(d["text"]), now)
    return None


def telegram_sender(token: str, chat_id: str) -> Sender:
    url = f"https://api.telegram.org/bot{token}/sendMessage"

    def _post(text: str) -> None:
        body = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode()
        with urllib.request.urlopen(url, body, timeout=10) as r:
            r.read()

    async def send(text: str) -> None:
        try:
            await asyncio.to_thread(_post, text)
        except Exception as e:  # never let the token leak via an exception string
            log.warning("telegram send failed: %s", type(e).__name__)

    return send


class AlertManager:
    def __init__(self, cfg: Config, sender: Sender | None = None) -> None:
        self.cfg = cfg
        token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
        self.token, self.chat = token, chat
        self.send: Sender = sender or (telegram_sender(token, chat) if token and chat else self._log_only)
        self.queue: deque[Alert] = deque(maxlen=1000)
        self.unacked: dict[str, Alert] = {}
        self.recent: deque[Alert] = deque(maxlen=200)  # for the dashboard
        self._sent: deque[float] = deque()
        self._last_text: dict[str, float] = {}
        self._last_repeat = 0.0

    @staticmethod
    async def _log_only(text: str) -> None:
        log.info("ALERT %s", text)

    def on_event(self, ev: DeskEvent) -> None:
        a = format_event(ev, self.cfg)
        if a is not None:
            self.push(a)

    def push(self, a: Alert) -> None:
        self.queue.append(a)
        self.recent.append(a)
        if a.severity == "CRITICAL":
            self.unacked[a.text] = a

    def ack(self) -> int:
        n = len(self.unacked)
        self.unacked.clear()
        return n

    async def flush(self, now: float | None = None) -> None:
        now = time.time() if now is None else now
        while self._sent and now - self._sent[0] > 60:
            self._sent.popleft()
        while self.queue:
            a = self.queue.popleft()
            if a.severity != "CRITICAL":
                if now - self._last_text.get(a.text, -1e9) < 60 or len(self._sent) >= self.cfg.alerts.max_per_min:
                    continue  # dedupe / rate limit
            self._last_text[a.text] = now
            self._sent.append(now)
            await self.send(f"[{a.severity}] {a.text}")
        if self.unacked and now - self._last_repeat >= self.cfg.alerts.critical_repeat_s:
            self._last_repeat = now
            for a in self.unacked.values():
                await self.send(f"[KRITIEK][nog niet bevestigd, stuur /ack] {a.text}")

    async def poll_ack(self) -> None:
        """Watch Telegram for /ack from the configured chat. Runs forever."""
        if not (self.token and self.chat):
            return
        offset = 0
        url = f"https://api.telegram.org/bot{self.token}/getUpdates"

        def _get(off: int) -> list[dict[str, object]]:
            with urllib.request.urlopen(f"{url}?timeout=25&offset={off}", timeout=35) as r:  # noqa: S310
                return list(json.load(r).get("result", []))

        while True:
            try:
                for upd in await asyncio.to_thread(_get, offset):
                    offset = int(str(upd["update_id"])) + 1
                    msg = upd.get("message") or {}
                    assert isinstance(msg, dict)
                    chat = msg.get("chat") or {}
                    assert isinstance(chat, dict)
                    if str(chat.get("id")) == self.chat and str(msg.get("text", "")).strip() == "/ack":
                        n = self.ack()
                        await self.send(f"{n} kritieke melding(en) bevestigd")
            except Exception as e:
                log.warning("telegram poll failed: %s", type(e).__name__)
                await asyncio.sleep(5)
