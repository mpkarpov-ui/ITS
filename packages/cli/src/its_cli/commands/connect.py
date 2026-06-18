"""`its connect`: run a single intake in the foreground against a remote ITS server.

Discovers the plugin locally, parses `--key=value` passthrough flags into config,
resolves the instance_key, and spawns the subprocess with ITS_NATS_URL /
ITS_INSTANCE_KEY / ITS_CONFIG_JSON. The plugin's SDK validates config and claims
the uniqueness lock; this CLI just delivers inputs and relays logs.
"""

from __future__ import annotations

import socket
import subprocess
import sys
import threading
from pathlib import Path
from urllib.parse import urlparse

import typer

from its_core.log import get_logger
from its_core.plugins import discover
from its_core.supervisor import build_plugin_env, resolve_instance_key

log = get_logger("connect")


def connect(
    ctx: typer.Context,
    plugin: str = typer.Argument(..., help="Plugin id to run as a one-off intake."),
    host: str = typer.Argument(
        "localhost",
        metavar="[HOST]",
        help=(
            "Where the ITS server's NATS is reachable. Accepts a bare host "
            "(`localhost`, `launch-box.local`, `192.168.1.5`), a host:port "
            "(`launch-box.local:4222`), or a full URL (`nats://...`). Defaults "
            "to `localhost`."
        ),
    ),
    config: str = typer.Option(
        None, "-c", "--config", help="Config file (TODO: not yet implemented; use flags)."
    ),
) -> None:
    """Run a single intake against a remote ITS server (manual / dev mode)."""
    if config is not None:
        log.error("the -c/--config file form is not yet implemented; use --key=value flags")
        raise typer.Exit(code=1)

    # Click fills positionals before ignore_unknown_options, so a leading
    # passthrough flag lands in `host`. Anything starting with `--` is a flag,
    # not a hostname; rewind it.
    extra_args = list(ctx.args)
    if host.startswith("--"):
        extra_args.insert(0, host)
        host = "localhost"

    server_url = _resolve_nats_url(host)

    plugins_dir = Path("plugins")
    manifests = discover(plugins_dir)
    by_id = {m.id: m for m in manifests}
    if plugin not in by_id:
        log.error(f"plugin {plugin!r} not found in {plugins_dir}/")
        raise typer.Exit(code=1)
    manifest = by_id[plugin]

    if manifest.runtime_kind != "subprocess" or manifest.entry_path is None:
        log.error(f"plugin {plugin!r} has no Python runtime to spawn (UI-only?)")
        raise typer.Exit(code=1)

    try:
        config_dict = _parse_passthrough(extra_args)
    except ValueError as exc:
        log.error(str(exc))
        raise typer.Exit(code=1) from exc

    if manifest.config is None:
        if config_dict:
            log.error(
                f"plugin {plugin!r} declares no [config] section, but flags were "
                f"provided: {sorted(config_dict)}"
            )
            raise typer.Exit(code=1)
        instance_key = "manual"
        config_payload: dict[str, object] | None = None
    else:
        missing = [f for f in manifest.config.instance_key if f not in config_dict]
        if missing:
            example = ", ".join(f"--{f}=<value>" for f in missing)
            log.error(
                f"missing required flag(s) for instance_key field(s) {missing}: {example}"
            )
            raise typer.Exit(code=1)
        instance_key = resolve_instance_key(config_dict, manifest.config.instance_key)
        config_payload = dict(config_dict)

    if not _nats_reachable(server_url):
        log.error(
            f"could not reach NATS at {server_url}; is `its dev` (or another ITS "
            f"server) running on that host?"
        )
        raise typer.Exit(code=1)

    env = build_plugin_env(instance_key, config_payload, nats_url=server_url)
    log.info(
        f"connecting {plugin} (instance_key={instance_key!r}) to {server_url}"
    )

    plugin_log = get_logger(f"plugin:{plugin}")
    proc = subprocess.Popen(
        [sys.executable, str(manifest.entry_path)],
        cwd=manifest.plugin_dir,
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
        log.info("disconnecting...")
        proc.terminate()
        try:
            rc = proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            log.warn("plugin did not exit in 10s; killing")
            proc.kill()
            rc = proc.wait()
    raise typer.Exit(code=rc)


def _nats_reachable(url: str, timeout: float = 1.0) -> bool:
    """Quick TCP probe so we fail fast with a readable error instead of a
    30-line asyncio traceback from the plugin subprocess."""
    parsed = urlparse(url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 4222
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _resolve_nats_url(host: str) -> str:
    """Expand a host into a full NATS URL (`192.168.1.5:4444` ->
    `nats://192.168.1.5:4444`); `scheme://...` is returned unchanged.

    Rewrite `localhost` to `127.0.0.1`: Windows resolves localhost to `::1`
    first, our NATS binds only v4, and nats-py tries only the first address
    (times out instead of falling back). Port defaults to 4222 (the spawn port).
    """
    if "://" in host:
        return host
    h, _, p = host.partition(":")
    if h == "localhost":
        h = "127.0.0.1"
    port = p or "4222"
    return f"nats://{h}:{port}"


def _parse_passthrough(args: list[str]) -> dict[str, str]:
    """Parse `--key=value` (and `--key value`) into a dict. Values stay strings;
    the plugin's Pydantic Config coerces them. `--key=value` handles negatives cleanly.
    """
    config: dict[str, str] = {}
    i = 0
    while i < len(args):
        a = args[i]
        if not a.startswith("--"):
            raise ValueError(f"unexpected positional arg {a!r}; use --key=value")
        body = a[2:]
        if "=" in body:
            key, val = body.split("=", 1)
        else:
            if i + 1 >= len(args):
                raise ValueError(f"flag {a!r} missing value")
            key, val = body, args[i + 1]
            i += 1
        if not key:
            raise ValueError(f"flag {a!r} has empty name")
        config[key] = val
        i += 1
    return config
