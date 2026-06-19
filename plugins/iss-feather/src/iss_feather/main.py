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

from its_contracts.iss_feather import Alert, AlertLevel, CmdResult, MshellCommand
from its_contracts.midas_ground import Tlm
from its_core.log import get_logger
from its_core.record import get_recorder
from its_sdk import command, every, publish, source

log = get_logger("iss-feather")

# LOS threshold. Real feather Tlm runs ~4Hz per rocket, so 3s is ~12 missed
# packets, past any transient hiccup.
TLM_STALE_S = 3.0

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
        # Local JSONL log of raw inbound telemetry, keyed per channel instance.
        self._recorder = get_recorder("iss-feather")
        # Non-`data` reply lines from the reader thread, drained by on_mshell.
        self._status: asyncio.Queue[str] | None = None
        # One mshell line in flight at a time so replies map to their command.
        self._cmd_lock = asyncio.Lock()
        self._diag_logged = False
        # Per-rocket liveness, touched only on the loop, so no lock. A midas_id
        # appears only after its first packet, so a never-seen radio never alerts.
        self._last_ms: dict[str, int] = {}              # midas_id -> last seen ms
        self._alert_state: dict[str, str] = {}          # midas_id -> "live"|"stale"

    @publish("tlm", path="{midas_id}.tlm")
    async def emit_tlm(self, midas_id: str, packet: Tlm) -> Tlm:
        # Runs on the loop (scheduled from the reader thread), as does the
        # watchdog, so the liveness dicts need no lock.
        self._last_ms[midas_id] = int(time.time() * 1000)
        if self._alert_state.get(midas_id) == "stale":
            log.info(f"{midas_id}: telemetry recovered")
            await self.emit_alert(key=self._alert_key(midas_id), cleared=True)
            self._alert_state[midas_id] = "live"
        return packet

    @publish("alert")
    async def emit_alert(
        self,
        level: AlertLevel = AlertLevel.INFO,
        title: str = "",
        body: str = "",
        key: str | None = None,
        cleared: bool = False,
        progress: float | None = None,
    ) -> Alert:
        return Alert(
            level=level, title=title, body=body, key=key, cleared=cleared, progress=progress
        )

    def _alert_key(self, midas_id: str) -> str:
        # Sticky key per (channel, rocket) so recovery clears the same toast.
        return f"iss_feather_tlm_silent_{self.config.channel}_{midas_id}"

    @every("1s")
    async def _watchdog(self) -> None:
        now = int(time.time() * 1000)
        # Snapshot: emit_alert below awaits, letting a new rocket's first packet
        # insert into _last_ms mid-iteration.
        for midas_id, last_ms in list(self._last_ms.items()):
            age_s = (now - last_ms) / 1000
            if age_s >= TLM_STALE_S and self._alert_state.get(midas_id) != "stale":
                log.warn(f"{midas_id}: LOS ({int(age_s)}s since last Tlm)")
                await self.emit_alert(
                    level=AlertLevel.WARN,
                    key=self._alert_key(midas_id),
                    title=f"LOS detected on {midas_id}",
                    body=f"No telemetry for {int(TLM_STALE_S)}s.",
                )
                self._alert_state[midas_id] = "stale"

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
        # Persist the raw packet (full fidelity) before Tlm filtering drops keys.
        self._recorder.write(value)
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
        # Sticky progress alert, resolved to success/error once the ack lands.
        key = self._cmd_alert_key(req)
        title = f"{self.config.channel}: {req.line}"
        await self.emit_alert(
            level=AlertLevel.PROGRESS, key=key, title=title, body="sending...", progress=0.33
        )
        ok, replies = await self._run_mshell(req.line, alert_key=key, alert_title=title)
        # Publish on cmd_result so a broadcast caller sees this feather's outcome;
        # the Response below only reaches a direct request/reply caller.
        await self.emit_cmd_result(cmd_id=req.cmd_id, line=req.line, ok=ok, replies=replies)
        if ok:
            await self.emit_alert(
                level=AlertLevel.SUCCESS, key=key, title=title, body="acknowledged"
            )
        else:
            await self.emit_alert(
                level=AlertLevel.ERROR, key=key, title=title, body=self._failure_reason(replies)
            )
        return MshellCommand.Response(ok=ok, replies=replies)

    def _cmd_alert_key(self, req: MshellCommand) -> str:
        # Per (channel, command) so concurrent feathers and commands don't collide.
        return f"iss_feather_cmd_{self.config.channel}_{req.cmd_id or req.line}"

    def _failure_reason(self, replies: list[str]) -> str:
        if not replies:
            return "no response (timeout)"
        for r in replies:
            t = self._reply_type(r)
            if t in _ERROR_TYPES:
                return t.replace("_", " ")
        return replies[0]

    async def _run_mshell(
        self, line: str, alert_key: str | None = None, alert_title: str | None = None
    ) -> tuple[bool, list[str]]:
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
            replies = await self._collect_replies(q, alert_key, alert_title)
        ok = bool(replies) and not any(self._is_error(r) for r in replies)
        return ok, replies

    async def _collect_replies(
        self,
        q: asyncio.Queue[str] | None,
        alert_key: str | None = None,
        alert_title: str | None = None,
    ) -> list[str]:
        """Wait up to the overall timeout for the first line, then only short
        quiet gaps between subsequent ones. Bumps the progress alert once the
        feather reports the command left the ground radio (command_sent)."""
        if q is None:
            return []
        replies: list[str] = []
        sent_seen = False
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
            if alert_key and not sent_seen and self._reply_type(line) == "command_sent":
                sent_seen = True
                await self.emit_alert(
                    level=AlertLevel.PROGRESS,
                    key=alert_key,
                    title=alert_title or "",
                    body="sent - awaiting ack",
                    progress=0.66,
                )
        return replies

    @staticmethod
    def _reply_type(line: str) -> str | None:
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            return None
        return msg.get("type") if isinstance(msg, dict) else None

    @staticmethod
    def _is_error(line: str) -> bool:
        return IssFeather._reply_type(line) in _ERROR_TYPES


if __name__ == "__main__":
    IssFeather().run()
