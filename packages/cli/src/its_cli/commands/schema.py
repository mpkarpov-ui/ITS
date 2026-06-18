import json
from pathlib import Path

import typer

from its_contracts.codegen import derive_schema, discover_schemas

app = typer.Typer(help="Schema tools.", no_args_is_help=True)

_PLUGINS_DIR = Path("plugins")


@app.command(name="list")
def list_schemas() -> None:
    """List every plugin and its declared schemas."""
    schemas = discover_schemas(_PLUGINS_DIR)
    if not schemas:
        typer.echo("(no schemas found)")
        return
    for plugin_id in sorted(schemas):
        typer.echo(f"{plugin_id}:")
        for path in schemas[plugin_id]:
            typer.echo(f"  {path.stem}    {path.relative_to(Path.cwd()) if path.is_absolute() else path}")


@app.command()
def show(
    plugin: str = typer.Argument(..., help="Plugin id (e.g. timer-source)."),
    stream: str = typer.Argument(..., help="Stream name (e.g. tick)."),
    compact: bool = typer.Option(
        False, "--compact", help="Print without indentation (single-line JSON)."
    ),
) -> None:
    """Print the derived JSON Schema for one stream to stdout. Pipeable into jq."""
    try:
        schema = derive_schema(plugin, stream, _PLUGINS_DIR)
    except FileNotFoundError as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(code=1)
    except Exception as exc:
        typer.echo(f"error deriving schema: {exc}", err=True)
        raise typer.Exit(code=1)
    typer.echo(json.dumps(schema, indent=None if compact else 2))


@app.command()
def diff(
    plugin: str = typer.Argument(..., help="Plugin id."),
    stream: str = typer.Argument(..., help="Stream name."),
) -> None:
    """Show how this stream's schema differs from main (additive | breaking)."""
    typer.echo(
        f"its schema diff: not yet implemented (plugin={plugin!r}, stream={stream!r})"
    )
