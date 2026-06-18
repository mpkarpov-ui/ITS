import json
import re
import subprocess
import tomllib
from pathlib import Path

import questionary
import typer

from its_cli.commands.start import _resolve_tool
from its_cli.scaffold import Kind, scaffold

app = typer.Typer(
    help="Scaffold new code (interactive wizard by default).",
    no_args_is_help=True,
)

_KEBAB_RE = re.compile(r"^[a-z][a-z0-9-]*$")
_MOUNT_RE = re.compile(r"^[a-z][a-z0-9.-]*$")
_MOUNT_HINTS = ["home.widget", "tab"]
_KIND_CHOICES = [
    ("source", "publishes data on the bus"),
    ("app", "frontend view only"),
    ("source+app", "both (the common case)"),
]


def _add_to_uv_exclude(root_pyproject: Path, entry: str) -> None:
    """Insert `entry` into the root pyproject's [tool.uv.workspace] exclude list.
    Text manipulation, not parse + re-serialize, to preserve comments/formatting.
    """
    text = root_pyproject.read_text(encoding="utf-8")
    if f'"{entry}"' in text:
        return
    insertion = f'    "{entry}",\n'
    marker = "exclude = ["
    idx = text.find(marker)
    if idx == -1:
        return
    close = text.find("]", idx)
    if close == -1:
        return
    new_text = text[:close] + insertion + text[close:]
    root_pyproject.write_text(new_text, encoding="utf-8")


def _pascal(name: str) -> str:
    return "".join(p.capitalize() for p in name.split("-"))


def _read_manifest(plugin_dir: Path) -> dict:
    """Parse the manifest for inspection (read-only)."""
    manifest_path = plugin_dir / "its-plugin.toml"
    if not manifest_path.exists():
        raise FileNotFoundError(f"no manifest at {manifest_path}")
    with manifest_path.open("rb") as f:
        return tomllib.load(f)


def _append_to_manifest(plugin_dir: Path, sections: str) -> None:
    """Append raw TOML text to an existing manifest. Caller formats the section."""
    manifest_path = plugin_dir / "its-plugin.toml"
    existing = manifest_path.read_text(encoding="utf-8")
    if not existing.endswith("\n"):
        existing += "\n"
    if not existing.endswith("\n\n"):
        existing += "\n"
    manifest_path.write_text(existing + sections, encoding="utf-8")


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _prompt_for_missing(
    name: str | None,
    kind: str | None,
    publishes: list[str] | None,
    mount: str | None,
) -> tuple[str, Kind, str | None, str | None]:
    """Walk an interactive wizard for any field not supplied on the command line."""
    if not name:
        name = questionary.text(
            "Plugin name (kebab-case)",
            validate=lambda v: bool(v.strip()) or "name required",
        ).unsafe_ask().strip()

    if not kind:
        kind = questionary.select(
            "Kind",
            choices=[questionary.Choice(f"{k} - {desc}", value=k) for k, desc in _KIND_CHOICES],
        ).unsafe_ask()

    if kind not in ("source", "app", "source+app"):
        raise typer.BadParameter(f"kind must be source | app | source+app, got {kind!r}")

    stream: str | None = (publishes or [None])[0]
    if kind in ("source", "source+app") and not stream:
        stream = questionary.text(
            "Stream name",
            default="data",
            validate=lambda v: bool(v.strip()) or "stream name required",
        ).unsafe_ask().strip()

    if kind in ("app", "source+app") and not mount:
        mount = questionary.select(
            "Mount target",
            choices=_MOUNT_HINTS + [questionary.Choice("other...", value="__other__")],
        ).unsafe_ask()
        if mount == "__other__":
            mount = questionary.text("Mount target string").unsafe_ask().strip()

    return name, kind, stream, mount  # type: ignore[return-value]


