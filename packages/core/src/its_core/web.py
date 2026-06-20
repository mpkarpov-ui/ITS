"""HTTP server: serves the frontend SPA, the platform API, and the bus WS bridge."""

from __future__ import annotations

import importlib.metadata
import json
import os
import threading
import time
from pathlib import Path
from typing import Any

import nats
import psutil
import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, RedirectResponse

from its_core.log import get_logger
from its_core.plugins import PluginManifest

log = get_logger("http")


def build_app(
    plugins: list[PluginManifest],
    frontend_dist: Path,
    vite_url: str | None = None,
    readonly: bool = False,
    nats_url: str = "nats://127.0.0.1:4222",
    kv_nats_url: str | None = None,
) -> FastAPI:
    """Construct the FastAPI app: plugin registry, WS bridge, and SPA routes.

    With `vite_url` set, SPA routes redirect to the Vite dev server instead of
    serving static dist/ (used by `its start --dev` for HMR).

    With `readonly` True (used by `its repeater`), the WS bridge rejects any
    write frame (publish, request, kv_set); reads still work, and /_meta exposes
    `readonly` so the frontend can hide write affordances.

    `nats_url` carries pub/sub. `kv_nats_url`, when set, is a separate connection
    used only for JetStream KV: the repeater points it at the upstream server
    because KV doesn't propagate over a vanilla leaf node. When omitted, KV
    shares the stream connection.
    """
    app = FastAPI(title="ITS Platform", docs_url="/api/docs", redoc_url=None)
    started_at_ms = int(time.time() * 1000)
    proc = psutil.Process(os.getpid())

    # 1s measurement window per sample (interval=None is too noisy for short
    # polls), 5-sample rolling average so /_stats doesn't jump 0% -> 50%.
    _cpu_samples: list[float] = []
    _cpu_lock = threading.Lock()

    def _cpu_sampler() -> None:
        while True:
            try:
                pct = proc.cpu_percent(interval=1.0)
            except Exception:
                pct = 0.0
            with _cpu_lock:
                _cpu_samples.append(pct)
                if len(_cpu_samples) > 5:
                    _cpu_samples.pop(0)

    threading.Thread(target=_cpu_sampler, daemon=True, name="cpu-sampler").start()

    @app.get("/_meta")
    def meta() -> dict:
        """Static platform metadata, fetched once. Dynamic metrics are /_stats."""
        try:
            version = importlib.metadata.version("its-platform")
        except importlib.metadata.PackageNotFoundError:
            version = "0.0.0+dev"
        return {
            "version": version,
            "started_at_ms": started_at_ms,
            "plugin_count": len(plugins),
            "readonly": readonly,
        }

    @app.get("/_stats")
    def stats() -> dict:
        """Dynamic runtime metrics, polled by the dashboard on a 2s cadence."""
        try:
            mem_mb = proc.memory_info().rss / (1024 * 1024)
        except psutil.NoSuchProcess:
            mem_mb = 0.0
        with _cpu_lock:
            cpu_pct = (
                sum(_cpu_samples) / len(_cpu_samples) if _cpu_samples else 0.0
            )
        return {
            "now_ms": int(time.time() * 1000),
            "uptime_s": int((time.time() * 1000 - started_at_ms) / 1000),
            "cpu_percent": round(cpu_pct, 1),
            "mem_mb": round(mem_mb, 1),
        }

    @app.get("/_plugins")
    def list_plugins() -> list[dict]:
        return [
            {
                "id": m.id,
                "version": m.version,
                "description": m.description,
                # null for UI-only plugins; the Fleet UI filters on it to list
                # what can run as a remote intake.
                "runtime_kind": m.runtime_kind,
                "publishes": [
                    {"stream": p.stream, "path": p.path} for p in m.publishes
                ],
                "cache": [{"subject": c.subject} for c in m.cache],
                "ui": None
                if m.ui_entry is None
                else {
                    "entry": m.ui_entry,
                    "icon": m.ui_icon,
                    "priority": m.ui_priority,
                    "mounts": [
                        {
                            "target": x.target,
                            "component": x.component,
                            "route": x.route,
                            "title": x.title,
                        }
                        for x in m.ui_mounts
                    ],
                },
            }
            for m in plugins
        ]

    @app.get("/api/_health")
    def health() -> dict:
        return {"ok": True}

    @app.websocket("/ws/bus")
    async def bus_ws(websocket: WebSocket) -> None:
        """Browser-side bridge to NATS.

        Client protocol (JSON frames):
          { "action": "subscribe",       "subject": "its.foo.bar.tick" }
          { "action": "unsubscribe",     "subject": "its.foo.bar.tick" }
          { "action": "publish",         "subject": "its.cmd.foo.bar", "payload": {...} }
          { "action": "request",         "id": "<uuid>", "subject": "its.cmd.foo.bar.verb",
                                         "payload": {...}, "timeout_s": 5 }
          { "action": "kv_get",          "id": "<uuid>", "key": "plugin.name" }
          { "action": "kv_set",          "key": "plugin.name", "value": {...} }
          { "action": "kv_watch_start",  "key": "plugin.name" }
          { "action": "kv_watch_stop",   "key": "plugin.name" }
        Server pushes (JSON frames):
          stream:        { "subscription": "<pattern>", "subject": "<concrete>", "payload": ... }
          request reply: { "request_id": "<uuid>", "reply": {...} }
          request error: { "request_id": "<uuid>", "error": "<message>" }
          kv get reply:  { "kv_id": "<uuid>", "value": {...} | null }
          kv update:     { "kv_key": "plugin.name", "value": {...} | null }

        One nats-py client per WS connection.
        """
        import asyncio as _asyncio

        from nats.js.errors import KeyNotFoundError

        await websocket.accept()
        # Stream-side connection (subscribe/publish/request). In a repeater this
        # is the local leaf node; otherwise the same NATS as everything else.
        # Bounded connect_timeout so a dead NATS fails fast instead of looping
        # reconnects.
        try:
            nc = await nats.connect(
                nats_url, allow_reconnect=False, connect_timeout=2
            )
        except Exception as exc:
            log.warn(f"WS bridge: NATS connect failed at {nats_url}: {exc!r}")
            await websocket.close(code=1011)
            return
        # KV-side connection, same as stream unless kv_nats_url is given (the
        # repeater points it upstream because leaf nodes don't propagate
        # JetStream). On failure, fall back to the stream connection so
        # telemetry keeps flowing even though KV ops will then fail.
        if kv_nats_url is not None and kv_nats_url != nats_url:
            try:
                nc_kv = await nats.connect(
                    kv_nats_url, allow_reconnect=False, connect_timeout=2
                )
            except Exception as exc:
                log.warn(
                    f"WS bridge: KV NATS connect failed at {kv_nats_url}: {exc!r}; "
                    "falling back to stream connection (KV ops will not work)"
                )
                nc_kv = nc
        else:
            nc_kv = nc
        js = nc_kv.jetstream()
        subs: dict[str, Any] = {}
        pending: dict[str, _asyncio.Task[None]] = {}
        kv_watchers: dict[str, _asyncio.Task[None]] = {}
        # Resolved lazily on first KV use so a frontend that never touches
        # globals skips the bucket-creation round trip.
        kv_bucket = {"kv": None}

        async def _ensure_kv() -> Any:
            if kv_bucket["kv"] is None:
                try:
                    kv_bucket["kv"] = await js.create_key_value(bucket="its-globals", history=1)
                except Exception:
                    kv_bucket["kv"] = await js.key_value(bucket="its-globals")
            return kv_bucket["kv"]

        def make_forwarder(pattern: str):
            """Per-subscription callback that tags each message with the pattern
            it matched, so the frontend (whose subscribers map is keyed by
            pattern) can route wildcard deliveries to the right handler.
            """
            async def forward(msg) -> None:
                try:
                    payload = json.loads(msg.data.decode())
                except (UnicodeDecodeError, json.JSONDecodeError):
                    payload = msg.data.decode(errors="replace")
                await websocket.send_json({
                    "subscription": pattern,
                    "subject": msg.subject,
                    "payload": payload,
                })
            return forward

        async def _do_request(req_id: str, subject: str, payload: Any, timeout_s: float) -> None:
            """Run one nc.request in its own task (so several can be in flight
            without blocking subscribe traffic) and ship the reply back."""
            data = json.dumps(payload).encode("utf-8") if payload is not None else b""
            try:
                reply = await nc.request(subject, data, timeout=timeout_s)
                try:
                    parsed = json.loads(reply.data.decode())
                except (UnicodeDecodeError, json.JSONDecodeError):
                    parsed = reply.data.decode(errors="replace")
                await websocket.send_json({"request_id": req_id, "reply": parsed})
            except Exception as exc:
                await websocket.send_json({
                    "request_id": req_id,
                    "error": f"{type(exc).__name__}: {exc}",
                })
            finally:
                pending.pop(req_id, None)

        async def _do_kv_get(kv_id: str, key: str) -> None:
            try:
                kv = await _ensure_kv()
                try:
                    entry = await kv.get(key)
                    value = json.loads(entry.value.decode())
                except KeyNotFoundError:
                    value = None
                await websocket.send_json({"kv_id": kv_id, "value": value})
            except Exception as exc:
                await websocket.send_json({
                    "kv_id": kv_id,
                    "error": f"{type(exc).__name__}: {exc}",
                })

        async def _do_kv_set(key: str, value: Any) -> None:
            try:
                kv = await _ensure_kv()
                await kv.put(key, json.dumps(value).encode("utf-8"))
            except Exception as exc:
                # No reply channel for fire-and-forget sets; log so devs notice.
                log.warn(f"kv_set {key!r} failed: {exc!r}")

        async def _kv_watch_loop(key: str) -> None:
            """Forward every update on `key` to the WS.

            nats-py's watch replays history (history=1, so at most one Entry)
            then yields a None sentinel marking "init done, live updates follow":
            [Entry?, None, Entry...]. Forward Entries unconditionally. Only relay
            the None as a null value when no real value has gone out yet (the
            key-is-unset case that unblocks ready=false); otherwise dropping it
            avoids clobbering the UI back to null after a page load.

            Iterate the KeyWatcher directly; its `.updates()` is a single-entry
            coroutine, not an async iterator.
            """
            try:
                kv = await _ensure_kv()
                watcher = await kv.watch(key)
                sent_value = False
                try:
                    async for entry in watcher:
                        if entry is None:
                            # Init-done marker; relay as null only if no real
                            # value has gone out yet.
                            if not sent_value:
                                await websocket.send_json({"kv_key": key, "value": None})
                                sent_value = True
                            continue
                        try:
                            value = json.loads(entry.value.decode())
                        except (UnicodeDecodeError, json.JSONDecodeError):
                            value = None
                        await websocket.send_json({"kv_key": key, "value": value})
                        sent_value = True
                finally:
                    await watcher.stop()
            except _asyncio.CancelledError:
                pass
            except Exception as exc:
                log.warn(f"kv_watch {key!r} ended: {exc!r}")

        # Write actions, rejected in readonly mode so spectator hosts can't
        # publish or set KV from the browser. Reads still work.
        write_actions = {"publish", "request", "kv_set"}

        async def _send_readonly_error(action: str) -> None:
            req_id = msg.get("id") or ""
            err = f"action {action!r} rejected: this is a read-only repeater"
            if action == "request" and req_id:
                await websocket.send_json({"request_id": req_id, "error": err})
            elif action == "kv_get" and req_id:
                await websocket.send_json({"kv_id": req_id, "error": err})
            # publish + kv_set have no reply channel; silently drop.

        try:
            while True:
                msg = await websocket.receive_json()
                action = msg.get("action")
                subject = msg.get("subject")
                if readonly and action in write_actions:
                    await _send_readonly_error(action)
                    continue
                if action == "subscribe" and subject and subject not in subs:
                    subs[subject] = await nc.subscribe(subject, cb=make_forwarder(subject))
                elif action == "unsubscribe" and subject in subs:
                    await subs.pop(subject).unsubscribe()
                elif action == "publish" and subject:
                    payload = msg.get("payload")
                    data = json.dumps(payload).encode("utf-8") if payload is not None else b""
                    await nc.publish(subject, data)
                elif action == "request" and subject:
                    req_id = msg.get("id") or ""
                    timeout_s = float(msg.get("timeout_s") or 5)
                    task = _asyncio.create_task(
                        _do_request(req_id, subject, msg.get("payload"), timeout_s)
                    )
                    pending[req_id] = task
                elif action == "kv_get":
                    key = msg.get("key")
                    kv_id = msg.get("id") or ""
                    if key:
                        _asyncio.create_task(_do_kv_get(kv_id, key))
                elif action == "kv_set":
                    key = msg.get("key")
                    if key:
                        _asyncio.create_task(_do_kv_set(key, msg.get("value")))
                elif action == "kv_watch_start":
                    key = msg.get("key")
                    if key and key not in kv_watchers:
                        kv_watchers[key] = _asyncio.create_task(_kv_watch_loop(key))
                elif action == "kv_watch_stop":
                    key = msg.get("key")
                    if key and key in kv_watchers:
                        kv_watchers.pop(key).cancel()
        except WebSocketDisconnect:
            pass
        finally:
            for task in pending.values():
                task.cancel()
            for watcher in kv_watchers.values():
                watcher.cancel()
            for sub in subs.values():
                try:
                    await sub.unsubscribe()
                except Exception:
                    pass
            try:
                await nc.drain()
            except Exception:
                pass
            if nc_kv is not nc:
                try:
                    await nc_kv.drain()
                except Exception:
                    pass

    if vite_url is not None:
        # Dev mode: redirect SPA traffic to Vite. Catch-all, but the API routes
        # above take precedence since they register first.
        from urllib.parse import urlsplit

        # Redirect to the request's own host (not localhost) so a LAN client is
        # sent to Vite on the server, not its own machine.
        vite_port = urlsplit(vite_url).port

        @app.get("/", include_in_schema=False)
        @app.get("/{path:path}", include_in_schema=False)
        def redirect_to_vite(request: Request, path: str = "") -> RedirectResponse:
            host = request.url.hostname or "localhost"
            return RedirectResponse(f"http://{host}:{vite_port}/{path}")
    elif frontend_dist.exists():
        # SPA fallback: serve a real file when one exists, else index.html so the
        # client router resolves deep links (e.g. /overlay, the OBS browser
        # source) on hard load/refresh. StaticFiles(html=True) only serves
        # index.html at the root and 404s nested routes, which breaks direct
        # loads. Registered after the WS/API routes, so those still win.
        from fastapi.responses import FileResponse

        dist_root = frontend_dist.resolve()
        index_file = dist_root / "index.html"

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str) -> FileResponse:
            candidate = (dist_root / path).resolve()
            # Real file inside dist/ -> serve it; anything else -> SPA entry.
            # The parents check blocks path-traversal escapes (../).
            if path and dist_root in candidate.parents and candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(index_file)
    else:
        @app.get("/")
        def no_frontend() -> JSONResponse:
            return JSONResponse(
                {
                    "error": "frontend not built",
                    "hint": "run `pnpm --filter @its/frontend build`",
                },
                status_code=503,
            )

    return app


def serve(app: FastAPI, port: int) -> tuple[uvicorn.Server, threading.Thread]:
    """Start uvicorn in a daemon thread. Caller drives shutdown via
    server.should_exit = True and joining the returned thread."""
    config = uvicorn.Config(
        app,
        host="0.0.0.0",
        port=port,
        log_config=None,
        access_log=False,
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    return server, thread
