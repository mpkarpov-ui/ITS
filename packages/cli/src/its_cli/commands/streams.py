"""`its streams`: list declared publish streams (`its streams`) and tail live
traffic (`its streams tail <subject>`).
"""

from __future__ import annotations

import asyncio
import json
import os
from datetime import datetime
from pathlib import Path

import nats
import typer
from rich.console import Console
from rich.syntax import Syntax
from rich.table import Table

from its_core.plugins import discover

_PLUGINS_DIR = Path("plugins")


def _default_nats_url() -> str:
    return os.environ.get("ITS_NATS_URL", "nats://127.0.0.1:4222")


app = typer.Typer(
    help="Inspect bus streams: list declared subjects + tail live traffic.",
    no_args_is_help=False,
    invoke_without_command=True,
)


@app.callback(invoke_without_command=True)
def _root(
    ctx: typer.Context,
    plugin: str = typer.Option(
        None,
        "--plugin",
        "-p",
        help="Limit the list to a single plugin id (e.g. mock-rocket).",
    ),
) -> None:
    """List every [[publishes]] stream across all plugins, with `<instance>`
    standing in for the instance_key and path placeholders left verbatim.
    """
    if ctx.invoked_subcommand is not None:
        return
    _list_streams(plugin_filter=plugin)


def _list_streams(plugin_filter: str | None = None) -> None:
    console = Console()
    manifests = discover(_PLUGINS_DIR)
    if plugin_filter:
        manifests = [m for m in manifests if m.id == plugin_filter]
        if not manifests:
            console.print(f"[red]no plugin with id {plugin_filter!r}[/red]")
            raise typer.Exit(code=1)

    rows: list[tuple[str, str, str, str]] = []
    for m in sorted(manifests, key=lambda x: x.id):
        for p in m.publishes:
            subject_tail = p.path if p.path else p.stream
            subject = f"its.{m.id}.<instance>.{subject_tail}"
            path_tmpl = p.path or ""
            rows.append((m.id, p.stream, subject, path_tmpl))

    if not rows:
        msg = (
            f"(no streams declared by {plugin_filter!r})"
            if plugin_filter
            else "(no streams declared)"
        )
        console.print(f"[dim]{msg}[/dim]")
        return

    table = Table(title=None, show_lines=False, box=None, pad_edge=False)
    table.add_column("plugin", style="cyan", no_wrap=True)
    table.add_column("stream", style="magenta", no_wrap=True)
    table.add_column("subject", style="white")
    table.add_column("path template", style="dim")

    for plugin_id, stream, subject, path_tmpl in rows:
        table.add_row(plugin_id, stream, subject, path_tmpl)

    console.print(table)
    console.print(
        f"\n[dim]{len(rows)} stream{'s' if len(rows) != 1 else ''} "
        f"across {len({r[0] for r in rows})} plugin"
        f"{'s' if len({r[0] for r in rows}) != 1 else ''}.[/dim]\n"
        "[dim]Tail one: [/dim][yellow]its streams tail <subject>[/yellow] "
        "[dim](wildcards [/dim][yellow]*[/yellow][dim] / [/dim]"
        "[yellow]>[/yellow][dim] supported).[/dim]"
    )


@app.command()
def tail(
    subject: str = typer.Argument(
        ...,
        help="NATS subject to subscribe to. Wildcards: * (one token), > (rest).",
    ),
    limit: int = typer.Option(
        0,
        "--limit",
        "-n",
        help="Stop after N messages. 0 = run until Ctrl+C.",
    ),
    nats_url: str = typer.Option(
        None,
        "--nats",
        help="NATS server URL. Default: $ITS_NATS_URL or nats://127.0.0.1:4222.",
    ),
    raw: bool = typer.Option(
        False,
        "--raw",
        help="Print one line per message (subject + compact JSON); skip pretty headers.",
    ),
) -> None:
    """Subscribe to a NATS subject and pretty-print incoming messages.

    Examples:
        its streams tail its.mock-rocket.dev.tlm
        its streams tail 'its.its-shell.*.heartbeat'
        its streams tail 'its.>' --limit 5
    """
    url = nats_url or _default_nats_url()
    try:
        asyncio.run(_tail(subject, limit, url, raw))
    except KeyboardInterrupt:
        pass


async def _tail(subject: str, limit: int, nats_url: str, raw: bool) -> None:
    console = Console()
    try:
        nc = await nats.connect(nats_url, allow_reconnect=False)
    except Exception as exc:
        console.print(f"[red]failed to connect to {nats_url}: {exc}[/red]")
        raise typer.Exit(code=1)

    if not raw:
        console.print(
            f"[dim]subscribed: [/dim][yellow]{subject}[/yellow] "
            f"[dim]@ {nats_url} (Ctrl+C to stop)[/dim]"
        )
    count = 0
    stop = asyncio.Event()

    async def on_msg(msg) -> None:
        nonlocal count
        count += 1
        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        try:
            decoded = json.loads(msg.data.decode())
            if raw:
                console.print(
                    f"[cyan]{ts}[/cyan] [yellow]{msg.subject}[/yellow] "
                    f"{json.dumps(decoded, separators=(',', ':'))}",
                    highlight=False,
                )
            else:
                console.print(
                    f"\n[cyan]{ts}[/cyan] [yellow]{msg.subject}[/yellow]"
                )
                console.print(
                    Syntax(
                        json.dumps(decoded, indent=2),
                        "json",
                        theme="ansi_dark",
                        background_color="default",
                    )
                )
        except (UnicodeDecodeError, json.JSONDecodeError):
            body = msg.data.decode(errors="replace")
            if raw:
                console.print(
                    f"[cyan]{ts}[/cyan] [yellow]{msg.subject}[/yellow] {body}",
                    highlight=False,
                )
            else:
                console.print(
                    f"\n[cyan]{ts}[/cyan] [yellow]{msg.subject}[/yellow]\n{body}"
                )
        if limit and count >= limit:
            stop.set()

    sub = await nc.subscribe(subject, cb=on_msg)
    try:
        if limit:
            await stop.wait()
        else:
            await asyncio.Event().wait()
    except asyncio.CancelledError:
        pass
    finally:
        try:
            await sub.unsubscribe()
        except Exception:
            pass
        try:
            await nc.drain()
        except Exception:
            pass
        if not raw:
            console.print(
                f"\n[dim]received {count} message{'s' if count != 1 else ''}.[/dim]"
            )
