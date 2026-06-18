from pydantic import BaseModel


class ExecStartCommand(BaseModel):
    """Spawn an arbitrary shell command on the station. Requires the daemon
    to be running with `allow_exec=true`; otherwise the response carries an
    `error` and `exec_id` is empty."""

    cmd: str
    cwd: str | None = None
    env: dict[str, str] | None = None

    class Response(BaseModel):
        exec_id: str         # empty string when the call was refused
        error: str | None = None
