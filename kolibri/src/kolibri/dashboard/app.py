"""Dashboard API. Every /api route needs `Authorization: Bearer $DASHBOARD_TOKEN`; without the env
var the API is disabled entirely. Bind to 127.0.0.1 / VPN only (config.dashboard.host)."""

from __future__ import annotations

import hmac
import os
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import HTMLResponse

from kolibri.auditor.progress import build_progress
from kolibri.core.config import Config

INDEX = (Path(__file__).parent / "index.html").read_text()


def create_app(rt: Any, cfg: Config | None = None) -> FastAPI:
    """`rt` is the running desk; None serves only the progress view (`kolibri dashboard`)."""
    app = FastAPI(title="KOLIBRI", docs_url=None, redoc_url=None, openapi_url=None)
    config = cfg if cfg is not None else rt.cfg

    def desk() -> Any:
        if rt is None:
            raise HTTPException(409, "desk not running (progress-only dashboard)")
        return rt

    def auth(authorization: str = Header(default="")) -> None:
        token = os.environ.get("DASHBOARD_TOKEN", "")
        if len(token) < 16:
            raise HTTPException(503, "DASHBOARD_TOKEN (>=16 chars) not configured; API disabled")
        if not hmac.compare_digest(authorization.encode(), f"Bearer {token}".encode()):
            raise HTTPException(401, "unauthorized")

    @app.get("/", response_class=HTMLResponse)
    def index() -> str:
        return INDEX

    # every handler is async: it runs on the event-loop thread that owns the SQLite journal
    @app.get("/api/state", dependencies=[Depends(auth)])
    async def state() -> dict[str, Any]:
        snap: dict[str, Any] = desk().snapshot()
        return snap

    @app.get("/api/progress", dependencies=[Depends(auth)])
    async def progress() -> dict[str, Any]:
        return build_progress(config) | {"desk_running": rt is not None}

    @app.post("/api/kill", dependencies=[Depends(auth)])
    async def kill() -> dict[str, str]:
        await desk().kill("manual KILL from dashboard")
        return {"ok": "flattened + halted (manual re-arm required)"}

    @app.post("/api/flatten", dependencies=[Depends(auth)])
    async def flatten() -> dict[str, str]:
        await desk().flatten("manual flatten")
        return {"ok": "flatten sent"}

    @app.post("/api/rearm", dependencies=[Depends(auth)])
    async def rearm() -> dict[str, str]:
        await desk().rearm()
        return {"ok": "re-armed"}

    @app.post("/api/ack", dependencies=[Depends(auth)])
    async def ack() -> dict[str, int]:
        return {"acked": desk().alerts.ack()}

    return app
