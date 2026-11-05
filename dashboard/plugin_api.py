"""Reviews backend, mounted at /api/plugins/reviews. A thin FastAPI layer over reviews_core.py (stdlib only).

Reads: `GET /queue`, `GET /draft?key=`, `GET /live[?refresh=1]` (GitHub state of the open entries, cached),
`GET /chat?key=` (the PR's Claude Code review session and the command that resumes it).
Writes: `POST /status {keys, status, reason?}` (see reviews_core.apply_status) and `POST /run {scope}`,
which starts ~/review-queue/run.sh (`all`, or `co` for the codeowner review status only); `GET /run` says if one is going.
"""
from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


def _load_core():
    # Loaded by file path: the dashboard imports this module from its own location, so a sibling
    # `import reviews_core` would depend on sys.path. The name is namespaced to avoid collisions.
    name = "hermes_reviews_core"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name("reviews_core.py"))
    if spec is None or spec.loader is None:
        raise ImportError("reviews_core.py not found beside plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


core = _load_core()
router = APIRouter()


def _http(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except LookupError as e:
        raise HTTPException(404, str(e))


@router.get("/queue")
async def queue():
    return core.queue_payload()


@router.get("/draft")
async def draft(key: str):
    return _http(core.draft_payload, key)


@router.get("/live")
async def live(refresh: int = 0):
    return await asyncio.to_thread(core.live_payload, bool(refresh))


@router.get("/chat")
async def chat(key: str):
    return _http(core.chat_info, key)


class StatusBody(BaseModel):
    keys: list[str]
    status: str
    reason: str | None = None


@router.post("/status")
async def set_status(body: StatusBody):
    return {"changed": _http(core.apply_status, body.keys, body.status, body.reason)}


class RunBody(BaseModel):
    scope: str = "all"


@router.get("/run")
async def run_state():
    return core.run_status()


@router.post("/run")
async def run_now(body: RunBody):
    return _http(core.run_start, body.scope)
