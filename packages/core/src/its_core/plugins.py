"""Plugin discovery: scan plugins/*/its-plugin.toml and parse them."""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass
from pathlib import Path

from its_core.log import get_logger

log = get_logger("supervisor")

VALID_RUNTIMES = frozenset({"subprocess", "in-process", "container"})
COMPONENT_NAME_RE = re.compile(r"^[A-Z][A-Za-z0-9_]*$")
STREAM_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]*$")
COMMAND_VERB_RE = re.compile(r"^[a-z][a-z0-9_]*$")
PATH_PLACEHOLDER_RE = re.compile(r"\{([a-z_][a-z0-9_]*)\}")


@dataclass(frozen=True)
class PublishSpec:
    stream: str
    # Subject sub-path under the instance_key segment. None defaults to the stream
    # name. `{snake_case}` placeholders are filled by kwargs at publish time.
    path: str | None


@dataclass(frozen=True)
class UIMount:
    target: str          # "home.widget" | "tab" | "sidebar" | plugin-defined
    component: str       # name of the export in the plugin's ui entry file
    route: str | None    # required when target == "tab"
    title: str | None    # required when target == "tab"


@dataclass(frozen=True)
class GlobalSpec:
    """Manifest [[globals]] entry. The value shape lives in a Pydantic class at
    `plugins/<id>/globals/<name>.py` (file `timer.py` -> class `Timer`); the KV
    value is its JSON serialization.
    """

    name: str


@dataclass(frozen=True)
class CacheSpec:
    """Manifest [[cache]] entry. Opts a subject into the frontend warm-start cache;
    the SDK auto-populator subscribes to `its.<plugin>.*.<subject>` on app load."""

    subject: str


@dataclass(frozen=True)
class CommandSpec:
    """Manifest [[commands]] entry. Carries only the static metadata tooling needs;
    the @command-decorated handler lives in the plugin's Python.

    Every verb is bidirectional: plugins subscribe to both
    `its.cmd.<plugin>.<instance_key>.<verb>` (per-instance request/reply) and
    `its.cmd.<plugin>.<verb>` (broadcast). The call site picks the mode.
    """

    verb: str


@dataclass(frozen=True)
class ConfigSpec:
    """Manifest [config] section. Carries the hints the supervisor needs before
    importing plugin code; the real schema is the plugin's Pydantic Config class.
    """

    # Config fields that form the bus instance_key segment, joined with "-".
    # Empty tuple = use the first Config field (resolved by the SDK at startup).
    instance_key: tuple[str, ...]
    # Values `its dev` passes on autostart. None = skip autostart, needs `its connect`.
    dev_defaults: dict[str, object] | None


@dataclass(frozen=True)
class PluginManifest:
    id: str
    version: str
    description: str | None
    plugin_dir: Path
    runtime_kind: str | None        # None for UI-only plugins
    runtime_entry: str | None
    runtime_autostart: bool         # False = registered but not spawned
    publishes: tuple[PublishSpec, ...]
    commands: tuple[CommandSpec, ...]
    globals: tuple[GlobalSpec, ...]
    cache: tuple[CacheSpec, ...]
    config: ConfigSpec | None
    ui_entry: str | None
    ui_icon: str | None              # None = monogram fallback
    ui_priority: int                 # nav-rail sort weight; higher floats nearer the top
    ui_mounts: tuple[UIMount, ...]

    @property
    def entry_path(self) -> Path | None:
        return self.plugin_dir / self.runtime_entry if self.runtime_entry else None


