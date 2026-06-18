"""Plugin scaffolder: generates a runnable plugin directory from a few inputs."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

Kind = Literal["source", "app", "source+app"]

# Names that would shadow our packages or stdlib modules (not exhaustive).
_RESERVED_NAMES = frozenset({"its", "core", "bus", "test", "tests", "src", "plugins"})

_KEBAB_RE = re.compile(r"^[a-z][a-z0-9-]*$")
_MOUNT_RE = re.compile(r"^[a-z][a-z0-9.-]*$")


@dataclass(frozen=True)
class ScaffoldContext:
    """Derived names for templating, computed from `id` once."""

    id: str                  # kebab-case: "weather-station"
    python_module: str       # snake_case: "weather_station"
    python_dist: str         # PEP-503: "its-weather-station"
    js_name: str             # scoped:   "@its/weather-station"
    class_name: str          # PascalCase: "WeatherStation"
    component_name: str      # "WeatherStationWidget"
    kind: Kind
    stream: str | None
    mount: str | None


def _camel_case_for(name: str) -> str:
    """Mirror of codegen's _camel_case: kebab-case -> camelCase."""
    parts = name.split("-")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def make_context(id: str, kind: Kind, stream: str | None, mount: str | None) -> ScaffoldContext:
    parts = id.split("-")
    class_name = "".join(p.capitalize() for p in parts)
    return ScaffoldContext(
        id=id,
        python_module=id.replace("-", "_"),
        python_dist=f"its-{id}",
        js_name=f"@its/{id}",
        class_name=class_name,
        component_name=f"{class_name}Widget",
        kind=kind,
        stream=stream,
        mount=mount,
    )


def validate(name: str, kind: Kind, stream: str | None, mount: str | None, plugins_root: Path) -> str | None:
    """Return an error message if the inputs are bad, None if they're fine."""
    if not _KEBAB_RE.match(name):
        return f"plugin name must be kebab-case (lowercase, starts with a letter): got {name!r}"
    if name in _RESERVED_NAMES:
        return f"plugin name {name!r} is reserved; pick another"
    if (plugins_root / name).exists():
        return f"plugins/{name}/ already exists"
    if kind not in ("source", "app", "source+app"):
        return f"kind must be source | app | source+app, got {kind!r}"
    needs_stream = kind in ("source", "source+app")
    if needs_stream and not stream:
        return f"--publishes <stream> is required for kind={kind}"
    if needs_stream and not _KEBAB_RE.match(stream):
        return f"stream name must be kebab-case: got {stream!r}"
    needs_mount = kind in ("app", "source+app")
    if needs_mount and not mount:
        return f"--mount <target> is required for kind={kind}"
    if needs_mount and not _MOUNT_RE.match(mount):
        return f"mount target must look like an identifier (lowercase, dots ok): got {mount!r}"
    return None


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def write_manifest(plugin_dir: Path, ctx: ScaffoldContext) -> Path:
    lines = [
        f'id = "{ctx.id}"',
        'version = "0.1.0"',
        f'description = "{ctx.id} plugin (scaffolded by its create)."',
        "",
    ]
    if ctx.kind in ("source", "source+app"):
        lines += [
            "[runtime]",
            'kind = "subprocess"',
            f'entry = "src/{ctx.python_module}/main.py"',
            "",
            "[[publishes]]",
            f'stream = "{ctx.stream}"',
            "",
        ]
    if ctx.kind in ("app", "source+app"):
        lines += [
            "[ui]",
            'entry = "ui/index.tsx"',
            "",
            "[[ui.mounts]]",
            f'target = "{ctx.mount}"',
            f'component = "{ctx.component_name}"',
            "",
        ]
    return _write(plugin_dir / "its-plugin.toml", "\n".join(lines))


def write_python_package(plugin_dir: Path, ctx: ScaffoldContext) -> list[Path]:
    """Generate pyproject.toml + src/<module>/{__init__,main}.py for source kinds."""
    py = (
        f'[project]\n'
        f'name = "{ctx.python_dist}"\n'
        f'version = "0.1.0"\n'
        f'description = "{ctx.id} plugin (scaffolded by its create)."\n'
        f'requires-python = ">=3.11"\n'
        f'dependencies = ["its-sdk-python"]\n'
        f'\n'
        f'[build-system]\n'
        f'requires = ["hatchling"]\n'
        f'build-backend = "hatchling.build"\n'
        f'\n'
        f'[tool.hatch.build.targets.wheel]\n'
        f'packages = ["src/{ctx.python_module}"]\n'
        f'\n'
        f'[tool.uv.sources]\n'
        f'its-sdk-python = {{ workspace = true }}\n'
    )

    main = (
        f'from its_sdk import every, publish, source\n'
        f'\n'
        f'\n'
        f'@source(id="{ctx.id}")\n'
        f'class {ctx.class_name}:\n'
        f'    def __init__(self) -> None:\n'
        f'        self._n = 0\n'
        f'\n'
        f'    @publish("{ctx.stream}")\n'
        f'    @every("1s")\n'
        f'    def {ctx.stream.replace("-", "_")}(self) -> dict:\n'
        f'        self._n += 1\n'
        f'        return {{"value": self._n}}\n'
        f'\n'
        f'\n'
        f'if __name__ == "__main__":\n'
        f'    {ctx.class_name}().run()\n'
    )

    return [
        _write(plugin_dir / "pyproject.toml", py),
        _write(plugin_dir / "src" / ctx.python_module / "__init__.py", '__version__ = "0.1.0"\n'),
        _write(plugin_dir / "src" / ctx.python_module / "main.py", main),
    ]


