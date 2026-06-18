import typer

app = typer.Typer(help="Produce deployable artifacts.", no_args_is_help=True)


@app.command()
def container() -> None:
    """Build a Docker image bundling server + plugins + frontend."""
    typer.echo("its build container: not yet implemented")


@app.command()
def exe() -> None:
    """Build a PyInstaller bundle for non-developer distribution."""
    typer.echo("its build exe: not yet implemented")


@app.command()
def intake(
    plugins: str = typer.Option(
        ..., "--plugins", help="Comma-separated list of plugin ids to include."
    ),
) -> None:
    """Build a slim distributable for an intake-only laptop."""
    typer.echo(f"its build intake: not yet implemented (plugins={plugins!r})")
