"""Plugin source file watcher. Calls back on .py changes under plugins/."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable

from watchfiles import watch

from its_core.log import get_logger

log = get_logger("supervisor")


def watch_plugins(
    plugins_dir: Path,
    on_change: Callable[[set[str], bool], None],
    stop_event: threading.Event,
) -> None:
    """Watch plugins_dir for .py changes; coalesce each batch into one callback.

    Callback gets the set of affected plugin ids plus a bool flagging whether any
    changed file lived under a schemas/ dir (signals codegen before restart).
    Blocks until stop_event is set; run it in a daemon thread.
    """
    plugins_dir = plugins_dir.resolve()
    log.info(f"watching {plugins_dir} for plugin source changes")
    for changes in watch(plugins_dir, stop_event=stop_event):
        affected: set[str] = set()
        schemas_changed = False
        for _change_type, path_str in changes:
            path = Path(path_str)
            if path.suffix != ".py":
                continue
            try:
                rel = path.relative_to(plugins_dir)
            except ValueError:
                continue
            if not rel.parts:
                continue
            affected.add(rel.parts[0])
            if "schemas" in rel.parts:
                schemas_changed = True
        if affected:
            try:
                on_change(affected, schemas_changed)
            except Exception as exc:
                log.error(f"watcher callback failed: {exc}")
