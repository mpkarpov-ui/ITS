from pydantic import BaseModel


class ActiveFormat(BaseModel):
    """Which Formats.entries key drives the overlay's mission text (timeline,
    fun facts, sponsors). null means no format loaded; the overlay renders
    generic primitives with empty content.
    """

    name: str | None = None
