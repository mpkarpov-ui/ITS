from pydantic import BaseModel

from its_contracts.its_shell import Hardware


class HardwareCommand(BaseModel):
    """Force a hardware re-enumeration and return the current catalog.

    The response shape mirrors the `hardware` stream so consumers can render
    it the same way regardless of whether they asked or just subscribed."""

    class Response(Hardware):
        pass