@app.command()
def plugin(
    name: str = typer.Argument(None, help="Plugin name (omit to run the interactive wizard)."),
    kind: str = typer.Option(None, "--kind", help="source | app | source+app"),
    publishes: list[str] = typer.Option(
        None, "--publishes", help="Stream name the plugin will publish (one for v1)."
    ),
    mount: str = typer.Option(
        None, "--mount", help="Frontend mount target (e.g. home.widget, tab)."
    ),
    yes: bool = typer.Option(
        False, "--yes", help="Skip prompts; all required flags must be passed."
    ),
) -> None:
    """Scaffold a new plugin."""
    if yes:
        if not name:
            raise typer.BadParameter("plugin name required when --yes is set")
        if not kind:
            raise typer.BadParameter("--kind required when --yes is set")
        stream_name = (publishes or [None])[0]
    else:
        name, kind, stream_name, mount = _prompt_for_missing(name, kind, publishes, mount)

    plugins_root = Path("plugins").resolve()
    try:
        created = scaffold(name, kind, stream_name, mount, plugins_root)  # type: ignore[arg-type]
    except ValueError as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(code=1)

    typer.echo(f"created plugins/{name}/:")
    for p in created:
        typer.echo(f"  {p.relative_to(plugins_root.parent)}")

    if kind == "app":
        _add_to_uv_exclude(plugins_root.parent / "pyproject.toml", f"plugins/{name}")

    _sync_workspace(needs_pnpm=kind in ("app", "source+app"))

    typer.echo("")
    typer.echo(f"plugins/{name}/ is ready.")
    typer.echo("Run `its dev` and open http://localhost")


def _sync_workspace(needs_pnpm: bool) -> None:
    """Run uv sync (always) + pnpm install (if needed). Best-effort with warn-on-fail."""
    uv = _resolve_tool("uv", "https://docs.astral.sh/uv/")
    typer.echo("syncing Python workspace...")
    try:
        subprocess.run([uv, "sync"], check=True)
    except subprocess.CalledProcessError as exc:
        typer.echo(f"warning: uv sync failed (exit {exc.returncode}); fix manually", err=True)
    if needs_pnpm:
        pnpm = _resolve_tool("pnpm", "https://pnpm.io/installation")
        typer.echo("installing JS deps...")
        try:
            subprocess.run([pnpm, "install"], check=True)
        except subprocess.CalledProcessError as exc:
            typer.echo(
                f"warning: pnpm install failed (exit {exc.returncode}); fix manually",
                err=True,
            )


