from pydantic import BaseModel


class ExecStopCommand(BaseModel):
    """Terminate the running exec session with this exec_id."""

    exec_id: str

    class Response(BaseModel):
        ok: bool
