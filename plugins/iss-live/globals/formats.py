from pydantic import BaseModel


class Formats(BaseModel):
    """Named broadcast-format YAMLs keyed by name (legacy `gss_*.yaml` shape
    minus sequencer segments): scenes, preset bundles, audio presets, mission
    text.

    Raw YAML strings so operators edit them in-place. The whole dict is
    rewritten per save; a handful of few-KB formats fits one KV entry.
    """

    entries: dict[str, str] = {}
