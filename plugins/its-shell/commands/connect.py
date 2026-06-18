from pydantic import BaseModel, Field


class ConnectCommand(BaseModel):
    """Spin up an intake of `plugin` on this station with the supplied config.

    If omitted, instance_id defaults to `<plugin>:<resolved instance_key>`."""

    plugin: str
    config: dict = Field(default_factory=dict)
    instance_id: str | None = None
    autostart: bool = True    # restored after shell restart

    class Response(BaseModel):
        instance_id: str
        instance_key: str
