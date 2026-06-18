"""Supervised plugin subprocesses."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading

from its_core.log import get_logger
from its_core.plugins import PluginManifest

log = get_logger("supervisor")

# NATS treats `.` as a token separator and `*`/`>` as wildcards, so a value like
# "2.0" or "COM3.A" would split the instance_key segment. Replace anything outside
# [A-Za-z0-9_-] with `_`.
_INSTANCE_KEY_SAFE = re.compile(r"[^A-Za-z0-9_-]+")


def _sanitize_segment(value: object) -> str:
    return _INSTANCE_KEY_SAFE.sub("_", str(value))


def resolve_instance_key(config: dict[str, object], fields: tuple[str, ...]) -> str:
    """Join the named config field values into a bus subject segment.

    Multi-field keys join with `-` (`its.tlm-radio.sustainer-primary.tlm`).
    Values are sanitized to the NATS-safe character set. Raises KeyError if any
    named field is missing from `config`.
    """
    parts = [_sanitize_segment(config[name]) for name in fields]
    return "-".join(parts)


def build_plugin_env(
    instance_key: str,
    config: dict[str, object] | None,
    nats_url: str = "nats://127.0.0.1:4222",
) -> dict[str, str]:
    """Compose the env dict for a plugin subprocess: caller's env plus ITS_*
    so the child SDK picks up instance_key + config.
    """
    env = dict(os.environ)
    env["ITS_INSTANCE_KEY"] = instance_key
    env["ITS_NATS_URL"] = nats_url
    if config is not None:
        env["ITS_CONFIG_JSON"] = json.dumps(config)
    return env


class PluginProcess:
    """One spawned plugin: its Popen handle and log-relay thread."""

    def __init__(
        self,
        manifest: PluginManifest,
        instance_key: str,
        config: dict[str, object] | None,
        nats_url: str = "nats://127.0.0.1:4222",
    ) -> None:
        self.manifest = manifest
        self.instance_key = instance_key
        self.config = config
        self._plugin_log = get_logger(f"plugin:{manifest.id}")
        # bufsize=1 line-buffers; pairs with the plugin's flush=True for near
        # real-time output instead of 4KB chunks.
        self._proc: subprocess.Popen[str] = subprocess.Popen(
            [sys.executable, str(manifest.entry_path)],
            cwd=manifest.plugin_dir,
            env=build_plugin_env(instance_key, config, nats_url),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        self._relay_thread = threading.Thread(target=self._relay, daemon=True)
        self._relay_thread.start()

    @property
    def pid(self) -> int:
        return self._proc.pid

    def _relay(self) -> None:
        assert self._proc.stdout is not None
        for line in self._proc.stdout:
            stripped = line.rstrip()
            if stripped:
                self._plugin_log.info(stripped)

    def terminate(self, timeout: float = 10.0) -> None:
        if self._proc.poll() is not None:
            return
        log.info(f"terminating {self.manifest.id}")
        self._proc.terminate()
        try:
            self._proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            log.warn(f"{self.manifest.id} did not exit in {timeout}s; killing")
            self._proc.kill()
            self._proc.wait()


class Supervisor:
    """Owns a set of PluginProcess instances. Start-all, terminate-all."""

    def __init__(self) -> None:
        self._plugins: list[PluginProcess] = []

    def start(self, manifests: list[PluginManifest]) -> None:
        for m in manifests:
            if m.runtime_kind != "subprocess":
                # UI-only and unsupported runtimes stay in the registry but aren't spawned.
                continue
            if not m.runtime_autostart:
                # Kept in the registry (codegen still runs) but not spawned.
                log.info(f"skipping {m.id}: runtime.autostart = false")
                continue

            instance_key, config = _resolve_dev_config(m)
            if instance_key is None:
                # Needs config but no dev_defaults; operator can still `its connect`.
                log.info(
                    f"skipping {m.id}: needs config (no [config].dev_defaults; "
                    f"use `its connect` to launch with explicit config)"
                )
                continue

            try:
                plugin = PluginProcess(m, instance_key=instance_key, config=config)
            except Exception as exc:
                log.error(f"failed to spawn {m.id}: {exc}")
                continue
            log.info(f"spawned {m.id} (pid {plugin.pid}, instance_key={instance_key!r})")
            self._plugins.append(plugin)

    def shutdown(self) -> None:
        for plugin in self._plugins:
            plugin.terminate()

    def restart_plugin(self, plugin_id: str) -> None:
        """Terminate and respawn one plugin by id. No-op if it isn't supervised."""
        for i, plugin in enumerate(self._plugins):
            if plugin.manifest.id != plugin_id:
                continue
            log.info(f"restarting {plugin_id} (file change detected)")
            plugin.terminate()
            try:
                self._plugins[i] = PluginProcess(
                    plugin.manifest,
                    instance_key=plugin.instance_key,
                    config=plugin.config,
                )
            except Exception as exc:
                log.error(f"failed to respawn {plugin_id}: {exc}")
                self._plugins.pop(i)
                return
            log.info(f"respawned {plugin_id} (pid {self._plugins[i].pid})")
            return
        log.warn(f"restart requested for {plugin_id} but not currently supervised")


def _resolve_dev_config(
    manifest: PluginManifest,
) -> tuple[str | None, dict[str, object] | None]:
    """Resolve (instance_key, config) for dev-mode autostart.

    Zero-config plugins get instance_key="dev", config=None. Configured plugins
    with dev_defaults derive instance_key from the manifest. Returns (None, None)
    when config is required but dev_defaults is absent.
    """
    if manifest.config is None:
        return "dev", None
    if manifest.config.dev_defaults is None:
        return None, None
    instance_key = resolve_instance_key(
        manifest.config.dev_defaults, manifest.config.instance_key
    )
    return instance_key, manifest.config.dev_defaults
