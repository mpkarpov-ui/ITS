from pydantic import BaseModel


class RestartCommand(BaseModel):
    """Terminate and re-spawn the named intake using its persisted config."""

    instance_id: str

    class Response(BaseModel):
        ok: bool
