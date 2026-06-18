from pydantic import BaseModel


class DisconnectCommand(BaseModel):
    """Terminate the intake with this instance_id and drop it from desired state."""

    instance_id: str

    class Response(BaseModel):
        ok: bool
