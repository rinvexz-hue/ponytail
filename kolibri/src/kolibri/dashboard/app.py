"""Dashboard API. Every /api route needs `Authorization: Bearer $DASHBOARD_TOKEN`; without the env
var the API is disabled entirely. Bind to 127.0.0.1 / VPN only (config.dashboard.host)."""

from __future__ import annotations

import hmac
import os
from pathlib import Path
from typing import Any, Protocol

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import HTMLResponse

from kolibri.scout.scout import now_ms

INDEX = (Path(__file__).parent / "index.html").read_text()


class _RuntimeLike(Protocol):
    def snapshot(self) -> dict[str, Any]: ...


def create_app(rt: Any) -> FastAPI:
    app = FastAPI(title="KOLIBRI", docs_url=None, redoc_url=None, openapi_url=None)

    def auth(authorization: str = Header(default="")) -> None:
        token = os.environ.get("DASHBOARD_TOKEN", "")
        if len(token) < 16:
            raise HTTPException(503, "DASHBOARD_TOKEN (>=16 chars) not configured; API disabled")
        if not hmac.compare_digest(authorization.encode(), f"Bearer {token}".encode()):
            raise HTTPException(401, "unauthorized")

    @app.get("/", response_class=HTMLResponse)
    def index() -> str:
        return INDEX

    @app.get("/api/state", dependencies=[Depends(auth)])
    def state() -> dict[str, Any]:
        snap: dict[str, Any] = rt.snapshot()
        return snap

    @app.post("/api/kill", dependencies=[Depends(auth)])
    async def kill() -> dict[str, str]:
        await rt.desk.kill("manual KILL from dashboard", now_ms())
        return {"ok": "flattened + halted (manual re-arm required)"}

    @app.post("/api/flatten", dependencies=[Depends(auth)])
    async def flatten() -> dict[str, str]:
        await rt.desk.exe.flatten_all("manual flatten", now_ms())
        return {"ok": "flatten sent"}

    @app.post("/api/rearm", dependencies=[Depends(auth)])
    def rearm() -> dict[str, str]:
        rt.desk.risk.rearm(now_ms())
        return {"ok": "re-armed"}

    @app.post("/api/ack", dependencies=[Depends(auth)])
    def ack() -> dict[str, int]:
        return {"acked": rt.alerts.ack()}

    return app
