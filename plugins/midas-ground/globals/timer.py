from pydantic import BaseModel


class Timer(BaseModel):
    """Shared launch-countdown state. Lives in the its-globals JetStream KV
    bucket under key commanding-view.timer; written by CommandingView's Timer
    Control, read by every view showing the count."""

    t0: int           # ms-since-epoch when T-0 fires (or last fired)
    paused: bool      # True = clock holds at `paused_value`
    paused_value: int # ms displayed while paused