def write_js_package(plugin_dir: Path, ctx: ScaffoldContext) -> list[Path]:
    """Generate package.json + ui/index.tsx for app kinds."""
    pkg = json.dumps(
        {
            "name": ctx.js_name,
            "version": "0.1.0",
            "private": True,
            "type": "module",
            "dependencies": {
                "preact": "^10",
                "@its/sdk-react": "workspace:*",
            },
        },
        indent=2,
    ) + "\n"

    if ctx.kind == "source+app":
        plugin_prop = _camel_case_for(ctx.id)
        stream_prop = _camel_case_for(ctx.stream)
        ui = (
            f"import {{ subjects, useStream }} from '@its/sdk-react';\n"
            f"\n"
            f"export function {ctx.component_name}() {{\n"
            f"  // Subject built by the codegen-emitted `subjects` tree for type safety.\n"
            f"  const data = useStream(subjects.{plugin_prop}.{stream_prop}());\n"
            f"  return (\n"
            f"    <div style={{{{ padding: '1rem', border: '1px solid #ddd', borderRadius: '8px', "
            f"maxWidth: '20rem', fontFamily: 'system-ui, sans-serif' }}}}>\n"
            f"      <h3 style={{{{ margin: '0 0 0.5rem 0', fontSize: '0.85rem', color: '#666', "
            f"letterSpacing: '0.05em' }}}}>{ctx.id.upper()}</h3>\n"
            f"      {{data\n"
            f"        ? <div style={{{{ fontSize: '2rem', fontFamily: 'monospace' }}}}>{{data.value}}</div>\n"
            f"        : <div style={{{{ color: '#888', fontStyle: 'italic' }}}}>waiting...</div>}}\n"
            f"    </div>\n"
            f"  );\n"
            f"}}\n"
        )
    else:
        # app-only: no source yet, so a placeholder for the author.
        ui = (
            f"// TODO: import useStream from '@its/sdk-react' and pick a subject to subscribe to.\n"
            f"\n"
            f"export function {ctx.component_name}() {{\n"
            f"  return (\n"
            f"    <div style={{{{ padding: '1rem', border: '1px solid #ddd', borderRadius: '8px', "
            f"maxWidth: '20rem', fontFamily: 'system-ui, sans-serif' }}}}>\n"
            f"      <h3 style={{{{ margin: '0 0 0.5rem 0', fontSize: '0.85rem', color: '#666', "
            f"letterSpacing: '0.05em' }}}}>{ctx.id.upper()}</h3>\n"
            f"      <p>Empty widget. Add your code in ui/index.tsx.</p>\n"
            f"    </div>\n"
            f"  );\n"
            f"}}\n"
        )

    return [
        _write(plugin_dir / "package.json", pkg),
        _write(plugin_dir / "ui" / "index.tsx", ui),
    ]


def write_schemas(plugin_dir: Path, ctx: ScaffoldContext) -> list[Path]:
    if ctx.kind not in ("source", "source+app"):
        return []
    # Author edits this .py; codegen derives JSON + TS on next `its codegen`.
    stream_title = "".join(p.capitalize() for p in ctx.stream.split("-"))
    body = (
        f"from pydantic import BaseModel, Field\n"
        f"\n"
        f"\n"
        f'class {stream_title}(BaseModel):\n'
        f'    """{ctx.stream} payload."""\n'
        f"\n"
        f'    value: float = Field(description="TODO: replace with the real shape.")\n'
    )
    return [_write(plugin_dir / "schemas" / f"{ctx.stream}.py", body)]


def scaffold(
    name: str,
    kind: Kind,
    stream: str | None,
    mount: str | None,
    plugins_root: Path,
) -> list[Path]:
    """Generate the plugin file set. Raises ValueError on validation failure."""
    err = validate(name, kind, stream, mount, plugins_root)
    if err is not None:
        raise ValueError(err)

    ctx = make_context(name, kind, stream, mount)
    plugin_dir = plugins_root / name

    paths: list[Path] = []
    paths.append(write_manifest(plugin_dir, ctx))
    if kind in ("source", "source+app"):
        paths.extend(write_python_package(plugin_dir, ctx))
        paths.extend(write_schemas(plugin_dir, ctx))
    if kind in ("app", "source+app"):
        paths.extend(write_js_package(plugin_dir, ctx))
    return paths
