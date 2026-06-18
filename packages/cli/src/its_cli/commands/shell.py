"""`its shell <host>`: short alias for `its connect its-shell <host>`. The
its-shell plugin owns the behavior; this resolves a station-name default and
delegates.
"""

import getpass
import socket
import sys
from pathlib import Path
from urllib.parse import urlparse

import typer

from its_core.log import get_logger
from its_core.plugins import discover
from its_core.supervisor import build_plugin_env, resolve_instance_key

log = get_logger("its-shell")


def _default_station_name() -> str:
    return f"{getpass.getuser()}@{socket.gethostname()}"


def shell(
    host: str = typer.Argument(
        ...,
        metavar="HOST",
        help=(
            "Where the ITS server's NATS is reachable. Same shapes as "
            "`its connect`: bare host, host:port, or full nats:// URL."
        ),
    ),
    name: str = typer.Option(
        None,
        "--name",
        help="Station identifier (default: <user>@<hostname>).",
    ),
    install_service: bool = typer.Option(
        False,
        "--install-service",
        help="Not yet implemented; planned for writing systemd/NSSM/launchd units.",
    ),
    allow_exec: bool = typer.Option(
        False,
        "--allow-exec",
        help="Enable the remote `exec` verb on this station (off by default).",
    ),
) -> None:
    """Run as a managed station (long-running daemon) against an ITS server."""
    if install_service:
        log.error("--install-service is not implemented yet; run the shell in foreground for now")
        raise typer.Exit(code=1)

    raw_name = name if name is not None else _default_station_name()
    config = {"name": raw_name, "allow_exec": allow_exec}
    server_url = _resolve_nats_url(host)

    plugins_dir = Path("plugins")
    manifests = {m.id: m for m in discover(plugins_dir)}
    if "its-shell" not in manifests:
        log.error("its-shell plugin not found in plugins/its-shell/; is this a workspace checkout?")
        raise typer.Exit(code=1)

    # Sanitize so `@` and other NATS-reserved chars become `_`. The Config sees
    # the raw name; the bus subject + lock key see the sanitized version.
    instance_key = resolve_instance_key(config, ("name",))
    log.info(f"booting shell '{raw_name}' (instance_key={instance_key!r}) against {server_url}")
    env = build_plugin_env(instance_key, config, nats_url=server_url)

    import subprocess
    import threading

    plugin_log = get_logger("plugin:shell")
    proc = subprocess.Popen(
        [sys.executable, str(manifests["its-shell"].entry_path)],
        cwd=manifests["its-shell"].plugin_dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    def relay() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            stripped = line.rstrip()
            if stripped:
                plugin_log.info(stripped)

    threading.Thread(target=relay, daemon=True).start()
    try:
        rc = proc.wait()
    except KeyboardInterrupt:
        log.info("shutting down shell...")
        proc.terminate()
        try:
            rc = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            log.warn("shell did not exit in 10s; killing")
            proc.kill()
            rc = proc.wait()
    raise typer.Exit(code=rc)


def _resolve_nats_url(host: str) -> str:
    """Same expansion as `its connect`; duplicated to keep the two commands
    independent."""
    if "://" in host:
        return host
    h, _, p = host.partition(":")
    if h == "localhost":
        h = "127.0.0.1"
    port = p or "4222"
    return f"nats://{h}:{port}"
