"""feather_duo serial telemetry intake with MShell commanding.

One instance owns one COM port. Inbound: newline-delimited JSON telemetry
(`{"type": "data", "value": {<Tlm fields>}}`) mapped to canonical Tlm. A
feather_duo carries two radios, so output fans out by packet `serial`:
its.iss-feather.<channel>.<serial>.tlm. Outbound: raw MShell lines relayed to
the same port (see commands/mshell.py).

Transport is pyserial `serial_for_url`, so "COM7" and "socket://127.0.0.1:5555"
(the dev emulator) share one code path; hardware is a config change.

The blocking port is owned by a dedicated reader thread; telemetry hops back to
the loop to publish, and command replies are correlated via an asyncio queue the
reader feeds with call_soon_threadsafe.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any

import serial
from pydantic import BaseModel

from its_contracts.iss_feather import CmdResult, MshellCommand
from its_contracts.midas_ground import Tlm
from its_core.log import get_logger
from its_sdk import command, publish, source

log = get_logger("iss-feather")

# Reply `type`s meaning the command failed; anything else counts as success.
_ERROR_TYPES = {
    "bad_command",
    "command_error",
    "freq_error",
    "send_error",
    "receive_error",
    "init_error",
}

# Overall reply wait, plus the quiet gap that ends collection once at least one
# line arrived. The feather emits `command_sent` then `command_success`
# back-to-back, so a short quiet window captures both without the full timeout.
_REPLY_TIMEOUT_S = 1.5
_REPLY_QUIET_S = 0.3


@source(id="iss-feather")
class IssFeather:
    class Config(BaseModel):
        channel: str          # logical receiver name -> bus instance_key
        port: str             # "COM7" (hardware) or "socket://host:port" (emulator)
        baud: int = 460800    # feather_duo serial rate

    config: Config

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._serial: serial.Serial | None = None
        # Non-`data` reply lines from the reader thread, drained by on_mshell.
        self._status: asyncio.Queue[str] | None = None
        # One mshell line in flight at a time so replies map to their command.
        self._cmd_lock = asyncio.Lock()
        self._diag_logged = False

    @publish("tlm", path="{midas_id}.tlm")
    async def emit_tlm(self, midas_id: str, packet: Tlm) -> Tlm:
        return packet

    @publish("cmd_result")
    async def emit_cmd_result(
        self, cmd_id: str | None, line: str, ok: bool, replies: list[str]
    ) -> CmdResult:
        return CmdResult(
            cmd_id=cmd_id,
            line=line,
            ok=ok,
            replies=replies,
            received_ms=int(time.time() * 1000),
        )

    async def on_start(self) -> None:
        # Capture the loop so the reader thread can schedule work back onto it.
        self._loop = asyncio.get_running_loop()
        self._status = asyncio.Queue()
        # Daemon so a blocked read never holds up interpreter shutdown.
        threading.Thread(target=self._reader_loop, name="feather-serial", daemon=True).start()

    def _reader_loop(self) -> None:
        """Own the port for the process lifetime; reopen on error."""
        while True:
            try:
                ser = serial.serial_for_url(self.config.port, baudrate=self.config.baud, timeout=1)
            except Exception as exc:
                log.warn(f"could not open {self.config.port} ({exc!r}); retrying in 2s")
                time.sleep(2.0)
                continue
            self._serial = ser
            log.info(f"reading {self.config.port} @ {self.config.baud} (channel={self.config.channel})")
            try:
                while True:
                    raw = ser.readline()  # blocks up to `timeout`; b'' on idle
                    if not raw:
                        continue
                    line = raw.decode("utf-8", errors="replace").strip()
                    if line:
                        self._dispatch(line)
            except Exception as exc:
                log.warn(f"serial read error ({exc!r}); reopening in 2s")
                self._serial = None
                try:
                    ser.close()
                except Exception:
                    pass
                time.sleep(2.0)

    def _dispatch(self, line: str) -> None:
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            # Plain-text reply (e.g. `ident`); route to the status queue.
            self._push_status(line)
            return
        if not isinstance(msg, dict):
            return
        if msg.get("type") == "data":
            self._handle_data(msg.get("value"))
        else:
            # command_sent / command_success / bad_command / *_error etc.
            self._push_status(line)

    def _handle_data(self, value: Any) -> None:
        if not isinstance(value, dict):
            return
        serial_no = value.get("serial")
        if serial_no is None:
            # No serial means no MIDAS id to route to. Log the shape once.
            if not self._diag_logged:
                log.warn(f"data packet missing `serial`; cannot route. keys: {sorted(value.keys())}")
                self._diag_logged = True
            return
        # Keep only known Tlm fields (as gss-bridge does): the feather emits
        # extra keys (serial, cmd_ack, err_flags) and the wire format drifts.
        clean = {k: v for k, v in value.items() if k in Tlm.model_fields}
        try:
            packet = Tlm(**clean)
        except Exception as exc:
            log.warn(f"dropped malformed Tlm ({exc!r})")
            return
        # emit_tlm is an async publish wrapper; it must run on the loop.
        loop = self._loop
        if loop is not None:
            asyncio.run_coroutine_threadsafe(
                self.emit_tlm(midas_id=self._midas_id(serial_no), packet=packet), loop
            )

    @staticmethod
    def _midas_id(serial_no: Any) -> str:
        # Map serial into midas-ground's target id space (TargetContext): `m`
        # + zero-padded-3, so 7 -> "m007". FlightView subscribes by this id.
        # Non-numeric serials pass through unchanged.
        try:
            return f"m{int(serial_no):03d}"
        except (TypeError, ValueError):
            return str(serial_no)

    def _push_status(self, line: str) -> None:
        loop, q = self._loop, self._status
        if loop is not None and q is not None:
            loop.call_soon_threadsafe(q.put_nowait, line)

    @command("mshell")
    async def on_mshell(self, req: MshellCommand) -> MshellCommand.Response:
        ok, replies = await self._run_mshell(req.line)
        # Publish on cmd_result so a broadcast caller sees this feather's outcome;
        # the Response below only reaches a direct request/reply caller.
        await self.emit_cmd_result(cmd_id=req.cmd_id, line=req.line, ok=ok, replies=replies)
        return MshellCommand.Response(ok=ok, replies=replies)

    async def _run_mshell(self, line: str) -> tuple[bool, list[str]]:
        """Write one MShell line and collect replies. Error paths return
        ok=False with a one-line reason."""
        ser = self._serial
        if ser is None:
            log.warn(f"mshell {line!r} dropped: serial not open")
            return False, ["serial not open"]
        q = self._status
        async with self._cmd_lock:
            # Drop status lines that arrived before this command so collected
            # replies belong to this line.
            if q is not None:
                while not q.empty():
                    q.get_nowait()
            try:
                ser.write((line + "\r\n").encode("utf-8"))
            except Exception as exc:
                log.warn(f"mshell write failed ({exc!r})")
                return False, [f"write failed: {exc}"]
            log.info(f"mshell -> {line!r}")
            replies = await self._collect_replies(q)
        ok = bool(replies) and not any(self._is_error(r) for r in replies)
        return ok, replies

    async def _collect_replies(self, q: asyncio.Queue[str] | None) -> list[str]:
        """Wait up to the overall timeout for the first line, then only short
        quiet gaps between subsequent ones."""
        if q is None:
            return []
        replies: list[str] = []
        loop = asyncio.get_running_loop()
        deadline = loop.time() + _REPLY_TIMEOUT_S
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            timeout = min(_REPLY_QUIET_S, remaining) if replies else remaining
            try:
                line = await asyncio.wait_for(q.get(), timeout=timeout)
            except asyncio.TimeoutError:
                break
            replies.append(line)
        return replies

    @staticmethod
    def _is_error(line: str) -> bool:
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            return False
        return isinstance(msg, dict) and msg.get("type") in _ERROR_TYPES


if __name__ == "__main__":
    IssFeather().run()
