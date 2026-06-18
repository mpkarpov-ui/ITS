"""Hardware enumeration. v1 covers serial ports via pyserial.

Returns an empty list when pyserial is absent rather than crashing the shell.
"""

from __future__ import annotations

import time

from its_contracts.its_shell import Hardware, SerialPort


def enumerate(station: str) -> Hardware:
    return Hardware(
        station=station,
        ts_ms=int(time.time() * 1000),
        ports=_serial_ports(),
    )


def _serial_ports() -> list[SerialPort]:
    try:
        from serial.tools import list_ports
    except ImportError:
        return []
    out: list[SerialPort] = []
    for p in list_ports.comports():
        out.append(
            SerialPort(
                device=p.device,
                description=p.description or "",
                manufacturer=p.manufacturer or None,
                serial_number=p.serial_number or None,
            )
        )
    return out
