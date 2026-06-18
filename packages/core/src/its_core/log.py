"""Terminal logging wrapper. Format spec lives in docs/dx.md (Terminal output)."""

from __future__ import annotations

import hashlib
from datetime import datetime

from rich.console import Console
from rich.text import Text

_stdout = Console()
_stderr = Console(stderr=True)
_debug_enabled = False

# Per-component prefix palette. Red/yellow/dim are reserved for severity. md5
# assignment keeps a component's color stable across runs (muscle memory).
_COMPONENT_PALETTE = (
    "cyan",
    "magenta",
    "green",
    "blue",
    "bright_cyan",
    "bright_magenta",
    "bright_green",
    "bright_blue",
)


def _color_for(component: str) -> str:
    digest = hashlib.md5(component.encode()).digest()
    return _COMPONENT_PALETTE[digest[0] % len(_COMPONENT_PALETTE)]


def _timestamp() -> str:
    now = datetime.now()
    return f"{now:%H:%M:%S}.{now.microsecond // 1000:03d}"


class Logger:
    """Bound logger for one component (e.g. 'supervisor', 'plugin:gps-radio')."""

    def __init__(self, component: str) -> None:
        self.component = component

    def _emit(
        self,
        console: Console,
        prefix_style: str,
        body_style: str | None,
        message: str,
    ) -> None:
        text = Text()
        text.append(f"[{_timestamp()} {self.component}] ", style=prefix_style)
        text.append(message, style=body_style)
        console.print(text, soft_wrap=True)

    def info(self, message: str) -> None:
        self._emit(_stdout, _color_for(self.component), None, message)

    def warn(self, message: str) -> None:
        self._emit(_stdout, "yellow", "yellow", message)

    def error(self, message: str) -> None:
        # stderr so pipelines can separate errors.
        self._emit(_stderr, "red", "red", message)

    def debug(self, message: str) -> None:
        if not _debug_enabled:
            return
        self._emit(_stdout, "dim", "dim", message)


def get_logger(component: str) -> Logger:
    return Logger(component)


def enable_debug() -> None:
    """Surface debug-level messages. Wire this to --dev / --verbose flags."""
    global _debug_enabled
    _debug_enabled = True
