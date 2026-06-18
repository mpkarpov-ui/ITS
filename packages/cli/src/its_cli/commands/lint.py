"""`its lint`: static validation of plugin manifests, schemas, and conventions.

Where `its doctor` checks runtime state, lint walks the source tree for issues
that break codegen or violate conventions. CI-friendly: one pass over every
plugin, no abort on first failure.

Per-plugin checks: manifest parses; every [[publishes]]/[[commands]]/[[globals]]
entry has its backing .py with the expected PascalCase class; every
`from its_contracts.<X> import` resolves to a workspace plugin; conventions
(description set, kebab-case id, package.json name matches id).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import typer
from rich.console import Console

from its_core.plugins import _parse, discover

Status = Literal["ok", "warn", "fail"]


@dataclass
class Finding:
    status: Status
    message: str
    hint: str | None = None


@dataclass
class PluginReport:
    plugin_id: str
    findings: list[Finding] = field(default_factory=list)

    @property
    def n_fail(self) -> int:
        return sum(1 for f in self.findings if f.status == "fail")

    @property
    def n_warn(self) -> int:
        return sum(1 for f in self.findings if f.status == "warn")


app = typer.Typer(
    help="Static validation of plugin manifests, schemas, and conventions.",
    no_args_is_help=False,
    invoke_without_command=True,
)

_PLUGINS_DIR = Path("plugins")
_KEBAB_RE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
_CONTRACTS_IMPORT_RE = re.compile(
    r"^\s*from\s+its_contracts\.([a-z_][a-z0-9_]*)\s+import",
    re.MULTILINE,
)


def _to_pascal(name: str) -> str:
    """PascalCase, splitting on `-` and `_` (`exec_output` -> `ExecOutput`)."""
    parts: list[str] = []
    for hunk in name.split("-"):
        parts.extend(hunk.split("_"))
    return "".join(p.capitalize() for p in parts)


def _has_class(source: str, class_name: str) -> bool:
    """Source-level check for `class <Name>(` / `class <Name>:`, avoiding an
    import (which would need codegen run and cross-plugin types present)."""
    return bool(
        re.search(rf"^\s*class\s+{re.escape(class_name)}\s*[(\:]", source, re.MULTILINE)
    )


def _lint_plugin(
    ws_root: Path,
    plugin_dir: Path,
    all_plugin_ids: set[str],
) -> PluginReport:
    """Run every static check against one plugin, capturing the manifest parse
    error instead of re-raising so the run continues."""
    report = PluginReport(plugin_id=plugin_dir.name)
    manifest_path = plugin_dir / "its-plugin.toml"
    if not manifest_path.exists():
        report.findings.append(
            Finding("fail", "no its-plugin.toml in plugin dir")
        )
        return report

    # Reuse the platform parser so we catch the same errors `its dev` would.
    try:
        manifest = _parse(manifest_path)
    except ValueError as exc:
        report.findings.append(
            Finding("fail", f"manifest invalid: {exc}", hint="fix its-plugin.toml")
        )
        return report

    if not _KEBAB_RE.match(manifest.id):
        report.findings.append(
            Finding(
                "warn",
                f"id {manifest.id!r} is not kebab-case (lowercase letters/digits joined with `-`)",
            )
        )

    if not manifest.description:
        report.findings.append(
            Finding("warn", "manifest is missing a description")
        )

    # Each declared schema/command/global has a backing .py with the expected class.
    for spec in manifest.publishes:
        report.findings.extend(
            _check_artifact(plugin_dir, "schemas", spec.stream, _to_pascal(spec.stream))
        )
    for spec in manifest.commands:
        report.findings.extend(
            _check_artifact(
                plugin_dir, "commands", spec.verb, _to_pascal(spec.verb) + "Command"
            )
        )
    for spec in manifest.globals:
        report.findings.extend(
            _check_artifact(
                plugin_dir, "globals", spec.name, _to_pascal(spec.name)
            )
        )

    report.findings.extend(_check_cross_plugin_imports(plugin_dir, all_plugin_ids))

    pkg_json = plugin_dir / "package.json"
    if pkg_json.exists():
        try:
            import json

            pkg = json.loads(pkg_json.read_text(encoding="utf-8"))
            expected = f"@its/{manifest.id}"
            if pkg.get("name") != expected:
                report.findings.append(
                    Finding(
                        "warn",
                        f"package.json name is {pkg.get('name')!r}; expected {expected!r}",
                    )
                )
        except (OSError, ValueError) as exc:
            report.findings.append(
                Finding("warn", f"package.json unreadable: {exc}")
            )

    return report


def _check_artifact(
    plugin_dir: Path,
    kind: str,
    stem: str,
    expected_class: str,
) -> list[Finding]:
    """Verify the declared stream/verb/global's .py exists and defines the
    expected PascalCase class."""
    path = plugin_dir / kind / f"{stem}.py"
    relpath = path.relative_to(plugin_dir.parent.parent) if path.is_absolute() else path
    if not path.exists():
        return [
            Finding(
                "fail",
                f"{kind[:-1]} {stem!r} declared but {relpath} is missing",
                hint=f"create {relpath} exporting `class {expected_class}(...)`",
            )
        ]
    try:
        source = path.read_text(encoding="utf-8")
    except OSError as exc:
        return [Finding("fail", f"{relpath} unreadable: {exc}")]

    # Accept a local class def or an explicit __all__ re-export (shim pattern).
    if _has_class(source, expected_class):
        return []
    if "__all__" in source and f"'{expected_class}'" in source or f'"{expected_class}"' in source:
        return []
    return [
        Finding(
            "fail",
            f"{relpath} does not define `class {expected_class}` and does not re-export it via __all__",
            hint=f"rename the class to {expected_class} or add it to __all__",
        )
    ]


def _check_cross_plugin_imports(
    plugin_dir: Path, all_plugin_ids: set[str]
) -> list[Finding]:
    findings: list[Finding] = []
    expected_modules = {pid.replace("-", "_") for pid in all_plugin_ids}
    for sub in ("schemas", "commands", "globals"):
        sub_dir = plugin_dir / sub
        if not sub_dir.exists():
            continue
        for py in sub_dir.glob("*.py"):
            if py.name == "__init__.py":
                continue
            try:
                source = py.read_text(encoding="utf-8")
            except OSError:
                continue
            for match in _CONTRACTS_IMPORT_RE.finditer(source):
                ref_mod = match.group(1)
                if ref_mod not in expected_modules:
                    findings.append(
                        Finding(
                            "fail",
                            f"{py.relative_to(plugin_dir.parent.parent)} imports "
                            f"from its_contracts.{ref_mod} but no plugin with that id exists",
                            hint=f"check the import target, or add the missing plugin",
                        )
                    )
    return findings


def _summarize_plugin(report: PluginReport) -> str:
    """One-line ok summary when the plugin has no issues at all."""
    return f"manifest clean, all declared artifacts resolve"


def _print_report(console: Console, reports: list[PluginReport]) -> None:
    style_for = {
        "ok": "[green]ok[/green]  ",
        "warn": "[yellow]warn[/yellow]",
        "fail": "[red]fail[/red]",
    }
    for report in reports:
        console.print(f"\n[bold]{report.plugin_id}[/bold]")
        if not report.findings:
            console.print(f"  {style_for['ok']}  {_summarize_plugin(report)}")
            continue
        for f in report.findings:
            console.print(f"  {style_for[f.status]}  {f.message}")
            if f.hint:
                console.print(f"        [dim]hint:[/dim] [cyan]{f.hint}[/cyan]")


@app.callback(invoke_without_command=True)
def _root(
    ctx: typer.Context,
    plugin: str = typer.Option(
        None,
        "--plugin",
        "-p",
        help="Lint just one plugin by id.",
    ),
) -> None:
    """Walk every plugin in plugins/ and run static validation. Exits
    non-zero if any plugin has a FAIL finding."""
    if ctx.invoked_subcommand is not None:
        return

    console = Console()
    if not _PLUGINS_DIR.exists():
        console.print("[red]plugins/ directory not found - run from workspace root[/red]")
        raise typer.Exit(code=1)

    # Discover first so cross-plugin import checks know the workspace.
    try:
        manifests = discover(_PLUGINS_DIR)
    except Exception:
        manifests = []  # per-plugin lints still run their own manifest checks
    all_ids = {m.id for m in manifests}

    plugin_dirs = sorted(
        d for d in _PLUGINS_DIR.iterdir()
        if d.is_dir() and (d / "its-plugin.toml").exists()
    )
    if plugin:
        plugin_dirs = [d for d in plugin_dirs if d.name == plugin]
        if not plugin_dirs:
            console.print(f"[red]no plugin with id {plugin!r}[/red]")
            raise typer.Exit(code=1)

    ws_root = _PLUGINS_DIR.resolve().parent
    reports = [_lint_plugin(ws_root, d, all_ids) for d in plugin_dirs]

    console.print("[bold]ITS LINT[/bold]")
    _print_report(console, reports)

    n_fail = sum(r.n_fail for r in reports)
    n_warn = sum(r.n_warn for r in reports)
    console.print()
    if n_fail:
        console.print(
            f"[red]{n_fail} error{'s' if n_fail != 1 else ''}[/red], "
            f"[yellow]{n_warn} warning{'s' if n_warn != 1 else ''}[/yellow] "
            f"across {len(reports)} plugin{'s' if len(reports) != 1 else ''}"
        )
        raise typer.Exit(code=1)
    if n_warn:
        console.print(
            f"[yellow]0 errors, {n_warn} warning{'s' if n_warn != 1 else ''}[/yellow] "
            f"across {len(reports)} plugin{'s' if len(reports) != 1 else ''}"
        )
    else:
        console.print(
            f"[green]{len(reports)} plugin{'s' if len(reports) != 1 else ''} clean[/green]"
        )
