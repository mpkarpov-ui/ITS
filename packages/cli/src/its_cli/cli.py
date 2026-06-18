import typer

from its_cli import __version__
from its_cli.commands import (
    build,
    codegen,
    connect,
    create,
    dev,
    doctor,
    lint,
    locks,
    repeater,
    schema,
    shell,
    start,
    streams,
)

app = typer.Typer(
    name="its",
    help="Integrated Telemetry System - plugin-driven telemetry platform.",
    no_args_is_help=True,
    add_completion=False,
)


def _print_version(value: bool) -> None:
    if value:
        typer.echo(__version__)
        raise typer.Exit()


@app.callback()
def _root(
    version: bool = typer.Option(
        None,
        "--version",
        callback=_print_version,
        is_eager=True,
        help="Print the its version and exit.",
    ),
) -> None:
    """Root callback; hosts global flags like --version."""


@app.command(name="help")
def _help(ctx: typer.Context) -> None:
    """Show top-level help (same as `its --help`)."""
    if ctx.parent is not None:
        typer.echo(ctx.parent.get_help())


app.command(name="start")(start.start)
app.command(name="dev")(dev.dev)
app.command(name="codegen")(codegen.codegen)
# connect accepts plugin-specific flags it cannot know about; allow passthrough.
app.command(
    name="connect",
    context_settings={"allow_extra_args": True, "ignore_unknown_options": True},
)(connect.connect)
app.command(name="shell")(shell.shell)
app.command(name="repeater")(repeater.repeater)
app.add_typer(streams.app, name="streams")
app.command(name="doctor")(doctor.doctor)

app.add_typer(create.app, name="create")
app.add_typer(lint.app, name="lint")
app.add_typer(locks.app, name="locks")
app.add_typer(schema.app, name="schema")
app.add_typer(build.app, name="build")
