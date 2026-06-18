from pydantic import BaseModel, Field


class SerialPort(BaseModel):
    device: str               # e.g. "COM3" or "/dev/ttyUSB0"
    description: str          # OS-reported friendly name
    manufacturer: str | None = None
    serial_number: str | None = None


class Hardware(BaseModel):
    """Station hardware catalog. Published every 10s on
    `its.shell.<station>.hardware` and on-demand via the `hardware` command.
    v1 enumerates serial ports only; usb/cameras/audio are reserved."""

    station: str
    ts_ms: int
    ports: list[SerialPort] = Field(default_factory=list)
    usb: list[dict] = Field(default_factory=list)
    cameras: list[dict] = Field(default_factory=list)
    audio: list[dict] = Field(default_factory=list)