@app.command()
def stream(
    plugin_name: str = typer.Argument(..., metavar="PLUGIN", help="Existing plugin id."),
    stream_name: str = typer.Argument(..., metavar="STREAM", help="New stream name."),
) -> None:
    """Add a stream to an existing plugin. App-only plugins also get Python source
    scaffolded (converts to source+app); existing source plugins get the schema +
    manifest entry and you wire the publisher in main.py."""
    plugins_root = Path("plugins").resolve()
    plugin_dir = plugins_root / plugin_name

    if not plugin_dir.exists():
        typer.echo(f"error: no plugin at plugins/{plugin_name}/", err=True)
        raise typer.Exit(code=1)
    if not _KEBAB_RE.match(stream_name):
        typer.echo(f"error: stream name must be kebab-case: {stream_name!r}", err=True)
        raise typer.Exit(code=1)

    try:
        manifest = _read_manifest(plugin_dir)
    except Exception as exc:
        typer.echo(f"error reading manifest: {exc}", err=True)
        raise typer.Exit(code=1)

    existing_streams = [p.get("stream") for p in manifest.get("publishes", []) or []]
    if stream_name in existing_streams:
        typer.echo(
            f"error: plugin {plugin_name!r} already publishes stream {stream_name!r}", err=True
        )
        raise typer.Exit(code=1)

    schema_path = plugin_dir / "schemas" / f"{stream_name}.py"
    if schema_path.exists():
        typer.echo(f"error: schema already exists at {schema_path}", err=True)
        raise typer.Exit(code=1)

    plugin_module = plugin_name.replace("-", "_")
    plugin_pascal = _pascal(plugin_name)
    stream_pascal = _pascal(stream_name)
    has_runtime = "runtime" in manifest
    created: list[Path] = []

    schema_body = (
        f"from pydantic import BaseModel, Field\n"
        f"\n"
        f"\n"
        f'class {stream_pascal}(BaseModel):\n'
        f'    """{stream_name} payload."""\n'
        f"\n"
        f'    value: float = Field(description="TODO: replace with the real shape.")\n'
    )
    created.append(_write(schema_path, schema_body))

    if not has_runtime:
        # App-only plugin: bootstrap the Python package + [runtime] section.
        pyproject = (
            f'[project]\n'
            f'name = "its-{plugin_name}"\n'
            f'version = "0.1.0"\n'
            f'description = "{plugin_name} plugin."\n'
            f'requires-python = ">=3.11"\n'
            f'dependencies = ["its-sdk-python", "its-contracts"]\n'
            f'\n'
            f'[build-system]\n'
            f'requires = ["hatchling"]\n'
            f'build-backend = "hatchling.build"\n'
            f'\n'
            f'[tool.hatch.build.targets.wheel]\n'
            f'packages = ["src/{plugin_module}"]\n'
            f'\n'
            f'[tool.uv.sources]\n'
            f'its-sdk-python = {{ workspace = true }}\n'
            f'its-contracts = {{ workspace = true }}\n'
        )
        main_body = (
            f"from its_contracts.{plugin_module} import {stream_pascal}\n"
            f"from its_sdk import every, publish, source\n"
            f"\n"
            f"\n"
            f'@source(id="{plugin_name}")\n'
            f"class {plugin_pascal}:\n"
            f"    def __init__(self) -> None:\n"
            f"        self._n = 0\n"
            f"\n"
            f'    @publish("{stream_name}")\n'
            f'    @every("1s")\n'
            f"    def {stream_name.replace('-', '_')}(self) -> {stream_pascal}:\n"
            f"        self._n += 1\n"
            f"        return {stream_pascal}(value=float(self._n))\n"
            f"\n"
            f'\n'
            f'if __name__ == "__main__":\n'
            f'    {plugin_pascal}().run()\n'
        )
        created.append(_write(plugin_dir / "pyproject.toml", pyproject))
        created.append(_write(plugin_dir / "src" / plugin_module / "__init__.py", '__version__ = "0.1.0"\n'))
        created.append(_write(plugin_dir / "src" / plugin_module / "main.py", main_body))

    sections = ""
    if not has_runtime:
        sections += (
            f"[runtime]\n"
            f'kind = "subprocess"\n'
            f'entry = "src/{plugin_module}/main.py"\n'
            f"\n"
        )
    sections += (
        f"[[publishes]]\n"
        f'stream = "{stream_name}"\n'
        f"\n"
    )
    _append_to_manifest(plugin_dir, sections)

    typer.echo(f"added stream {stream_name!r} to plugins/{plugin_name}/:")
    for p in created:
        typer.echo(f"  {p.relative_to(plugins_root.parent)}")
    if has_runtime:
        typer.echo("")
        typer.echo(
            f"note: edit plugins/{plugin_name}/src/{plugin_module}/main.py to "
            f"@publish('{stream_name}') the new stream."
        )

    _sync_workspace(needs_pnpm=False)


