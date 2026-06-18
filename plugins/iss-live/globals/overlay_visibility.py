from pydantic import BaseModel


class OverlayVisibility(BaseModel):
    """Which overlay layers render on the broadcast feed. Read by the Overlay
    component running as the OBS browser source. Replaces the legacy
    `@GSS/stream_*` syncVars bag with one typed record.
    """

    spot: bool = False              # bottom telemetry strip (alt/vel/tilt)
    top_timer: bool = False         # top countdown + program-name banner
    timeline: bool = False          # side launch-timeline list
    tag: bool = False               # bottom-right name tag visibility
    t_clock: bool = False           # use T-timer in spot strip instead of FSM label
    single_stage_mode: bool = False # one-stage layout vs two-stage booster+sustainer
