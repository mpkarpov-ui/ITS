"""Loads plugin-authored Pydantic models from `plugins/<plugin>/schemas/<stream>.py`.

Used by the auto-generated re-export modules under its_contracts/. Schemas live
outside this package because plugin authors own them; we provide the stable
import surface.
"""

from __future__ import annotations

import importlib.util
from functools import lru_cache
from pathlib import Path
from types import ModuleType


@lru_cache(maxsize=1)
def _workspace_root() -> Path:
    """Walk up from this file until we find the workspace root marker."""
    cur = Path(__file__).resolve().parent
    while cur != cur.parent:
        if (cur / "pnpm-workspace.yaml").exists():
            return cur
        cur = cur.parent
    raise RuntimeError(
        "workspace root (pnpm-workspace.yaml) not found from contracts package"
    )


def _load(plugin: str, kind: str, name: str) -> ModuleType:
    """Internal: load `plugins/<plugin>/<kind>/<name>.py`.

    `kind` is one of {"schemas", "commands", "globals"}.
    """
    path = _workspace_root() / "plugins" / plugin / kind / f"{name}.py"
    if not path.exists():
        raise FileNotFoundError(f"{kind} file not found: {path}")
    mod_name = f"_its_{plugin}_{kind}_{name}".replace("-", "_")
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load {kind} file {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_schema_module(plugin: str, stream: str) -> ModuleType:
    """Load `plugins/<plugin>/schemas/<stream>.py` and return the module."""
    return _load(plugin, "schemas", stream)


def load_command_module(plugin: str, verb: str) -> ModuleType:
    """Load `plugins/<plugin>/commands/<verb>.py` and return the module."""
    return _load(plugin, "commands", verb)


def load_global_module(plugin: str, name: str) -> ModuleType:
    """Load `plugins/<plugin>/globals/<name>.py` and return the module."""
    return _load(plugin, "globals", name)
