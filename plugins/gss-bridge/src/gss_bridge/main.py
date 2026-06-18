"""Translates GSS MQTT telemetry into ITS Tlm packets.

One bridge instance subscribes to one MQTT topic and republishes the
telemetry as a native Tlm packet. Accepted MQTT wire shapes:
  {"metadata": {...}, "data": {<Tlm fields>}}    full GSS envelope
  {<Tlm fields>}                                 flat (simulator-friendly)
"""

from __future__ import annotations

import asyncio
import json
import sys
import time

import aiomqtt
from pydantic import BaseModel

from its_contracts.gss_bridge import Alert, AlertLevel
from its_contracts.midas_ground import Tlm
from its_core.log import get_logger
from its_sdk import every, publish, source

log = get_logger("gss-bridge")

# LOS threshold. Tlm streams ~10Hz, so 3s is ~30 missed packets, past any
# transient hiccup.
TLM_STALE_S = 3.0


@source(id="gss-bridge")
class GssBridge:
    class Config(BaseModel):
        channel: str
        mqtt_topic: str
        mqtt_url: str = "mqtt://127.0.0.1:1884"

    config: Config

    def __init__(self) -> None:
        self._diag_logged = False
        # Staleness tracked per-instance: each bridge owns exactly one channel
        # and has the freshest view of its own liveness.
        self._last_msg_ms: int | None = None
        self._alert_state: str = "live"  # "live" | "stale"

    @publish("tlm")
    async def emit_tlm(self, packet: Tlm) -> Tlm:
        return packet

    @publish("alert")
    async def emit_alert(
        self,
        level: AlertLevel = AlertLevel.INFO,
        title: str = "",
        body: str = "",
        key: str | None = None,
        cleared: bool = False,
    ) -> Alert:
        return Alert(level=level, title=title, body=body, key=key, cleared=cleared)

    def _alert_key(self) -> str:
        # Sticky key per channel so recovery clears the same toast in place.
        return f"gss_tlm_silent_{self.config.channel}"

    @every("1s")
    async def _watchdog(self) -> None:
        # Don't alert before the first message ever arrives (never-expected vs silent).
        if self._last_msg_ms is None:
            return
        age_s = (int(time.time() * 1000) - self._last_msg_ms) / 1000
        if age_s >= TLM_STALE_S and self._alert_state != "stale":
            log.warn(f"channel {self.config.channel}: LOS ({int(age_s)}s since last Tlm)")
            await self.emit_alert(
                level=AlertLevel.WARN,
                key=self._alert_key(),
                title=f"LOS detected on {self.config.channel}",
                body=f"No telemetry for {int(TLM_STALE_S)}s.",
            )
            self._alert_state = "stale"
        # Recovery is handled inline after emit_tlm.

    async def on_start(self) -> None:
        # Fire-and-forget: the MQTT reader is long-lived but on_start must
        # return so the runtime reaches its idle wait. Reader errors surface
        # as log lines, not exceptions here.
        asyncio.create_task(self._mqtt_loop())

    async def _mqtt_loop(self) -> None:
        host, port = _parse_mqtt_url(self.config.mqtt_url)
        log.info(f"connecting to MQTT {host}:{port}, topic={self.config.mqtt_topic!r}")
        # Outer retry loop keeps the bridge alive across broker blips
        # (e.g. NATS restart in `its dev`).
        while True:
            try:
                async with aiomqtt.Client(hostname=host, port=port) as client:
                    await client.subscribe(self.config.mqtt_topic)
                    log.info("subscribed; relaying messages")
                    async for msg in client.messages:
                        await self._handle_message(msg.payload)
            except aiomqtt.MqttError as exc:
                log.warn(f"MQTT connection lost ({exc!r}); retrying in 2s")
                await asyncio.sleep(2.0)

    async def _handle_message(self, payload: bytes) -> None:
        try:
            decoded = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            log.warn(f"dropped non-JSON payload: {exc!r}")
            return
        # GSS envelope: {metadata, data: {src, type, unix, utc, value: {<Tlm fields>}}}.
        # Peel `data` then `data.value`; fall back to flat `{<Tlm fields>}`.
        fields = decoded
        if isinstance(fields, dict) and isinstance(fields.get("data"), dict):
            fields = fields["data"]
        if isinstance(fields, dict) and isinstance(fields.get("value"), dict):
            fields = fields["value"]
        if not isinstance(fields, dict):
            log.warn(f"dropped payload: telemetry fields must be an object, got {type(fields).__name__}")
            return
        # Strip unknown keys (e.g. GSS `type` discriminator). Lenient so new
        # GSS fields don't break the bridge.
        known = set(Tlm.model_fields.keys())
        clean = {k: v for k, v in fields.items() if k in known}
        if not clean and not self._diag_logged:
            # First message yielded no Tlm fields: log the envelope once so the
            # operator can see what arrived.
            log.warn(
                "first MQTT message produced no matching Tlm fields. "
                f"top-level keys: {sorted(decoded.keys()) if isinstance(decoded, dict) else type(decoded).__name__}; "
                f"inner keys after unwrap: {sorted(fields.keys())}; "
                f"sample: {json.dumps(decoded)[:400]}"
            )
            self._diag_logged = True
        try:
            packet = Tlm(**clean)
        except Exception as exc:
            log.warn(f"dropped malformed Tlm ({exc!r})")
            return
        await self.emit_tlm(packet)
        # Mark liveness; cleared=true retracts the sticky toast on recovery.
        self._last_msg_ms = int(time.time() * 1000)
        if self._alert_state != "live":
            log.info(f"channel {self.config.channel}: recovered")
            await self.emit_alert(key=self._alert_key(), cleared=True)
            self._alert_state = "live"


def _parse_mqtt_url(url: str) -> tuple[str, int]:
    """Parse `mqtt://host:port` (or bare `host:port` / `host`). Default port 1883."""
    if "://" in url:
        _, _, rest = url.partition("://")
    else:
        rest = url
    if ":" in rest:
        host, _, port_str = rest.partition(":")
        return host, int(port_str)
    return rest, 1883


if __name__ == "__main__":
    # paho-mqtt uses loop.add_reader/add_writer, which need SelectorEventLoop.
    # Windows defaults to Proactor on 3.13. Set per-plugin, not in the SDK
    # (its-shell needs Proactor for its exec child processes).
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    GssBridge().run()
