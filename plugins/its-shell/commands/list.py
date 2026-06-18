from pydantic import BaseModel, Field


class IntakeSummary(BaseModel):
    instance_id: str
    plugin: str
    instance_key: str
    pid: int


class ListCommand(BaseModel):
    """Snapshot of the station's currently-running intakes."""

    class Response(BaseModel):
        intakes: list[IntakeSummary] = Field(default_factory=list)
