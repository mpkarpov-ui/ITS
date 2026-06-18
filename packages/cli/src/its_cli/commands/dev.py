import typer

from its_cli.commands.start import start


def dev(
    config: str = typer.Option(
        "its.toml", "--config", help="Override the default its.toml lookup."
    ),
    port: int = typer.Option(80, "--port", help="Web server port."),
) -> None:
    """Shortcut for `its start --dev`: Vite HMR + plugin file watcher."""
    start(dev=True, config=config, port=port)
