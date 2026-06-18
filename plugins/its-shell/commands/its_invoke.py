from pydantic import BaseModel, Field


class ItsInvokeCommand(BaseModel):
    """Run `its <argv>` on the station. Available regardless of `allow_exec`;
    the attack surface is bounded by the platform's verb set."""

    argv: list[str] = Field(default_factory=list)
    cwd: str | None = None

    class Response(BaseModel):
        exec_id: str
