"""MIDAS telemetry relay: the canonical consumption endpoint.

Subscribes to every MIDAS telemetry source, reads each packet's MIDAS id off
the incoming subject, and re-publishes onto its own subtree
its.midas-ground.<instance>.<midas_id>.tlm. Downstream views read only this
channel; swapping a source touches only the @subscribe list below. Fan-out
comes from the {midas_id} placeholder, not per-instance config.
"""

from __future__ import annotations

from its_contracts.midas_ground import Tlm
from its_core.log import get_logger
from its_sdk import publish, source, subscribe

log = get_logger("midas-ground")


@source(id="midas-ground")
class MidasGround:
    # One handler per source family; each extracts the MIDAS id and relays.
    @subscribe("its.gss-bridge.*.tlm")
    async def on_gss(self, tlm: Tlm, subject: str) -> None:
        # its.gss-bridge.<channel>.tlm: channel segment is the MIDAS id.
        await self._ingest(subject.split(".")[2], tlm)

    @subscribe("its.iss-feather.*.*.tlm")
    async def on_feather(self, tlm: Tlm, subject: str) -> None:
        # its.iss-feather.<channel>.<serial>.tlm: feather fans out by serial
        # (one COM port, two radios), so the MIDAS id is segment [3].
        await self._ingest(subject.split(".")[3], tlm)

    async def _ingest(self, midas_id: str, tlm: Tlm) -> None:
        # Pass-through while single-source. A redundant receiver would merge
        # latest-per-source here.
        await self.emit_tlm(midas_id=midas_id, packet=tlm)

    @publish("tlm", path="{midas_id}.tlm")
    async def emit_tlm(self, midas_id: str, packet: Tlm) -> Tlm:
        return packet


if __name__ == "__main__":
    MidasGround().run()
