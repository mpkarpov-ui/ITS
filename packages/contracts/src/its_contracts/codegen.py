"""Schema codegen: discover Pydantic schemas, derive JSON, emit TS + re-export modules.

Input is one Pydantic BaseModel per plugins/<id>/schemas/<stream>.py. Outputs are
the per-plugin TS interfaces, the Python re-export shim, and the derived JSON
Schema. Re-run on every its start to keep generated files in sync with the .py.
"""

from __future__ import annotations

import hashlib
import importlib
import importlib.util
import inspect
import json
import re
import subprocess
import tomllib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

from pydantic import BaseModel

_PLACEHOLDER_RE = re.compile(r"\{([a-z_][a-z0-9_]*)\}")

# Detects `from its_contracts.<plugin_module> import ...` so codegen can process
# cross-plugin dependees first.
_CONTRACTS_IMPORT_RE = re.compile(
    r"^\s*from\s+its_contracts\.([a-z_][a-z0-9_]*)\s+import",
    re.MULTILINE,
)

_HEADER_TS = (
    "// AUTO-GENERATED FROM plugins/*/schemas/*.py. DO NOT EDIT.\n"
    "// Re-run via `its codegen` or restart `its dev`.\n\n"
)
_HEADER_PY = (
    "# AUTO-GENERATED. Re-exports Pydantic models from plugins/<plugin>/schemas/*.py.\n"
    "# DO NOT EDIT. Re-run `its codegen` or restart `its dev`.\n\n"
)


def discover_schemas(plugins_dir: Path) -> dict[str, list[Path]]:
    """Walk plugins_dir for .py schema files. Returns {plugin_id: [.py paths]}."""
    return _discover_kind(plugins_dir, "schemas")


def discover_commands(plugins_dir: Path) -> dict[str, list[Path]]:
    """Walk plugins_dir for .py command files. Returns {plugin_id: [.py paths]}."""
    return _discover_kind(plugins_dir, "commands")


def discover_globals(plugins_dir: Path) -> dict[str, list[Path]]:
    """Walk plugins_dir for .py global files. Returns {plugin_id: [.py paths]}."""
    return _discover_kind(plugins_dir, "globals")


def _discover_kind(plugins_dir: Path, kind: str) -> dict[str, list[Path]]:
    result: dict[str, list[Path]] = {}
    if not plugins_dir.exists():
        return result
    for plugin_dir in sorted(plugins_dir.iterdir()):
        if not plugin_dir.is_dir():
            continue
        target = plugin_dir / kind
        if not target.exists():
            continue
        py_files = sorted(
            p for p in target.glob("*.py") if p.name != "__init__.py"
        )
        if py_files:
            result[plugin_dir.name] = py_files
    return result


def _scan_plugin_deps(
    plugins_dir: Path, plugin_ids: list[str]
) -> dict[str, set[str]]:
    """Build a cross-plugin dependency graph (keyed on kebab-case id) from
    `from its_contracts.<X> import ...` lines, so codegen can topo-order writes
    and let plugin schemas import each other's re-exports without ImportError.

    Self-references are excluded; the per-plugin two-pass write in generate_all
    handles those.
    """
    # snake_case module name (as it appears in `from its_contracts.X`) -> kebab id.
    name_to_id = {pid.replace("-", "_"): pid for pid in plugin_ids}
    deps: dict[str, set[str]] = {pid: set() for pid in plugin_ids}

    for plugin_id in plugin_ids:
        plugin_dir = plugins_dir / plugin_id
        for sub in ("schemas", "commands", "globals"):
            sub_dir = plugin_dir / sub
            if not sub_dir.exists():
                continue
            for py in sub_dir.glob("*.py"):
                if py.name == "__init__.py":
                    continue
                try:
                    text = py.read_text(encoding="utf-8")
                except OSError:
                    continue
                for match in _CONTRACTS_IMPORT_RE.finditer(text):
                    module_name = match.group(1)
                    dep_id = name_to_id.get(module_name)
                    if dep_id and dep_id != plugin_id:
                        deps[plugin_id].add(dep_id)
    return deps


def _topological_sort(deps: dict[str, set[str]]) -> list[str]:
    """Kahn's algorithm. Plugins with no remaining dependencies come first.
    Ties broken alphabetically for deterministic output. Raises on cycles.
    """
    pending = {pid: set(d) for pid, d in deps.items()}
    ready = sorted(pid for pid, d in pending.items() if not d)
    result: list[str] = []
    while ready:
        pid = ready.pop(0)
        result.append(pid)
        for other, other_deps in pending.items():
            if pid not in other_deps:
                continue
            other_deps.discard(pid)
            if not other_deps and other not in result and other not in ready:
                ready.append(other)
                ready.sort()
    if len(result) != len(pending):
        unresolved = [p for p in pending if p not in result]
        raise RuntimeError(
            f"cross-plugin schema dependency cycle among: {sorted(unresolved)}"
        )
    return result


def _to_pascal(name: str) -> str:
    """PascalCase, splitting on both `-` and `_` (`cam_off` -> `CamOff`)."""
    parts: list[str] = []
    for hunk in name.split("-"):
        parts.extend(hunk.split("_"))
    return "".join(p.capitalize() for p in parts)


