"""Cluster-wide alert suppression policy. Lives in the its-globals KV bucket at
key `its-alerts.suppression`, so muting from one browser silences everywhere.
Written only from AlertsView's mute toggles.

`levels` is list[str] not list[AlertLevel] to avoid a duplicate AlertLevel
declaration in the generated its-alerts.ts (json2ts inlines referenced enums
per-schema). The UI's fixed mute-pill row guards the value set.
"""

from pydantic import BaseModel


class Suppression(BaseModel):
    # Plugin ids silenced wholesale; matched against the <plugin> subject segment.
    sources: list[str] = []
    # AlertLevel string forms ("info"/"warn"/"error"/"critical") silenced wholesale.
    levels: list[str] = []
    # Exact `<source>:<key>` strings to mute one sticky without silencing its source.
    keys: list[str] = []
