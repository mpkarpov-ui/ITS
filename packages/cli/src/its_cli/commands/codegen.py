from pathlib import Path

import typer

from its_contracts.codegen import generate_all
from its_core.log import get_logger

log = get_logger("supervisor")


def codegen() -> None:
    """Generate Pydantic + TS types from plugins/*/schemas/."""
    log.info("generating types from schemas...")
    try:
        result = generate_all(Path("plugins"), Path("packages/contracts"))
    except Exception as exc:
        log.error(f"codegen failed: {exc}")
        raise typer.Exit(code=1) from exc
    if not result.outputs:
        log.info("no schemas found")
        return
    if result.regenerated == 0:
        log.info(
            f"types up to date ({result.total} file(s) for {len(result.outputs)} plugin(s); cache hit)"
        )
    else:
        log.info(
            f"generated {result.regenerated} of {result.total} type file(s) "
            f"for {len(result.outputs)} plugin(s)"
        )
    for plugin_id, paths in result.outputs.items():
        log.info(f"  {plugin_id}: {len(paths)} files")