def _import_plugin_file(path: Path) -> Any:
    """Import a plugin-side .py file by absolute path; return the module."""
    mod_name = f"_its_load_{path.parent.parent.name}_{path.parent.name}_{path.stem}".replace("-", "_")
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _siblings_in_module(module: Any, primary_name: str) -> list[str]:
    """Supporting types alongside `primary_name` in `module`.

    If the module declares `__all__`, trust it (this is how cross-plugin shims
    re-export imported names that the `__module__` filter would otherwise drop).
    Otherwise auto-discover locally-defined BaseModel/Enum subclasses; the
    `__module__` check keeps Pydantic's own BaseModel and library classes out.
    """
    declared = getattr(module, "__all__", None)
    if isinstance(declared, (list, tuple)):
        return sorted({name for name in declared if name != primary_name})

    out: list[str] = []
    for attr in dir(module):
        if attr.startswith("_") or attr == primary_name:
            continue
        obj = getattr(module, attr)
        if not isinstance(obj, type):
            continue
        if getattr(obj, "__module__", "") != module.__name__:
            continue
        if (issubclass(obj, BaseModel) and obj is not BaseModel) or (
            issubclass(obj, Enum) and obj is not Enum
        ):
            out.append(attr)
    return sorted(out)


def _load_model(schema_path: Path) -> type[BaseModel]:
    """Import the schema file and return the BaseModel named after the file
    (`tick.py` -> `Tick`). Other BaseModels in the file are fine (Pydantic
    handles them via $defs) but only the filename-matching class is re-exported.
    """
    stream_name = schema_path.stem
    expected = _to_pascal(stream_name)
    module = _import_plugin_file(schema_path)
    model = getattr(module, expected, None)
    if not isinstance(model, type) or not issubclass(model, BaseModel):
        raise ValueError(
            f"{schema_path} must export a Pydantic BaseModel named {expected!r}"
        )
    return model


def _load_command(command_path: Path) -> type[BaseModel]:
    """Import a command file and return its `<Verb>Command` class (`reset.py` ->
    `ResetCommand`), whose fields are the request shape. An optional nested
    `class Response(BaseModel)` describes the per-instance reply.
    """
    verb = command_path.stem
    expected = _to_pascal(verb) + "Command"
    module = _import_plugin_file(command_path)
    model = getattr(module, expected, None)
    if not isinstance(model, type) or not issubclass(model, BaseModel):
        raise ValueError(
            f"{command_path} must export a Pydantic BaseModel named {expected!r}"
        )
    return model


def _command_response(cmd: type[BaseModel]) -> type[BaseModel] | None:
    """Return the nested Response class if present, else None."""
    resp = getattr(cmd, "Response", None)
    if isinstance(resp, type) and issubclass(resp, BaseModel):
        return resp
    return None


def _load_global(global_path: Path) -> type[BaseModel]:
    """Import a global file and return its top-level class (`timer.py` ->
    `Timer`), whose fields are the value shape stored in KV.
    """
    name = global_path.stem
    expected = _to_pascal(name)
    module = _import_plugin_file(global_path)
    model = getattr(module, expected, None)
    if not isinstance(model, type) or not issubclass(model, BaseModel):
        raise ValueError(
            f"{global_path} must export a Pydantic BaseModel named {expected!r}"
        )
    return model


def _strip_ts_header(text: str) -> str:
    """Strip json2ts's boilerplate header from subsequent files."""
    lines = text.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if line.startswith("export "):
            return "".join(lines[i:])
    return text


def _json2ts_command(contracts_dir: Path) -> list[str]:
    """Locate json2ts: contracts package's node_modules first, then the
    workspace root's pnpm-hoisted .pnpm/node_modules/.bin/ location."""
    ws_root = contracts_dir
    while ws_root != ws_root.parent:
        if (ws_root / "pnpm-workspace.yaml").exists():
            break
        ws_root = ws_root.parent

    candidates = [
        contracts_dir / "node_modules" / ".bin" / "json2ts.cmd",
        contracts_dir / "node_modules" / ".bin" / "json2ts",
        ws_root / "node_modules" / ".pnpm" / "node_modules" / ".bin" / "json2ts.cmd",
        ws_root / "node_modules" / ".pnpm" / "node_modules" / ".bin" / "json2ts",
        ws_root / "node_modules" / ".bin" / "json2ts.cmd",
        ws_root / "node_modules" / ".bin" / "json2ts",
    ]
    for path in candidates:
        if path.exists():
            return [str(path)]
    raise RuntimeError(
        f"json2ts not found in {contracts_dir}/node_modules/.bin/ or workspace root; "
        "run pnpm install in the workspace first"
    )


def _enforce_forbid(node: object) -> None:
    """Recursively set additionalProperties=False on object schemas lacking it.

    Authors opt out top-level via model_config = ConfigDict(extra="allow"), or
    per-nested-model via json_schema_extra={"additionalProperties": True}; the
    walker leaves explicit values alone.
    """
    if isinstance(node, dict):
        if node.get("type") == "object" and "additionalProperties" not in node:
            node["additionalProperties"] = False
        for value in node.values():
            _enforce_forbid(value)
    elif isinstance(node, list):
        for item in node:
            _enforce_forbid(item)


