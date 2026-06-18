"""`its repeater`: spectator-side relay.

Boots a local leaf-node nats-server pointed at an upstream main server, then
serves the ITS frontend with the WS bridge readonly. Many spectator WS
connections fan into one upstream leaf link; NATS interest-based routing
propagates subjects on demand.

Doesn't run or supervise plugins; discovers manifests locally so /_plugins
mirrors the operator side.
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path

import typer

from its_bus import nats
from its_core.log import enable_debug, get_logger
from its_core.plugins import discover
from its_core.web import build_app, serve


log = get_logger("repeater")
nats_log = get_logger("nats")
http_log = get_logger("http")


def repeater(
    upstream: str = typer.Argument(
        ...,
        metavar="HOST",
        help="Upstream main server (e.g. launch-box.local, 192.168.1.20, or "
        "a full nats://host:port URL). Default port 4222 / leaf 7422; "
        "override per-flag if upstream uses non-standard ports.",
    ),
    upstream_leaf_port: int = typer.Option(
        nats.DEFAULT_LEAF_PORT,
        "--upstream-leaf-port",
        help=f"Upstream's leaf-node listener port. Default {nats.DEFAULT_LEAF_PORT}.",
    ),
    port: int = typer.Option(
        8081,
        "--port",
        help="HTTP port to serve the spectator frontend on. Default 8081 so "
        "you can run a repeater alongside `its dev` (which uses port 80).",
    ),
    nats_port: int = typer.Option(
        4223,
        "--nats-port",
        help="Local NATS client port (the WS bridge connects here). Default 4223 so "
        "you can run a repeater on the same machine as `its dev` without colliding.",
    ),
    debug: bool = typer.Option(False, "--debug", help="Enable debug logging."),
) -> None:
    """Run a spectator-side relay: local leaf-node NATS + read-only HTTP host.
    One per location; chainable (point another repeater at this one).

    Holds two upstream connections: a leaf-node link for pub-sub propagation, and
    a direct client link for KV ops (JetStream-backed globals don't flow through
    a vanilla leaf node).
    """
    if debug:
        enable_debug()

    # Normalize the upstream URL (scheme + port). Rewrite `localhost` to
    # 127.0.0.1: nats-py + Windows dual-stack can hang probing IPv6 first.
    if "://" in upstream:
        scheme, _, hostport = upstream.partition("://")
    else:
        scheme, hostport = "nats", upstream
    if ":" in hostport:
        host, _, port_str = hostport.partition(":")
        client_port = int(port_str)
    else:
        host = hostport
        client_port = 4222
    if host in ("localhost", "::1"):
        host = "127.0.0.1"
    upstream_client = f"{scheme}://{host}:{client_port}"
    upstream_leaf = f"{scheme}://{host}:{upstream_leaf_port}"
    log.info(f"upstream client: {upstream_client} | upstream leaf: {upstream_leaf}")

    binary = nats.locate()
    if binary is None:
        log.info(f"nats-server not found on PATH or in {nats.BIN_DIR}")
        ok = typer.confirm(
            f"Download nats-server v{nats.DEFAULT_NATS_VERSION} to {nats.BIN_DIR}?",
            default=False,
        )
        if not ok:
            log.info(
                "install nats-server manually from "
                "https://github.com/nats-io/nats-server/releases and re-run"
            )
            raise typer.Exit(code=1)
        try:
            log.info(f"downloading nats-server v{nats.DEFAULT_NATS_VERSION}...")
            binary = nats.install()
            log.info(f"installed: {binary}")
        except Exception as exc:
            log.error(f"install failed: {exc}")
            raise typer.Exit(code=1) from exc

    log.info(f"starting leaf-node NATS on 127.0.0.1:{nats_port}")
    nats_proc = nats.spawn_leaf(binary, port=nats_port, upstream_url=upstream_leaf)

    def relay_nats() -> None:
        assert nats_proc.stdout is not None
        for line in nats_proc.stdout:
            stripped = line.rstrip()
            if stripped:
                nats_log.info(stripped)

    threading.Thread(target=relay_nats, daemon=True).start()

    # A leaf node exits when upstream sends `Server Shutdown` (e.g. Ctrl+C on
    # `its dev`), which we can't suppress. Exit the repeater cleanly rather than
    # let the WS bridge thrash reconnecting to dead local NATS.
    def watch_nats() -> None:
        rc = nats_proc.wait()
        log.error(
            f"local NATS exited (rc={rc}) - upstream likely went down. "
            f"Restart the repeater after upstream is back up."
        )
        os._exit(1)

    threading.Thread(target=watch_nats, daemon=True).start()

    # Let the leaf establish the upstream link before the bridge subscribes.
    time.sleep(1.0)

    # Discover locally so /_plugins matches the operator side (mirrored checkout).
    manifests = discover(Path("plugins"))
    log.info(
        f"serving {len(manifests)} plugin manifest(s): "
        f"{[m.id for m in manifests] or '[]'}"
    )

    # Readonly HTTP server. The bridge subscribes/publishes over the local leaf
    # and routes KV ops to the upstream client (see two-connection note above).
    # The readonly check rejects writes on either connection.
    frontend_dist = Path("frontend/dist")
    app = build_app(
        manifests,
        frontend_dist,
        vite_url=None,
        readonly=True,
        nats_url=f"nats://127.0.0.1:{nats_port}",
        kv_nats_url=upstream_client,
    )

    http_server, http_thread = serve(app, port=port)
    http_log.info(
        f"spectator frontend on http://127.0.0.1:{port} (readonly bridge)"
    )

    # Block until Ctrl-C; clean up nats subprocess on the way out.
    try:
        http_thread.join()
    except KeyboardInterrupt:
        log.info("shutting down repeater...")
    finally:
        try:
            http_server.should_exit = True
        except Exception:
            pass
        nats_proc.terminate()
        try:
            nats_proc.wait(timeout=10)
        except Exception:
            nats_proc.kill()
