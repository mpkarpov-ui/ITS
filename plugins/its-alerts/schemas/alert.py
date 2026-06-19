"""Shared Alert schema. Any plugin publishes to its own
`its.<plugin>.<instance>.alert` stream by declaring `[[publishes]] stream = "alert"`
and re-exporting `from its_contracts.its_alerts import Alert, AlertLevel`. The
overlay UI subscribes to `its.*.*.alert` and derives the source from the subject.
"""

from enum import StrEnum

from pydantic import BaseModel


class AlertLevel(StrEnum):
    # StrEnum so publishers can pass "info" and it round-trips to "info" on the wire.
    INFO = "info"
    WARN = "warn"
    ERROR = "error"
    CRITICAL = "critical"
    # PROGRESS is in-flight; SUCCESS is terminal and auto-dismisses even when keyed.
    PROGRESS = "progress"
    SUCCESS = "success"


class Alert(BaseModel):
    level: AlertLevel = AlertLevel.INFO
    # Empty default so a cleared=True retraction can omit it.
    title: str = ""
    body: str = ""
    # Override the per-level default auto-dismiss (ms). 0 disables auto-dismiss;
    # ignored for sticky alerts (those with a `key`).
    timeout_ms: int | None = None
    # Sticky identifier: dedupe-tracked by (source, key); republishing updates
    # the toast in place and disables auto-dismiss. Clear with cleared=True + same key.
    key: str | None = None
    # Retraction marker; set with `key` to drop the matching sticky. Other fields
    # may be omitted on a clear.
    cleared: bool = False
    # 0.0-1.0 determinate fraction for a PROGRESS bar; None renders indeterminate.
    progress: float | None = None