def _allows_null(prop_schema: object) -> bool:
    """Whether a property's type includes null (the wire marker for a genuinely
    optional field)."""
    if not isinstance(prop_schema, dict):
        return False
    t = prop_schema.get("type")
    if t == "null":
        return True
    if isinstance(t, list) and "null" in t:
        return True
    for combinator in ("anyOf", "oneOf"):
        for branch in prop_schema.get(combinator, []) or []:
            if _allows_null(branch):
                return True
    return False


def _enforce_required(node: object) -> None:
    """Recursively mark every non-nullable property as required.

    Pydantic only marks no-default fields required, which leaks `field?: T` into
    the TS type and forces `t.field ?? default` at every consumer. On the wire
    every packet carries every field (Pydantic serializes defaults), so tighten
    it: non-nullable properties become required. Genuinely optional fields are
    declared `T | None = None` and carry `"null"` in their type union.
    """
    if isinstance(node, dict):
        if node.get("type") == "object" and "properties" in node:
            required = list(node.get("required", []))
            seen = set(required)
            for name, schema in node["properties"].items():
                if name in seen:
                    continue
                if _allows_null(schema):
                    continue
                required.append(name)
                seen.add(name)
            if required:
                node["required"] = required
        for value in node.values():
            _enforce_required(value)
    elif isinstance(node, list):
        for item in node:
            _enforce_required(item)


def _derive_schema(model: type[BaseModel]) -> dict:
    """Pydantic schema, strict-by-default. Authors opt out of
    additionalProperties=false via ConfigDict(extra="allow"). Defaulted fields
    are required on the wire; declare `T | None = None` for genuinely optional.
    """
    schema = model.model_json_schema()
    if model.model_config.get("extra") != "allow":
        _enforce_forbid(schema)
    _enforce_required(schema)
    return schema


def derive_schema(plugin_id: str, stream: str, plugins_dir: Path) -> dict:
    """Public: derive the JSON Schema for one (plugin, stream) without writing files."""
    schema_path = plugins_dir / plugin_id / "schemas" / f"{stream}.py"
    if not schema_path.exists():
        raise FileNotFoundError(f"no schema at {schema_path}")
    return _derive_schema(_load_model(schema_path))


def _run_json2ts(json2ts: list[str], schema: dict) -> str:
    result = subprocess.run(
        json2ts,
        input=json.dumps(schema),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"json2ts failed for schema {schema.get('title') or '<unknown>'} "
            f"(exit {result.returncode}):\nSTDERR: {result.stderr}\n"
            f"SCHEMA: {json.dumps(schema, indent=2)[:500]}"
        )
    return result.stdout


def _generate_typescript(
    plugin_id: str,
    py_paths: list[Path],
    command_paths: list[Path],
    global_paths: list[Path],
    out_dir: Path,
    contracts_dir: Path,
) -> Path:
    """Pipe each derived JSON Schema through json2ts into one .ts per plugin.
    Streams and globals get plain interfaces; commands get `<Verb>Command` plus
    an optional `namespace <Verb>Command { interface Response {...} }` so the
    reply reads as `<Verb>Command.Response`.

    json2ts runs in a thread pool: each call shells out to Node (~300ms cold
    start on Windows), so parallel generation collapses ~9s of sequential Node
    startups to roughly one.
    """
    json2ts = _json2ts_command(contracts_dir)
    out_path = out_dir / f"{plugin_id}.ts"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # (schema, namespace_wrap_or_none) in emission order. A non-None wrap triggers
    # the `export namespace <Cmd> {...}` post-processing for a command's Response.
    entries: list[tuple[dict, str | None]] = []
    for py_path in py_paths:
        entries.append((_derive_schema(_load_model(py_path)), None))
    for cmd_path in command_paths:
        cmd = _load_command(cmd_path)
        entries.append((_derive_schema(cmd), None))
        response_cls = _command_response(cmd)
        if response_cls is not None:
            entries.append((_derive_schema(response_cls), cmd.__name__))
    for global_path in global_paths:
        entries.append((_derive_schema(_load_global(global_path)), None))

    # Fan out, gather in submission order. max_workers caps concurrent node.exe.
    with ThreadPoolExecutor(max_workers=8) as pool:
        bodies = list(pool.map(lambda s: _run_json2ts(json2ts, s), [e[0] for e in entries]))

    chunks: list[str] = [_HEADER_TS]
    first = True
    for body, (_, wrap_name) in zip(bodies, entries):
        if wrap_name is not None:
            inner = _strip_ts_header(body)
            indented = "".join(
                "  " + line if line.strip() else line for line in inner.splitlines(keepends=True)
            )
            chunks.append(f"export namespace {wrap_name} {{\n{indented}}}\n")
        else:
            chunks.append(body if first else _strip_ts_header(body))
        first = False

    out_path.write_text("".join(chunks), encoding="utf-8")
    return out_path


