"""`its locks`: inspect and clear cross-process instance_key locks.

Each plugin claims a key in the `its-locks` JetStream KV bucket
(`<plugin>.<instance_key>`, value is the holding pid). A hard death (Windows
TerminateProcess, kill -9, OOM) skips the SDK's clean release, so the key lingers
until its TTL. `clear` deletes a key so a fresh instance can claim the slot.
"""

import asyncio
import socket
from urllib.parse import urlparse

import typer

from its_core.log import get_logger

app = typer.Typer(help="Inspect and clear instance_key locks.", no_args_is_help=True)
log = get_logger("locks")


def _resolve_nats_url(host: str) -> str:
    """Same expansion as `its connect` / `its shell`."""
    if "://" in host:
        return host
    h, _, p = host.partition(":")
    if h == "localhost":
        h = "127.0.0.1"
    port = p or "4222"
    return f"nats://{h}:{port}"


def _nats_reachable(url: str, timeout: float = 1.0) -> bool:
    parsed = urlparse(url)
    host = parsed.hostname or "localhost"
    port = parsed.port or 4222
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


async def _list(url: str) -> None:
    import nats
    from nats.js.errors import BucketNotFoundError

    nc = await nats.connect(url, allow_reconnect=False)
    try:
        try:
            kv = await nc.jetstream().key_value(bucket="its-locks")
        except BucketNotFoundError:
            typer.echo("(no locks bucket yet; no plugins have started against this server)")
            return
        keys = await kv.keys()
        if not keys:
            typer.echo("(no locks held)")
            return
        for key in sorted(keys):
            try:
                entry = await kv.get(key)
                pid = entry.value.decode(errors="replace")
            except Exception:
                pid = "?"
            typer.echo(f"  {key:<40}  pid={pid}")
    finally:
        await nc.drain()


async def _clear(url: str, key: str) -> None:
    import nats
    from nats.js.errors import BucketNotFoundError, KeyNotFoundError

    nc = await nats.connect(url, allow_reconnect=False)
    try:
        try:
            kv = await nc.jetstream().key_value(bucket="its-locks")
        except BucketNotFoundError:
            log.error("no locks bucket exists yet")
            raise typer.Exit(code=1)
        try:
            # purge, not delete: the SDK claims via kv.create() (asserts no prior
            # revision). delete() leaves a tombstone that keeps the slot
            # unclaimable; purge() drops the key + history so create() succeeds.
            await kv.purge(key)
            typer.echo(f"cleared {key}")
        except KeyNotFoundError:
            log.error(f"no lock held for {key!r}")
            raise typer.Exit(code=1)
    finally:
        await nc.drain()


def _run(coro, url: str) -> None:
    if not _nats_reachable(url):
        log.error(f"could not reach NATS at {url}; is `its dev`/`its start` running?")
        raise typer.Exit(code=1)
    asyncio.run(coro)


@app.command(name="list")
def list_locks(
    host: str = typer.Argument(
        "localhost",
        metavar="[HOST]",
        help="Where the ITS server's NATS is reachable (default: localhost).",
    ),
) -> None:
    """List every currently-held instance_key lock."""
    url = _resolve_nats_url(host)
    _run(_list(url), url)


@app.command(name="clear")
def clear_lock(
    key: str = typer.Argument(
        ...,
        metavar="KEY",
        help="Lock key in `<plugin>.<instance_key>` form (e.g. `shell.operator-1`).",
    ),
    host: str = typer.Argument(
        "localhost",
        metavar="[HOST]",
        help="Where the ITS server's NATS is reachable (default: localhost).",
    ),
) -> None:
    """Delete a specific lock key so a fresh instance can claim that slot."""
    url = _resolve_nats_url(host)
    _run(_clear(url, key), url)
