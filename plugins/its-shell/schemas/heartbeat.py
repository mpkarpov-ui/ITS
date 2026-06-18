from pydantic import BaseModel, Field


class IntakeStatus(BaseModel):
    instance_id: str
    plugin: str
    instance_key: str
    pid: int


class Heartbeat(BaseModel):
    """Station status published every 1s on `its.shell.<instance_key>.heartbeat`.
    Fleet UI uses it for the station list and intake state.

    `station` is the raw display name; `instance_key` is the NATS-safe segment
    consumers MUST use to build any other shell subject."""

    station: str
    instance_key: str         # sanitized; use this for subject construction
    ts_ms: int                # epoch ms; lets the UI age-out stale stations
    uptime_s: float
    allow_exec: bool          # whether `exec_start` is gated open
    intakes: list[IntakeStatus] = Field(default_factory=list)