def _generate_reexport(
    plugin_id: str,
    py_paths: list[Path],
    command_paths: list[Path],
    global_paths: list[Path],
    out_dir: Path,
) -> Path:
    """Write the its_contracts.<plugin_module>.py re-export shim.

    Streams re-export as their PascalCase name (`Tick`); commands as
    `<Verb>Command` carrying the nested `.Response` attr; globals as the
    PascalCase of their filename.
    """
    module_name = plugin_id.replace("-", "_")
    out_path = out_dir / f"{module_name}.py"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    lines: list[str] = [
        _HEADER_PY,
        "from its_contracts._loader import load_command_module, load_global_module, load_schema_module\n",
        "\n",
    ]
    exports: list[str] = []

    def _emit(loader: str, plugin: str, name: str, primary: str, siblings: list[str]) -> None:
        # Bind the module to one underscore-prefixed temp so siblings don't reload it.
        mod_var = f"_m_{loader.split('_')[1]}_{name}".replace("-", "_")
        lines.append(f'{mod_var} = {loader}("{plugin}", "{name}")\n')
        lines.append(f'{primary} = {mod_var}.{primary}\n')
        exports.append(primary)
        for sib in siblings:
            lines.append(f'{sib} = {mod_var}.{sib}\n')
            exports.append(sib)

    for py_path in py_paths:
        stream = py_path.stem
        primary = _to_pascal(stream)
        module = _import_plugin_file(py_path)
        _emit("load_schema_module", plugin_id, stream, primary, _siblings_in_module(module, primary))
    for cmd_path in command_paths:
        verb = cmd_path.stem
        primary = _to_pascal(verb) + "Command"
        module = _import_plugin_file(cmd_path)
        _emit("load_command_module", plugin_id, verb, primary, _siblings_in_module(module, primary))
    for global_path in global_paths:
        name = global_path.stem
        primary = _to_pascal(name)
        module = _import_plugin_file(global_path)
        _emit("load_global_module", plugin_id, name, primary, _siblings_in_module(module, primary))
    lines.append("\n")
    lines.append(f"__all__ = {exports!r}\n")
    out_path.write_text("".join(lines), encoding="utf-8")
    return out_path


def _format_annotation(ann: object) -> str:
    """Best-effort annotation string for .pyi emission. Bare classes get their
    __name__ (nested user classes appear unqualified); everything else falls
    back to inspect.formatannotation.
    """
    if isinstance(ann, type):
        return ann.__name__
    try:
        return inspect.formatannotation(ann)
    except Exception:
        return "object"


def _emit_pyi_sibling(name: str, obj: Any) -> list[str]:
    """.pyi emitter for a re-exported sibling: BaseModels get a field stub,
    Enums get a member-list stub so checkers see `AlertLevel.INFO`."""
    if isinstance(obj, type) and issubclass(obj, BaseModel) and obj is not BaseModel:
        return _emit_pyi_class(name, obj)
    if isinstance(obj, type) and issubclass(obj, Enum) and obj is not Enum:
        # Only the direct parent (e.g. StrEnum); the full MRO yields redundant
        # bases like (StrEnum, str, ReprEnum, Enum) that linters dislike.
        base_name = obj.__mro__[1].__name__ if len(obj.__mro__) > 1 else "Enum"
        lines = [f"class {name}({base_name}):\n"]
        for member in obj:
            lines.append(f"    {member.name}: {name}\n")
        lines.append("\n")
        return lines
    return []  # unknown shape; runtime re-export still works


def _emit_pyi_class(
    class_name: str,
    model: type[BaseModel],
    nested: list[tuple[str, type[BaseModel]]] | None = None,
    indent: str = "",
) -> list[str]:
    """Emit a `class Foo(BaseModel): ...` block for a .pyi stub. `nested` emits
    (name, BaseModel) pairs indented in the body (the Command.Response pattern).
    """
    lines: list[str] = [f"{indent}class {class_name}(BaseModel):\n"]
    body_indent = indent + "    "
    if not model.model_fields and not nested:
        lines.append(f"{body_indent}pass\n\n")
        return lines
    for field_name, field_info in model.model_fields.items():
        type_str = _format_annotation(field_info.annotation)
        lines.append(f"{body_indent}{field_name}: {type_str}\n")
    if nested:
        for nested_name, nested_model in nested:
            lines.append("\n")
            lines.extend(_emit_pyi_class(nested_name, nested_model, indent=body_indent))
    lines.append("\n")
    return lines


def _generate_pyi_stub(
    plugin_id: str,
    py_paths: list[Path],
    command_paths: list[Path],
    global_paths: list[Path],
    out_dir: Path,
) -> Path:
    """Write a .pyi sibling next to the re-export .py so type checkers see real
    class signatures. Pylance prefers .pyi for types; runtime loads from .py.
    """
    module_name = plugin_id.replace("-", "_")
    out_path = out_dir / f"{module_name}.pyi"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    lines: list[str] = [
        "# AUTO-GENERATED stub. Static type info for the runtime re-export sibling.\n",
        "from enum import Enum, IntEnum, StrEnum\n",
        "from pydantic import BaseModel\n",
        "\n",
    ]
    def _emit_with_siblings(path: Path, primary_name: str, primary_model: type[BaseModel], nested) -> None:
        module = _import_plugin_file(path)
        # Siblings first so the primary's annotations resolve when checkers read
        # top-to-bottom.
        for sib_name in _siblings_in_module(module, primary_name):
            lines.extend(_emit_pyi_sibling(sib_name, getattr(module, sib_name)))
        lines.extend(_emit_pyi_class(primary_name, primary_model, nested=nested))

    for py_path in py_paths:
        primary_name = _to_pascal(py_path.stem)
        _emit_with_siblings(py_path, primary_name, _load_model(py_path), nested=None)
    for cmd_path in command_paths:
        cmd = _load_command(cmd_path)
        primary_name = _to_pascal(cmd_path.stem) + "Command"
        response = _command_response(cmd)
        nested = [("Response", response)] if response is not None else None
        _emit_with_siblings(cmd_path, primary_name, cmd, nested=nested)
    for global_path in global_paths:
        primary_name = _to_pascal(global_path.stem)
        _emit_with_siblings(global_path, primary_name, _load_global(global_path), nested=None)
    out_path.write_text("".join(lines), encoding="utf-8")
    return out_path


