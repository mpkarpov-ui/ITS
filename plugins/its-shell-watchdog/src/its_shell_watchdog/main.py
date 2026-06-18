"""Watches shell heartbeats and fires sticky alerts when a station goes silent.
Runs server-side alongside the supervisor, so alerts fire with no UI open.

Per-station state: live -> stale (WARN) -> dropped (ERROR) -> recovered (cleared).
Stale and dropped reuse one alert key so the UI updates the toast in place
rather than stacking; recovery clears it.
"""

from __future__ import annotations

import time

from its_contracts.its_shell import Heartbeat
from its_contracts.its_shell_watchdog import Alert, AlertLevel
from its_core.log import get_logger
from its_sdk import every, publish, source, subscribe

log = get_logger("its-shell-watchdog")

# Must match the frontend thresholds (Home.tsx + Fleet's StationRow).
# Shells beat at 1Hz: 3s = 3 missed (stale), 10s = 10 missed (gone).
SHELL_STALE_S = 3.0
SHELL_DROPPED_S = 10.0


def _alert_key(instance_key: str) -> str:
    """One key per station; shared across stale/dropped so escalation updates in place."""
    return f"shell_offline_{instance_key}"


@source(id="its-shell-watchdog")
class ShellWatchdog:
    def __init__(self) -> None:
        # instance_key -> {last_ts_ms, display, state}; state in live|stale|dropped,
        # tracked so we publish only on transitions.
        self._stations: dict[str, dict] = {}

    @subscribe("its.its-shell.*.heartbeat")
    async def on_heartbeat(self, hb: Heartbeat) -> None:
        prev = self._stations.get(hb.instance_key)
        if prev is None:
            log.info(f"tracking new shell: {hb.station} (key={hb.instance_key})")
        self._stations[hb.instance_key] = {
            "last_ts_ms": hb.ts_ms,
            "display": hb.station,
            "state": "live",
        }
        # Retract the sticky alert if the station was stale or dropped.
        if prev is not None and prev.get("state") in ("stale", "dropped"):
            log.info(f"recovered: {hb.station}")
            await self.alert(key=_alert_key(hb.instance_key), cleared=True)

    @publish("alert")
    async def alert(
        self,
        level: AlertLevel = AlertLevel.INFO,
        title: str = "",
        body: str = "",
        key: str | None = None,
        cleared: bool = False,
    ) -> Alert:
        return Alert(level=level, title=title, body=body, key=key, cleared=cleared)

    @every("1s")
    async def check(self) -> None:
        """Fire on entry to stale/dropped; recovery is handled in on_heartbeat."""
        now_ms = time.time() * 1000
        for instance_key, info in self._stations.items():
            age_s = (now_ms - info["last_ts_ms"]) / 1000
            cur_state = info["state"]
            display = info["display"]
            key = _alert_key(instance_key)

            if age_s >= SHELL_DROPPED_S:
                if cur_state != "dropped":
                    log.warn(f"{display}: dropped ({int(age_s)}s since heartbeat)")
                    await self.alert(
                        level=AlertLevel.ERROR,
                        key=key,
                        title=f"Shell disconnected: {display}",
                        body=f"No heartbeat for {int(age_s)}s.",
                    )
                    info["state"] = "dropped"
            elif age_s >= SHELL_STALE_S:
                if cur_state != "stale":
                    log.warn(f"{display}: stale ({int(age_s)}s since heartbeat)")
                    await self.alert(
                        level=AlertLevel.WARN,
                        key=key,
                        title=f"Shell stale: {display}",
                        body=f"No heartbeat for {int(age_s)}s.",
                    )
                    info["state"] = "stale"


if __name__ == "__main__":
    ShellWatchdog().run()
