from pydantic import BaseModel


class CmdResult(BaseModel):
    """One feather's outcome for an MShell command line.

    Published on `its.iss-feather.<channel>.cmd_result`. A broadcast command
    fans one line to every feather, but request/reply carries only a single
    reply, so each feather surfaces its outcome here instead. The commanding
    console subscribes to `its.iss-feather.*.cmd_result` and reads the channel
    off the subject.
    """

    # Echoes MshellCommand.cmd_id so the console matches result to sent line.
    cmd_id: str | None = None
    line: str
    ok: bool
    replies: list[str]
    received_ms: int
