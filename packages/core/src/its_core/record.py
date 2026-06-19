"""Append-only JSONL recorder for plugins that need a local on-disk log of
whatever flows through them (telemetry, raw frames, events).

One file per session: each Recorder picks a millisecond startup timestamp and
writes <name>.<instance>/<ms>.jsonl under every destination. The file is created
(and logged) at construction so its presence confirms recording is armed, even
before the first packet. Destinations are ~/.its/records and, when running from a
checkout, a repo-local RECORDS/ dir. write() is non-blocking and thread-safe: it
serializes on the caller, hands off to a daemon writer thread, and never raises
into the caller, so a full disk or a bad record degrades the log, not the plugin.
"""

from __future__ import annotations

import atexit
import json
import os
import queue
import threading
import time
from pathlib import Path
from typing import Any

from its_core.log import get_logger

HOME_RECORDS = Path.home() / ".its" / "records"

_log = get_logger("record")

# Sentinel pushed on shutdown so the writer thread drains and exits.
_STOP = object()


def _project_records() -> Path | None:
    """RECORDS/ at the repo root (found by walking up to the .git marker), so
    records also land in-tree during development. None outside a checkout."""
    for parent in Path(__file__).resolve().parents:
        if (parent / ".git").exists():
            return parent / "RECORDS"
    return None


class Recorder:
    """One append-only JSONL session stream, mirrored to every destination.
    Create via get_recorder()."""

    def __init__(self, name: str, instance: str, flush_interval: float = 1.0) -> None:
        self._flush_interval = flush_interval
        self._warned = False
        # One file per session, tagged with the startup time so restarts don't
        # clobber prior runs and each session is a self-contained file.
        subdir = f"{name}.{instance}"
        filename = f"{int(time.time() * 1000)}.jsonl"
        roots = [HOME_RECORDS]
        project = _project_records()
        if project is not None:
            roots.append(project)

        self._files: list[Any] = []
        opened: list[str] = []
        for root in roots:
            path = root / subdir / filename
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                self._files.append(open(path, "a", encoding="utf-8"))  # touch + hold open
                opened.append(str(path))
            except Exception as exc:
                _log.warn(f"could not open record file {path} ({exc!r})")
        if opened:
            _log.info(f"{subdir} recording to {', '.join(opened)}")
        else:
            _log.warn(f"{subdir} has no writable record destination")

        self._q: queue.Queue[Any] = queue.Queue()
        self._thread = threading.Thread(
            target=self._run, name=f"record-{name}", daemon=True
        )
        self._thread.start()
        atexit.register(self.close)

    def write(self, record: Any) -> None:
        """Queue one record. Accepts a dict, a Pydantic model, or a str (written
        verbatim). Serialized here so later caller mutations can't corrupt it."""
        try:
            if isinstance(record, str):
                line = record
            elif hasattr(record, "model_dump_json"):
                line = record.model_dump_json()
            else:
                line = json.dumps(record, default=str)
        except Exception as exc:
            self._warn_once(f"could not serialize record ({exc!r})")
            return
        self._q.put_nowait(line)

    def close(self) -> None:
        """Flush and stop the writer thread. Best-effort; safe to call twice."""
        self._q.put_nowait(_STOP)
        self._thread.join(timeout=2.0)

    def _run(self) -> None:
        while True:
            try:
                item = self._q.get(timeout=self._flush_interval)
            except queue.Empty:
                self._flush()
                continue
            if item is _STOP:
                self._drain_remaining()
                self._flush()
                self._close_files()
                return
            self._write_line(item)
            # Coalesce any burst already queued before flushing once below.
            self._drain_remaining()
            self._flush()

    def _drain_remaining(self) -> None:
        while True:
            try:
                item = self._q.get_nowait()
            except queue.Empty:
                return
            if item is _STOP:
                continue
            self._write_line(item)

    def _write_line(self, line: str) -> None:
        for f in self._files:
            try:
                f.write(line + "\n")
            except Exception as exc:
                self._warn_once(f"record write failed ({exc!r})")

    def _flush(self) -> None:
        for f in self._files:
            try:
                f.flush()
            except Exception:
                pass

    def _close_files(self) -> None:
        for f in self._files:
            try:
                f.close()
            except Exception:
                pass
        self._files = []

    def _warn_once(self, message: str) -> None:
        if not self._warned:
            _log.warn(message)
            self._warned = True


def get_recorder(name: str, instance: str | None = None, flush_interval: float = 1.0) -> Recorder:
    """Recorder writing <name>.<instance>/<session-ms>.jsonl under ~/.its/records
    and (in a checkout) a repo-local RECORDS/. `instance` defaults to
    ITS_INSTANCE_KEY so concurrent plugin instances don't share a file."""
    if instance is None:
        instance = os.environ.get("ITS_INSTANCE_KEY", "dev")
    return Recorder(name, instance, flush_interval=flush_interval)
