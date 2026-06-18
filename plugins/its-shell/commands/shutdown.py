from pydantic import BaseModel


class ShutdownCommand(BaseModel):
    """Cleanly terminate all intakes and exit the shell daemon process."""

    class Response(BaseModel):
        ok: bool
