from pydantic import BaseModel


class ExecStdinCommand(BaseModel):
    """Write a chunk to the exec session's stdin. Only honored for sessions
    started via `exec_start` (allow_exec=true); `its_invoke` sessions are one-shot."""

    exec_id: str
    chunk: str

    class Response(BaseModel):
        ok: bool