@dataclass(frozen=True)
class _PublishSpec:
    """Minimal mirror of its_core.plugins.PublishSpec; codegen stays self-contained."""
    stream: str
    path: str | None  # None = default to the stream name


def _read_publishes_from_manifest(plugin_dir: Path) -> list[_PublishSpec]:
    """Read [[publishes]] from a plugin's manifest. Returns empty if no manifest."""
    manifest = plugin_dir / "its-plugin.toml"
    if not manifest.exists():
        return []
    with manifest.open("rb") as f:
        data = tomllib.load(f)
    specs: list[_PublishSpec] = []
    for p in data.get("publishes") or []:
        stream = p.get("stream")
        if stream:
            specs.append(_PublishSpec(stream=stream, path=p.get("path")))
    return specs


def _camel_case(name: str) -> str:
    """camelCase, splitting on `-` and `_` (`cam_off` -> `camOff`). Used for
    generated property names like `subjects.timerSource.tick(...)`.
    """
    parts: list[str] = []
    for hunk in name.split("-"):
        parts.extend(hunk.split("_"))
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def _subject_type_name(plugin_id: str, stream: str) -> str:
    """`timer-source` + `tick` -> `TimerSourceTickSubject` (PascalCase type)."""
    parts = plugin_id.split("-") + stream.split("-")
    return "".join(p.capitalize() for p in parts) + "Subject"


def _template_literal_for(plugin_id: str, path: str) -> str:
    r"""Render a TS template literal TYPE from a path template.

    `path="{midas_id}.tlm"` -> `\`its.<plugin>.${string}.${string}.tlm\``
    Every placeholder becomes a `${string}` segment.
    """
    rendered = _PLACEHOLDER_RE.sub("${string}", path)
    return f"`its.{plugin_id}.${{string}}.{rendered}`"


def _runtime_template_for(plugin_id: str, path: str) -> str:
    r"""Render the JS template literal EXPRESSION for the arrow body.

    `path="{midas_id}.tlm"` -> `\`its.<plugin>.${instance}.${args.midas_id}.tlm\``
    """
    def repl(m: re.Match[str]) -> str:
        return "${args." + m.group(1) + "}"
    rendered = _PLACEHOLDER_RE.sub(repl, path)
    return f"`its.{plugin_id}.${{instance}}.{rendered}`"


def _emit_stream_arrow(plugin_id: str, spec: _PublishSpec, type_name: str) -> str:
    r"""One stream's property on the nested `subjects` object: an arrow function.

    Static:  `tick: (instance = '*'): TimerSourceTickSubject => \`...\`,`
    Dynamic: `tlm: (args: {...}, instance = '*'): FeatherTlmSubject => \`...\`,`
    """
    path = spec.path or spec.stream
    placeholders = _PLACEHOLDER_RE.findall(path)
    stream_prop = _camel_case(spec.stream)

    if not placeholders:
        runtime = f"`its.{plugin_id}.${{instance}}.{path}`"
        return (
            f"    {stream_prop}: (instance: string = '*'): {type_name} =>\n"
            f"      {runtime},\n"
        )
    args_type = "{ " + "; ".join(f"{ph}: string" for ph in placeholders) + " }"
    runtime = _runtime_template_for(plugin_id, path)
    return (
        f"    {stream_prop}: (\n"
        f"      args: {args_type},\n"
        f"      instance: string = '*',\n"
        f"    ): {type_name} =>\n"
        f"      {runtime},\n"
    )


