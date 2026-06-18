from pydantic import BaseModel


class MshellCommand(BaseModel):
    """Send a raw MShell command line to the feather over serial.

    The line is the literal the firmware parses, e.g. "fire 42 A", "safe 7",
    "ident". Raw passthrough (not typed per-verb commands) because the MShell
    verb set diverges from the mock-rocket commanding tree and some replies are
    plain text, so a translation layer would just drift from the firmware.
    """

    line: str
    # Correlation id echoed on cmd_result; ignored by the serial path.
    cmd_id: str | None = None

    class Response(BaseModel):
        ok: bool
        replies: list[str]
