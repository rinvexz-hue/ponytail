"""TradingView webhook: an alert from an indicator (e.g. a protected script) becomes a KOLIBRI signal
that goes through the same gates, risk limits and execution as the built-in setups.

Exposure: the app listens inside the Docker network only. The internet reaches it solely through
the Caddy service (TLS on 443, only TradingView's four webhook IPs, only POST /tv). TradingView
cannot send headers, so the shared secret travels in the JSON body; compared in constant time."""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from kolibri.core.config import Config

log = logging.getLogger(__name__)
TV_IPS = ("52.89.214.238", "34.212.75.30", "54.218.53.128", "52.32.178.7")  # also in deploy/Caddyfile


def parse_signal(body: dict[str, Any], cfg: Config) -> tuple[str, str, Decimal | None, Decimal | None]:
    """{"symbol": "{{ticker}}", "side": "buy"|"sell", "sl": optional, "tp": optional} -> validated values."""
    raw = str(body.get("symbol", "")).upper().split(":")[-1].replace("/", "").replace("XBT", "BTC")
    if raw not in cfg.symbols:
        raise ValueError(f"symbol {raw!r} is not traded (allowed: {', '.join(cfg.symbols)})")
    side = str(body.get("side", "")).lower()
    if side not in ("buy", "sell"):
        raise ValueError("side must be 'buy' or 'sell'")

    def price(key: str) -> Decimal | None:
        v = body.get(key)
        if v in (None, ""):
            return None
        try:
            d = Decimal(str(v))
        except InvalidOperation:
            raise ValueError(f"{key} is not a number") from None
        if not d.is_finite() or d <= 0:
            raise ValueError(f"{key} must be a positive number")
        return d

    return raw, side, price("sl"), price("tp")


def create_webhook_app(rt: Any) -> FastAPI:
    app = FastAPI(title="KOLIBRI webhook", docs_url=None, redoc_url=None, openapi_url=None)
    pending: set[asyncio.Task[None]] = set()

    @app.post("/tv")
    async def tv(request: Request) -> JSONResponse:
        secret = os.environ.get("TV_WEBHOOK_SECRET", "")
        if len(secret) < 16:
            raise HTTPException(503, "TV_WEBHOOK_SECRET (>=16 chars) not configured")
        try:
            body = json.loads(await request.body())
        except ValueError:
            raise HTTPException(400, "body must be JSON") from None
        if not isinstance(body, dict):
            raise HTTPException(400, "body must be a JSON object")
        if not hmac.compare_digest(str(body.get("secret", "")).encode(), secret.encode()):
            log.warning("webhook: bad secret")  # never log the body: it carries the secret
            raise HTTPException(401, "unauthorized")
        try:
            sym, side, sl, tp = parse_signal(body, rt.cfg)
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        # TradingView gives up after 3 s: acknowledge now, trade in the background (under the desk lock)
        task = asyncio.get_running_loop().create_task(rt.on_signal(sym, side, sl, tp))
        pending.add(task)
        task.add_done_callback(pending.discard)
        return JSONResponse({"accepted": True, "symbol": sym, "side": side}, status_code=202)

    return app