def _generate_subjects_ts(
    schemas: dict[str, list[Path]],
    plugins_dir: Path,
    out_dir: Path,
) -> Path:
    """Emit per-stream subject types, the nested `subjects` object, SubjectUnion,
    and SubjectPayload.

    Authors import one `subjects` object mirroring the plugin tree:
    `subjects.<plugin>.<stream>(...)`. Path templates come from each manifest's
    [[publishes]]; schemas without a [[publishes]] entry get a default static spec.
    """
    out_path = out_dir / "_subjects.ts"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    lines: list[str] = [_HEADER_TS]

    if not schemas:
        lines.append("export const subjects = {} as const;\n")
        lines.append("export type SubjectUnion = string;\n")
        lines.append("export type SubjectPayload<S extends SubjectUnion> = unknown;\n")
        out_path.write_text("".join(lines), encoding="utf-8")
        return out_path

    # Cross-reference [[publishes]] with the schemas dir; schema-only streams get
    # a default static spec.
    plugin_publishes: dict[str, list[_PublishSpec]] = {}
    for plugin_id in schemas:
        specs = _read_publishes_from_manifest(plugins_dir / plugin_id)
        schema_stems = {p.stem for p in schemas[plugin_id]}
        kept = [s for s in specs if s.stream in schema_stems]
        declared = {s.stream for s in kept}
        for stem in sorted(schema_stems - declared):
            kept.append(_PublishSpec(stream=stem, path=None))
        plugin_publishes[plugin_id] = kept

    for plugin_id in sorted(plugin_publishes):
        if not plugin_publishes[plugin_id]:
            continue
        type_names = sorted({_to_pascal(s.stream) for s in plugin_publishes[plugin_id]})
        lines.append(
            f"import type {{ {', '.join(type_names)} }} from './{plugin_id}';\n"
        )
    lines.append("\n")

    all_subjects: list[tuple[str, str]] = []  # (subject_type, payload_type)
    for plugin_id in sorted(plugin_publishes):
        for spec in plugin_publishes[plugin_id]:
            subject_type = _subject_type_name(plugin_id, spec.stream)
            payload_type = _to_pascal(spec.stream)
            all_subjects.append((subject_type, payload_type))
            path = spec.path or spec.stream
            lines.append(
                f"export type {subject_type} = {_template_literal_for(plugin_id, path)};\n"
            )
    lines.append("\n")

    lines.append("export const subjects = {\n")
    for plugin_id in sorted(plugin_publishes):
        if not plugin_publishes[plugin_id]:
            continue
        plugin_prop = _camel_case(plugin_id)
        lines.append(f"  {plugin_prop}: {{\n")
        for spec in plugin_publishes[plugin_id]:
            subject_type = _subject_type_name(plugin_id, spec.stream)
            lines.append(_emit_stream_arrow(plugin_id, spec, subject_type))
        lines.append("  },\n")
    lines.append("};\n\n")

    lines.append("export type SubjectUnion =\n")
    for i, (st, _) in enumerate(all_subjects):
        terminator = ";" if i == len(all_subjects) - 1 else ""
        lines.append(f"  | {st}{terminator}\n")
    lines.append("\n")

    # Nested conditional resolving payload type from subject type.
    lines.append("export type SubjectPayload<S extends SubjectUnion> =\n")
    for st, pt in all_subjects:
        lines.append(f"  S extends {st} ? {pt} :\n")
    lines.append("  never;\n")

    out_path.write_text("".join(lines), encoding="utf-8")
    return out_path


def _generate_commands_ts(
    commands: dict[str, list[Path]],
    plugins_dir: Path,
    out_dir: Path,
) -> Path:
    """Emit `_commands.ts`: descriptor builders + payload-extraction types.

    Every verb gets an overloaded builder; arity at the call site picks the mode:
      commands.timerSource.reset()         -> BroadcastDescriptor<Req>
      commands.timerSource.reset(instance) -> CommandDescriptor<Req, Res>
    Plugins subscribe to both subjects so either form is handled.
    """
    out_path = out_dir / "_commands.ts"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    lines: list[str] = [_HEADER_TS]
    # Descriptor types are constant; emit once at the top.
    lines.append(
        "export type CommandDescriptor<Req, Res> = {\n"
        "  subject: string;\n"
        "  broadcast: false;\n"
        "  __req?: Req;\n"
        "  __res?: Res;\n"
        "};\n"
        "export type BroadcastDescriptor<Req> = {\n"
        "  subject: string;\n"
        "  broadcast: true;\n"
        "  __req?: Req;\n"
        "};\n"
        "\n"
    )

    if not commands:
        lines.append("export const commands = {} as const;\n")
        out_path.write_text("".join(lines), encoding="utf-8")
        return out_path

    plugin_commands: dict[str, list[tuple[str, bool]]] = {}  # plugin -> [(verb, has_response)]
    for plugin_id, paths in commands.items():
        entries: list[tuple[str, bool]] = []
        for p in paths:
            cmd_cls = _load_command(p)
            entries.append((p.stem, _command_response(cmd_cls) is not None))
        plugin_commands[plugin_id] = entries

    # Import each command's Request type; Response is reached through the namespace.
    for plugin_id in sorted(plugin_commands):
        if not plugin_commands[plugin_id]:
            continue
        type_names = sorted({
            _to_pascal(verb) + "Command" for verb, _ in plugin_commands[plugin_id]
        })
        lines.append(f"import type {{ {', '.join(type_names)} }} from './{plugin_id}';\n")
    lines.append("\n")

    lines.append("export const commands = {\n")
    for plugin_id in sorted(plugin_commands):
        if not plugin_commands[plugin_id]:
            continue
        plugin_prop = _camel_case(plugin_id)
        lines.append(f"  {plugin_prop}: {{\n")
        for verb, has_response in plugin_commands[plugin_id]:
            verb_prop = _camel_case(verb)
            req_type = _to_pascal(verb) + "Command"
            res_type = f"{req_type}.Response" if has_response else "void"
            broadcast_runtime = f"`its.cmd.{plugin_id}.{verb}`"
            instance_runtime = f"`its.cmd.{plugin_id}.${{instance}}.{verb}`"
            # Overload via function-type intersection; call-site arity picks the descriptor.
            lines.append(
                f"    {verb_prop}: ((instance?: string) =>\n"
                f"      instance === undefined\n"
                f"        ? {{ subject: {broadcast_runtime}, broadcast: true }}\n"
                f"        : {{ subject: {instance_runtime}, broadcast: false }}) as {{\n"
                f"      (): BroadcastDescriptor<{req_type}>;\n"
                f"      (instance: string): CommandDescriptor<{req_type}, {res_type}>;\n"
                f"    }},\n"
            )
        lines.append("  },\n")
    lines.append("};\n")

    out_path.write_text("".join(lines), encoding="utf-8")
    return out_path


