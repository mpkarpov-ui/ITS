"""Shell daemon: manages plugin intakes on a remote station, exposed over NATS.

Runs as a regular (long-lived) plugin, so its instance_key is the station name.
Two shells sharing a name against the same NATS collide on the instance_key lock
and the second refuses to start.
"""

from __future__ import annotations

import asyncio
import os
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

from pydantic import BaseModel, Field

from its_contracts.its_shell import (
    ConnectCommand,
    DisconnectCommand,
    ExecOutput,
    ExecStartCommand,
    ExecStdinCommand,
    ExecStopCommand,
    Hardware,
    HardwareCommand,
    Heartbeat,
    IntakeStatus,
    IntakeSummary,
    ItsInvokeCommand,
    ListCommand,
    RestartCommand,
    ShutdownCommand,
)
from its_core.plugins import PluginManifest, discover
from its_core.supervisor import PluginProcess, resolve_instance_key
from its_sdk import command, every, publish, source

from its_shell import hardware as hardware_mod  # absolute: main.py runs as __main__


def _nats_url() -> str:
    return os.environ.get("ITS_NATS_URL", "nats://127.0.0.1:4222")


def _default_station_name() -> str:
    user = os.environ.get("USER") or os.environ.get("USERNAME") or "operator"
    return f"{user}@{socket.gethostname()}"


def _workspace_root() -> Path:
    """Walk up to the workspace marker; PluginProcess spawns us with cwd at
    plugins/shell/, but plugin discovery needs the repo root."""
    cur = Path(__file__).resolve().parent
    while cur != cur.parent:
        if (cur / "pnpm-workspace.yaml").exists():
            return cur
        cur = cur.parent
    raise RuntimeError("workspace root (pnpm-workspace.yaml) not found from shell plugin")