def _parse(manifest_path: Path) -> PluginManifest:
    """Parse one its-plugin.toml. Raises ValueError on malformed content."""
    plugin_dir = manifest_path.parent
    with manifest_path.open("rb") as f:
        data = tomllib.load(f)

    pid = data.get("id")
    if not pid:
        raise ValueError("missing required 'id' field")
    if pid != plugin_dir.name:
        raise ValueError(
            f"id={pid!r} does not match directory name {plugin_dir.name!r}"
        )

    version = data.get("version")
    if not version:
        raise ValueError("missing required 'version' field")

    # [runtime] is optional: UI-only plugins skip it.
    runtime_kind: str | None = None
    runtime_entry: str | None = None
    runtime_autostart: bool = True
    runtime = data.get("runtime")
    if runtime is not None:
        kind = runtime.get("kind")
        if kind not in VALID_RUNTIMES:
            raise ValueError(
                f"runtime.kind must be one of {sorted(VALID_RUNTIMES)}, got {kind!r}"
            )
        entry = runtime.get("entry")
        if not entry:
            raise ValueError("missing required 'runtime.entry' field")
        if not (plugin_dir / entry).exists():
            raise ValueError(
                f"runtime.entry={entry!r} does not exist relative to plugin dir"
            )
        autostart = runtime.get("autostart", True)
        if not isinstance(autostart, bool):
            raise ValueError(
                f"runtime.autostart must be a bool, got {type(autostart).__name__}"
            )
        runtime_kind = kind
        runtime_entry = entry
        runtime_autostart = autostart

    # Order preserved: scaffolders rely on default-first-stream semantics.
    publishes: list[PublishSpec] = []
    for i, p in enumerate(data.get("publishes") or []):
        stream = p.get("stream")
        if not stream or not STREAM_NAME_RE.match(stream):
            raise ValueError(f"publishes[{i}].stream={stream!r} must be kebab- or snake-case")
        path = p.get("path")
        if path is not None and not isinstance(path, str):
            raise ValueError(f"publishes[{i}].path must be a string if provided")
        if path is not None:
            for ph in PATH_PLACEHOLDER_RE.findall(path):
                if not ph:
                    raise ValueError(f"publishes[{i}].path has an empty placeholder")
        publishes.append(PublishSpec(stream=stream, path=path))

    globals: list[GlobalSpec] = []
    for i, g in enumerate(data.get("globals") or []):
        name = g.get("name")
        if not name or not STREAM_NAME_RE.match(name):
            raise ValueError(
                f"globals[{i}].name={name!r} must be kebab- or snake-case"
            )
        globals.append(GlobalSpec(name=name))

    cache: list[CacheSpec] = []
    for i, c in enumerate(data.get("cache") or []):
        subject = c.get("subject")
        if not subject or not isinstance(subject, str):
            raise ValueError(f"cache[{i}].subject must be a non-empty string")
        cache.append(CacheSpec(subject=subject))

    commands: list[CommandSpec] = []
    for i, c in enumerate(data.get("commands") or []):
        verb = c.get("verb")
        if not verb or not COMMAND_VERB_RE.match(verb):
            raise ValueError(
                f"commands[{i}].verb={verb!r} must be snake_case "
                "(lowercase, starts with a letter)"
            )
        commands.append(CommandSpec(verb=verb))

    # TOML carries only instance_key + dev_defaults; real validation is the
    # plugin's Python Config class.
    config: ConfigSpec | None = None
    cfg = data.get("config")
    if cfg is not None:
        instance_key_raw = cfg.get("instance_key")
        if not isinstance(instance_key_raw, list) or not instance_key_raw or not all(
            isinstance(k, str) and k for k in instance_key_raw
        ):
            raise ValueError(
                "config.instance_key must be a non-empty list of Config field names"
            )
        dev_defaults_raw = cfg.get("dev_defaults")
        if dev_defaults_raw is not None and not isinstance(dev_defaults_raw, dict):
            raise ValueError("config.dev_defaults must be a table if provided")
        # dev_defaults must cover every instance_key field or we can't compute
        # the bus subject prefix.
        if dev_defaults_raw is not None:
            missing = [k for k in instance_key_raw if k not in dev_defaults_raw]
            if missing:
                raise ValueError(
                    f"config.dev_defaults is missing instance_key field(s): {missing}"
                )
        config = ConfigSpec(
            instance_key=tuple(instance_key_raw),
            dev_defaults=dict(dev_defaults_raw) if dev_defaults_raw is not None else None,
        )

    # [ui] is optional: source-only plugins skip it.
    ui_entry: str | None = None
    ui_icon: str | None = None
    ui_priority: int = 0
    ui_mounts: list[UIMount] = []
    ui = data.get("ui")
    if ui is not None:
        entry = ui.get("entry")
        if not entry:
            raise ValueError("[ui] requires 'entry' field")
        if not (plugin_dir / entry).exists():
            raise ValueError(
                f"ui.entry={entry!r} does not exist relative to plugin dir"
            )
        ui_entry = entry

        # Nav-rail icon name; frontend falls back to a derived monogram if absent.
        icon = ui.get("icon")
        if icon is not None and not (isinstance(icon, str) and icon):
            raise ValueError("ui.icon must be a non-empty string if provided")
        ui_icon = icon

        # bool is an int subclass, so reject it explicitly.
        priority = ui.get("priority", 0)
        if not isinstance(priority, int) or isinstance(priority, bool):
            raise ValueError("ui.priority must be an integer if provided")
        ui_priority = priority

        mounts = ui.get("mounts") or []
        if not mounts:
            raise ValueError("[ui] requires at least one [[ui.mounts]] entry")
        for i, m in enumerate(mounts):
            target = m.get("target")
            component = m.get("component")
            if not target:
                raise ValueError(f"ui.mounts[{i}] missing 'target'")
            if not component or not COMPONENT_NAME_RE.match(component):
                raise ValueError(
                    f"ui.mounts[{i}].component={component!r} must be a PascalCase identifier"
                )
            route = m.get("route")
            title = m.get("title")
            if target == "tab" and (not route or not title):
                raise ValueError(
                    f"ui.mounts[{i}] target='tab' requires 'route' and 'title'"
                )
            ui_mounts.append(
                UIMount(
                    target=target,
                    component=component,
                    route=route,
                    title=title,
                )
            )

    if runtime_kind is None and ui_entry is None:
        raise ValueError("plugin must have at least one of [runtime] or [ui]")

    return PluginManifest(
        id=pid,
        version=version,
        description=data.get("description"),
        plugin_dir=plugin_dir.resolve(),
        runtime_kind=runtime_kind,
        runtime_entry=runtime_entry,
        runtime_autostart=runtime_autostart,
        publishes=tuple(publishes),
        commands=tuple(commands),
        globals=tuple(globals),
        cache=tuple(cache),
        config=config,
        ui_entry=ui_entry,
        ui_icon=ui_icon,
        ui_priority=ui_priority,
        ui_mounts=tuple(ui_mounts),
    )


def discover(plugins_dir: Path) -> list[PluginManifest]:
    """Scan plugins_dir for its-plugin.toml manifests; return all valid ones.

    Includes UI-only plugins. Malformed manifests are logged and skipped so one
    bad plugin doesn't crash startup.
    """
    if not plugins_dir.exists():
        return []

    manifests: list[PluginManifest] = []
    for child in sorted(plugins_dir.iterdir()):
        if not child.is_dir():
            continue
        manifest_file = child / "its-plugin.toml"
        if not manifest_file.exists():
            continue
        try:
            manifest = _parse(manifest_file)
        except (ValueError, tomllib.TOMLDecodeError) as exc:
            log.error(f"skipping {child.name}: {exc}")
            continue

        # Unsupported runtimes stay in the registry (UI still loads); only the
        # spawn is skipped.
        if manifest.runtime_kind is not None and manifest.runtime_kind != "subprocess":
            log.warn(
                f"plugin {manifest.id}: runtime.kind={manifest.runtime_kind!r} "
                "not implemented yet; UI (if any) will still load"
            )

        manifests.append(manifest)

    return manifests