def _generate_globals_ts(
    global_defs: dict[str, list[Path]],
    out_dir: Path,
) -> Path:
    """Emit `_globals.ts`: typed descriptor tree for shared KV state. Each leaf is
    a `GlobalDescriptor<T>` with the bus key plus `.update()` / `.read()` over the
    WS bridge; `useGlobal(descriptor)` extracts `T` via the phantom `__value`.
    """
    out_path = out_dir / "_globals.ts"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    lines: list[str] = [_HEADER_TS]
    # Descriptor methods call the WS bridge, but @its/sdk-react depends on
    # @its/contracts, so importing it here would cycle. sdk-react instead injects
    # the bridge on load via _installGlobalsBridge() and the methods read it from
    # module state at call time.
    lines.append(
        "export type GlobalDescriptor<T> = {\n"
        "  key: string;\n"
        "  __value?: T;\n"
        "  update(value: T): void;\n"
        "  read(): Promise<T | null>;\n"
        "};\n"
        "\n"
        "type BridgeGet = (key: string) => Promise<unknown | null>;\n"
        "type BridgeSet = (key: string, value: unknown) => void;\n"
        "let _get: BridgeGet | null = null;\n"
        "let _set: BridgeSet | null = null;\n"
        "\n"
        "export function _installGlobalsBridge(get: BridgeGet, set: BridgeSet): void {\n"
        "  _get = get;\n"
        "  _set = set;\n"
        "}\n"
        "\n"
        "function _need<T>(fn: T | null, what: string): T {\n"
        "  if (!fn) throw new Error(\n"
        "    `Globals bridge (${what}) not installed; ensure @its/sdk-react is imported`,\n"
        "  );\n"
        "  return fn;\n"
        "}\n"
        "\n"
        "function makeGlobal<T>(key: string): GlobalDescriptor<T> {\n"
        "  return {\n"
        "    key,\n"
        "    update(value: T): void { _need(_set, 'set')(key, value); },\n"
        "    read(): Promise<T | null> { return _need(_get, 'get')(key) as Promise<T | null>; },\n"
        "  };\n"
        "}\n"
        "\n"
    )

    if not global_defs:
        lines.append("export const globals = {} as const;\n")
        out_path.write_text("".join(lines), encoding="utf-8")
        return out_path

    for plugin_id in sorted(global_defs):
        if not global_defs[plugin_id]:
            continue
        type_names = sorted({_to_pascal(p.stem) for p in global_defs[plugin_id]})
        lines.append(f"import type {{ {', '.join(type_names)} }} from './{plugin_id}';\n")
    lines.append("\n")

    lines.append("export const globals = {\n")
    for plugin_id in sorted(global_defs):
        if not global_defs[plugin_id]:
            continue
        plugin_prop = _camel_case(plugin_id)
        lines.append(f"  {plugin_prop}: {{\n")
        for path in global_defs[plugin_id]:
            name = path.stem
            type_name = _to_pascal(name)
            key = f"{plugin_id}.{name}"
            lines.append(
                f"    {_camel_case(name)}: makeGlobal<{type_name}>('{key}'),\n"
            )
        lines.append("  },\n")
    lines.append("};\n")

    out_path.write_text("".join(lines), encoding="utf-8")
    return out_path


# Content-hash cache: each artifact records the SHA256 of its inputs; a matching
# hash with the output still present skips the work. codegen.py's own bytes feed
# every fingerprint, so a logic change forces a full rebuild.
_CACHE_FILENAME = ".codegen-cache.json"
_CODEGEN_SELF = Path(__file__)


def _cache_path(contracts_dir: Path) -> Path:
    return contracts_dir / _CACHE_FILENAME


def _load_cache(contracts_dir: Path) -> dict[str, str]:
    p = _cache_path(contracts_dir)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _save_cache(contracts_dir: Path, cache: dict[str, str]) -> None:
    p = _cache_path(contracts_dir)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cache, indent=2, sort_keys=True), encoding="utf-8")


def _fingerprint(*inputs: bytes | Path) -> str:
    h = hashlib.sha256()
    # codegen.py's own bytes feed every fingerprint (see _CACHE_FILENAME note).
    h.update(_CODEGEN_SELF.read_bytes())
    for item in inputs:
        if isinstance(item, Path):
            h.update(b"\x00")
            h.update(str(item).encode("utf-8"))
            h.update(b"\x00")
            h.update(item.read_bytes() if item.exists() else b"")
        else:
            h.update(b"\x00")
            h.update(item)
    return h.hexdigest()