@source(id="its-shell")
class Shell:
    class Config(BaseModel):
        name: str = Field(default_factory=_default_station_name)
        allow_exec: bool = False
    config: Config

    def __init__(self) -> None:
        self._started_at = time.monotonic()
        # Sanitized instance_key from the SDK; carried in heartbeats so frontends
        # build subjects safely (raw `name` may contain `@` etc).
        self._instance_key = os.environ.get("ITS_INSTANCE_KEY", "shell")
        self._intakes: dict[str, dict] = {}
        self._exec_sessions: dict[str, dict] = {}
        # Discovery runs once at startup; adding host plugins needs a shell restart.
        self._manifests: dict[str, PluginManifest] = {
            m.id: m for m in discover(_workspace_root() / "plugins")
        }

    @publish("heartbeat")
    @every("1s")
    def heartbeat(self) -> Heartbeat:
        return Heartbeat(
            station=self.config.name,
            instance_key=self._instance_key,
            ts_ms=int(time.time() * 1000),
            uptime_s=time.monotonic() - self._started_at,
            allow_exec=self.config.allow_exec,
            intakes=[
                IntakeStatus(
                    instance_id=iid,
                    plugin=entry["plugin"],
                    instance_key=entry["instance_key"],
                    pid=entry["process"].pid,
                )
                for iid, entry in self._intakes.items()
            ],
        )

    @publish("hardware")
    @every("10s")
    def hardware_stream(self) -> Hardware:
        # Payload `station` is the raw display name; the subject segment carries
        # the sanitized instance_key independently.
        return hardware_mod.enumerate(self.config.name)

    @publish("exec_output", path="exec.{exec_id}.output")
    async def exec_output(self, exec_id: str, payload: ExecOutput) -> ExecOutput:
        # SDK path-template wrapper routes to its.shell.<station>.exec.<exec_id>.output.
        return payload

    @command("connect")
    async def on_connect(self, req: ConnectCommand) -> ConnectCommand.Response:
        manifest = self._manifests.get(req.plugin)
        if manifest is None:
            raise ValueError(f"plugin {req.plugin!r} not available on this station")
        if manifest.runtime_kind != "subprocess":
            raise ValueError(f"plugin {req.plugin!r} has no runtime to spawn")

        if manifest.config is not None:
            try:
                instance_key = resolve_instance_key(req.config, manifest.config.instance_key)
            except KeyError as exc:
                raise ValueError(f"missing config field for instance_key: {exc}") from exc
            config_payload: dict | None = req.config
        else:
            instance_key = "manual"
            config_payload = None if not req.config else req.config

        instance_id = req.instance_id or f"{req.plugin}:{instance_key}"
        if instance_id in self._intakes:
            raise ValueError(f"intake {instance_id!r} already running on this station")

        process = PluginProcess(
            manifest,
            instance_key=instance_key,
            config=config_payload,
            nats_url=_nats_url(),
        )
        self._intakes[instance_id] = {
            "process": process,
            "plugin": req.plugin,
            "instance_key": instance_key,
            "config": req.config,
            "autostart": req.autostart,
        }
        return ConnectCommand.Response(instance_id=instance_id, instance_key=instance_key)

    @command("disconnect")
    async def on_disconnect(self, req: DisconnectCommand) -> DisconnectCommand.Response:
        entry = self._intakes.pop(req.instance_id, None)
        if entry is None:
            return DisconnectCommand.Response(ok=False)
        entry["process"].terminate()
        return DisconnectCommand.Response(ok=True)

    @command("restart")
    async def on_restart(self, req: RestartCommand) -> RestartCommand.Response:
        entry = self._intakes.get(req.instance_id)
        if entry is None:
            return RestartCommand.Response(ok=False)
        entry["process"].terminate()
        manifest = self._manifests[entry["plugin"]]
        entry["process"] = PluginProcess(
            manifest,
            instance_key=entry["instance_key"],
            config=entry["config"] or None,
            nats_url=_nats_url(),
        )
        return RestartCommand.Response(ok=True)

    @command("list")
    async def on_list(self, req: ListCommand) -> ListCommand.Response:
        return ListCommand.Response(intakes=[
            IntakeSummary(
                instance_id=iid,
                plugin=entry["plugin"],
                instance_key=entry["instance_key"],
                pid=entry["process"].pid,
            )
            for iid, entry in self._intakes.items()
        ])

    @command("hardware")
    async def on_hardware(self, req: HardwareCommand) -> HardwareCommand.Response:
        snap = hardware_mod.enumerate(self.config.name)
        return HardwareCommand.Response(**snap.model_dump())

    @command("shutdown")
    async def on_shutdown(self, req: ShutdownCommand) -> ShutdownCommand.Response:
        for entry in list(self._intakes.values()):
            entry["process"].terminate()
        self._intakes.clear()
        # Defer exit so the reply ships over NATS first.
        loop = asyncio.get_running_loop()
        loop.call_later(0.3, lambda: os._exit(0))
        return ShutdownCommand.Response(ok=True)

    @command("its_invoke")
    async def on_its_invoke(self, req: ItsInvokeCommand) -> ItsInvokeCommand.Response:
        # Always-on bounded escape hatch; runs `its` from the same Python env.
        argv = [sys.executable, "-m", "its_cli", *req.argv]
        return ItsInvokeCommand.Response(
            exec_id=self._spawn_exec(argv, req.cwd, env=None, shell=False),
        )

    @command("exec_start")
    async def on_exec_start(self, req: ExecStartCommand) -> ExecStartCommand.Response:
        if not self.config.allow_exec:
            return ExecStartCommand.Response(
                exec_id="",
                error="exec not enabled on this station",
            )
        env = {**os.environ, **(req.env or {})}
        return ExecStartCommand.Response(
            exec_id=self._spawn_exec(req.cmd, req.cwd, env=env, shell=True),
        )

    @command("exec_stop")
    async def on_exec_stop(self, req: ExecStopCommand) -> ExecStopCommand.Response:
        sess = self._exec_sessions.pop(req.exec_id, None)
        if sess is None:
            return ExecStopCommand.Response(ok=False)
        sess["process"].terminate()
        sess["task"].cancel()
        return ExecStopCommand.Response(ok=True)

    @command("exec_stdin")
    async def on_exec_stdin(self, req: ExecStdinCommand) -> ExecStdinCommand.Response:
        if not self.config.allow_exec:
            return ExecStdinCommand.Response(ok=False)
        sess = self._exec_sessions.get(req.exec_id)
        if sess is None or sess["process"].stdin is None:
            return ExecStdinCommand.Response(ok=False)
        try:
            # Binary mode (see _spawn_exec); encode the chunk ourselves.
            sess["process"].stdin.write(req.chunk.encode("utf-8"))
            sess["process"].stdin.flush()
        except OSError:
            return ExecStdinCommand.Response(ok=False)
        return ExecStdinCommand.Response(ok=True)

    def _spawn_exec(self, cmd, cwd, env, shell: bool) -> str:
        exec_id = uuid.uuid4().hex[:12]
        # Default to the workspace root so the console lands where operators
        # expect (repo root), not the shell's plugins/shell/ cwd.
        effective_cwd = cwd or str(_workspace_root())
        # Binary mode + bufsize=0: text=True wraps the pipe in a buffered
        # TextIOWrapper that withholds cmd.exe's no-newline prompt indefinitely.
        # Decode bytes to str ourselves in the pump task.
        proc = subprocess.Popen(
            cmd,
            cwd=effective_cwd,
            env=env,
            shell=shell,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=0,
        )
        task = asyncio.create_task(self._pump_exec_output(exec_id, proc))
        self._exec_sessions[exec_id] = {"process": proc, "task": task}
        return exec_id

    async def _pump_exec_output(self, exec_id: str, proc: subprocess.Popen) -> None:
        """Read merged stdout/stderr in a thread and stream chunks out.

        read(BUFSIZE), not readline: shell prompts (`C:\\...>`) have no trailing
        newline, and grabbing up to BUFSIZE per syscall keeps a chatty command
        to a few large chunks instead of hundreds of per-byte publishes.
        """
        BUFSIZE = 4096
        loop = asyncio.get_running_loop()
        try:
            assert proc.stdout is not None
            while True:
                chunk = await loop.run_in_executor(None, proc.stdout.read, BUFSIZE)
                if not chunk:
                    break
                await self.exec_output(
                    exec_id=exec_id,
                    payload=ExecOutput(
                        type="stdout",
                        data=chunk.decode("utf-8", errors="replace"),
                    ),
                )
            code = proc.wait()
            await self.exec_output(
                exec_id=exec_id,
                payload=ExecOutput(type="exit", data=str(code)),
            )
        except asyncio.CancelledError:
            pass
        finally:
            self._exec_sessions.pop(exec_id, None)


if __name__ == "__main__":
    Shell().run()