# Named `app_` because `app` is the module-level Typer instance.
@app.command(name="app")
def app_(
    plugin_name: str = typer.Argument(..., metavar="PLUGIN", help="Existing plugin id."),
    mount: str = typer.Option(
        None, "--mount", help="Frontend mount target (e.g. home.widget, tab)."
    ),
) -> None:
    """Add a frontend to an existing Python-only plugin."""
    plugins_root = Path("plugins").resolve()
    plugin_dir = plugins_root / plugin_name

    if not plugin_dir.exists():
        typer.echo(f"error: no plugin at plugins/{plugin_name}/", err=True)
        raise typer.Exit(code=1)
    try:
        manifest = _read_manifest(plugin_dir)
    except Exception as exc:
        typer.echo(f"error reading manifest: {exc}", err=True)
        raise typer.Exit(code=1)
    if "ui" in manifest:
        typer.echo(f"error: plugin {plugin_name!r} already has [ui] in its manifest", err=True)
        raise typer.Exit(code=1)

    if not mount:
        mount = questionary.select(
            "Mount target",
            choices=_MOUNT_HINTS + [questionary.Choice("other...", value="__other__")],
        ).unsafe_ask()
        if mount == "__other__":
            mount = questionary.text("Mount target string").unsafe_ask().strip()
    if not _MOUNT_RE.match(mount):
        typer.echo(f"error: mount target must look like an identifier: {mount!r}", err=True)
        raise typer.Exit(code=1)

    plugin_pascal = _pascal(plugin_name)
    component_name = f"{plugin_pascal}Widget"
    has_runtime = "runtime" in manifest
    existing_streams = [p.get("stream") for p in manifest.get("publishes", []) or []]
    created: list[Path] = []

    pkg = json.dumps(
        {
            "name": f"@its/{plugin_name}",
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
    created.append(_write(plugin_dir / "package.json", pkg))

    # If the plugin publishes, subscribe to its first stream; else a placeholder.
    if existing_streams:
        first_stream = existing_streams[0]
        ui = (
            f"import {{ useStream }} from '@its/sdk-react';\n"
            f"\n"
            f"export function {component_name}() {{\n"
            f"  // Subject is autocomplete- and type-checked via @its/contracts/_subjects.\n"
            f"  const data = useStream('its.{plugin_name}.*.{first_stream}');\n"
            f"  return (\n"
            f"    <div style={{{{ padding: '1rem', border: '1px solid #ddd', borderRadius: '8px', "
            f"maxWidth: '20rem', fontFamily: 'system-ui, sans-serif' }}}}>\n"
            f"      <h3 style={{{{ margin: '0 0 0.5rem 0', fontSize: '0.85rem', color: '#666', "
            f"letterSpacing: '0.05em' }}}}>{plugin_name.upper()}</h3>\n"
            f"      {{data\n"
            f"        ? <pre style={{{{ fontSize: '0.85rem' }}}}>{{JSON.stringify(data, null, 2)}}</pre>\n"
            f"        : <div style={{{{ color: '#888', fontStyle: 'italic' }}}}>waiting...</div>}}\n"
            f"    </div>\n"
            f"  );\n"
            f"}}\n"
        )
    else:
        ui = (
            f"// TODO: import useStream from '@its/sdk-react' and subscribe to a subject.\n"
            f"\n"
            f"export function {component_name}() {{\n"
            f"  return (\n"
            f"    <div style={{{{ padding: '1rem', border: '1px solid #ddd', borderRadius: '8px', "
            f"maxWidth: '20rem', fontFamily: 'system-ui, sans-serif' }}}}>\n"
            f"      <h3 style={{{{ margin: '0 0 0.5rem 0', fontSize: '0.85rem', color: '#666', "
            f"letterSpacing: '0.05em' }}}}>{plugin_name.upper()}</h3>\n"
            f"      <p>Empty widget. Add your code in ui/index.tsx.</p>\n"
            f"    </div>\n"
            f"  );\n"
            f"}}\n"
        )
    created.append(_write(plugin_dir / "ui" / "index.tsx", ui))

    sections = (
        f"[ui]\n"
        f'entry = "ui/index.tsx"\n'
        f"\n"
        f"[[ui.mounts]]\n"
        f'target = "{mount}"\n'
        f'component = "{component_name}"\n'
        f"\n"
    )
    _append_to_manifest(plugin_dir, sections)

    typer.echo(f"added UI to plugins/{plugin_name}/ mounted at {mount!r}:")
    for p in created:
        typer.echo(f"  {p.relative_to(plugins_root.parent)}")

    # App-only plugin (no runtime) must be excluded from the uv workspace.
    if not has_runtime:
        _add_to_uv_exclude(plugins_root.parent / "pyproject.toml", f"plugins/{plugin_name}")

    _sync_workspace(needs_pnpm=True)


@app.command()
def mount(
    plugin_name: str = typer.Argument(..., metavar="PLUGIN", help="Existing plugin id."),
    mount_target: str = typer.Argument(..., metavar="TARGET", help="Mount target (e.g. tab)."),
) -> None:
    """Mount an existing plugin's app at another target."""
    typer.echo(
        f"its create mount: not yet implemented "
        f"(plugin={plugin_name!r}, target={mount_target!r})"
    )