@dataclass(frozen=True)
class CodegenResult:
    """Return value of generate_all. `outputs` is the per-plugin path dict;
    `regenerated` counts files actually re-emitted (vs cache hits); `total` is
    every output file the run owns (per-plugin + the 3 workspace files), for
    "N of M" log lines."""

    outputs: dict[str, list[Path]]
    regenerated: int
    total: int


def generate_all(plugins_dir: Path, contracts_dir: Path) -> CodegenResult:
    """Scan, derive JSON, generate TS, and write re-exports per plugin.

    Outputs are fingerprinted; matching fingerprint + on-disk output skips. First
    run populates the cache; subsequent no-change runs complete in sub-100ms.
    """
    py_out = contracts_dir / "src" / "its_contracts"
    ts_out = contracts_dir / "types"

    schemas = discover_schemas(plugins_dir)
    commands = discover_commands(plugins_dir)
    global_defs = discover_globals(plugins_dir)
    all_plugin_ids = sorted(set(schemas) | set(commands) | set(global_defs))
    cache = _load_cache(contracts_dir)
    regenerated = 0

    # Topo-order so a plugin's `from its_contracts.<other> import X` resolves at
    # introspection time (dependees first).
    deps = _scan_plugin_deps(plugins_dir, all_plugin_ids)
    ordered_plugin_ids = _topological_sort(deps)

    def _run_if_changed(out_path: Path, fingerprint: str, generator) -> Path:
        nonlocal regenerated
        if cache.get(str(out_path)) == fingerprint and out_path.exists():
            return out_path
        path = generator()
        cache[str(out_path)] = fingerprint
        regenerated += 1
        return path

    outputs: dict[str, list[Path]] = {}
    for plugin_id in ordered_plugin_ids:
        py_paths = schemas.get(plugin_id, [])
        cmd_paths = commands.get(plugin_id, [])
        glb_paths = global_defs.get(plugin_id, [])

        # All three per-plugin outputs share the same Python sources; the manifest
        # joins in because [[publishes]] path templates feed the TS file.
        manifest_path = plugins_dir / plugin_id / "its-plugin.toml"
        plugin_fp = _fingerprint(*py_paths, *cmd_paths, *glb_paths, manifest_path)

        module_name = plugin_id.replace("-", "_")
        reexport_path = py_out / f"{module_name}.py"
        pyi_path = py_out / f"{module_name}.pyi"
        ts_path = ts_out / f"{plugin_id}.ts"

        # Two-pass: write a schemas-only re-export first so commands/globals that
        # reference schema classes via its_contracts.<plugin> resolve when
        # introspected; the full re-export below overwrites it in the same run.
        needs_regen = (
            cache.get(str(reexport_path)) != plugin_fp
            or not reexport_path.exists()
        )
        if needs_regen and py_paths and (cmd_paths or glb_paths):
            _generate_reexport(plugin_id, py_paths, [], [], py_out)
            importlib.invalidate_caches()

        outputs[plugin_id] = [
            _run_if_changed(reexport_path, plugin_fp, lambda: _generate_reexport(plugin_id, py_paths, cmd_paths, glb_paths, py_out)),
            _run_if_changed(pyi_path, plugin_fp, lambda: _generate_pyi_stub(plugin_id, py_paths, cmd_paths, glb_paths, py_out)),
            _run_if_changed(ts_path, plugin_fp, lambda: _generate_typescript(plugin_id, py_paths, cmd_paths, glb_paths, ts_out, contracts_dir)),
        ]
        # Make the fresh re-export visible to later plugins' cross-plugin imports.
        importlib.invalidate_caches()

    # Workspace-wide TS files depend on every plugin's inputs plus the manifests.
    all_manifests = [plugins_dir / pid / "its-plugin.toml" for pid in all_plugin_ids]
    all_schema_paths = [p for paths in schemas.values() for p in paths]
    all_command_paths = [p for paths in commands.values() for p in paths]
    all_global_paths = [p for paths in global_defs.values() for p in paths]

    subjects_path = ts_out / "_subjects.ts"
    subjects_fp = _fingerprint(*all_schema_paths, *all_manifests)
    _run_if_changed(subjects_path, subjects_fp, lambda: _generate_subjects_ts(schemas, plugins_dir, ts_out))

    commands_path = ts_out / "_commands.ts"
    commands_fp = _fingerprint(*all_command_paths, *all_manifests)
    _run_if_changed(commands_path, commands_fp, lambda: _generate_commands_ts(commands, plugins_dir, ts_out))

    globals_path = ts_out / "_globals.ts"
    globals_fp = _fingerprint(*all_global_paths)
    _run_if_changed(globals_path, globals_fp, lambda: _generate_globals_ts(global_defs, ts_out))

    _save_cache(contracts_dir, cache)
    total = sum(len(v) for v in outputs.values()) + 3  # +_subjects, _commands, _globals
    return CodegenResult(outputs=outputs, regenerated=regenerated, total=total)
