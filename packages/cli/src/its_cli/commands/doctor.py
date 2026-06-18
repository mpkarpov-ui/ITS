"""`its doctor`: pre-flight diagnostic. Reports OK/WARN/FAIL with a hint per
finding; exits non-zero only on FAIL so it composes into scripts.

Sections: workspace shape, Python venv installs, JS workspace, codegen output,
and runtime (NATS + HTTP port read jointly; only inconsistent combinations flag).
"""

from __future__ import annotations

import os
import socket
import time
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import typer
from rich.console import Console

from its_core.plugins import PluginManifest, discover

Status = Literal["ok", "warn", "fail"]


@dataclass
class Result:
    section: str
    status: Status
    message: str
    hint: str | None = None


def _find_workspace_root(start: Path | None = None) -> Path:
    cur = (start or Path.cwd()).resolve()
    while cur != cur.parent:
        if (cur / "pnpm-workspace.yaml").exists():
            return cur
        cur = cur.parent
    raise RuntimeError("not inside an ITS workspace (no pnpm-workspace.yaml above cwd)")


def _check_workspace(ws_root: Path) -> tuple[list[Result], list[PluginManifest]]:
    out: list[Result] = [
        Result("Workspace", "ok", f"root: {ws_root}"),
        Result("Workspace", "ok", "pnpm-workspace.yaml present"),
    ]
    plugins_dir = ws_root / "plugins"
    if not plugins_dir.exists():
        out.append(Result("Workspace", "fail", "plugins/ dir missing"))
        return out, []
    try:
        manifests = discover(plugins_dir)
    except Exception as exc:
        out.append(Result("Workspace", "fail", f"plugin discovery raised: {exc}"))
        return out, []
    out.append(
        Result(
            "Workspace",
            "ok",
            f"{len(manifests)} plugin{'s' if len(manifests) != 1 else ''} discovered, all manifests parse",
        )
    )
    return out, manifests


def _expected_workspace_members(ws_root: Path) -> set[str]:
    """pyproject package names of every Python workspace member that should be
    editably installed in .venv."""
    pyproj = tomllib.loads((ws_root / "pyproject.toml").read_text(encoding="utf-8"))
    cfg = pyproj.get("tool", {}).get("uv", {}).get("workspace", {})
    includes = cfg.get("members") or []
    excludes_paths: set[Path] = set()
    for pat in cfg.get("exclude") or []:
        for path in ws_root.glob(pat):
            excludes_paths.add(path.resolve())

    names: set[str] = set()
    for pat in includes:
        for path in ws_root.glob(pat):
            if not path.is_dir():
                continue
            if path.resolve() in excludes_paths:
                continue
            pp = path / "pyproject.toml"
            if not pp.exists():
                continue
            meta = tomllib.loads(pp.read_text(encoding="utf-8"))
            name = meta.get("project", {}).get("name")
            if name:
                names.add(name)
    return names


def _check_venv(ws_root: Path) -> list[Result]:
    venv = ws_root / ".venv"
    if not venv.exists():
        return [Result("Python venv", "fail", ".venv missing", hint="run `uv sync`")]

    pth_files = list(venv.glob("**/_editable_impl_*.pth"))
    installed = {p.stem.removeprefix("_editable_impl_") for p in pth_files}

    expected_pkgs = _expected_workspace_members(ws_root)
    # .pth files use module names (dashes -> underscores).
    expected_mods = {pkg.replace("-", "_") for pkg in expected_pkgs}

    missing = sorted(expected_mods - installed)
    if missing:
        return [
            Result("Python venv", "ok", ".venv present"),
            Result(
                "Python venv",
                "fail",
                f"missing editable installs: {', '.join(missing)}",
                hint="run `uv sync`",
            ),
        ]
    return [
        Result("Python venv", "ok", ".venv present"),
        Result(
            "Python venv",
            "ok",
            f"{len(expected_mods)} workspace package{'s' if len(expected_mods) != 1 else ''} installed editably",
        ),
    ]


def _check_js(ws_root: Path) -> list[Result]:
    nm = ws_root / "node_modules"
    if not nm.exists():
        return [Result("JS workspace", "fail", "node_modules missing", hint="run `pnpm install`")]
    results = [Result("JS workspace", "ok", "node_modules present")]

    # Mirror codegen's json2ts search: contracts/node_modules/.bin then the
    # pnpm-hoisted location at workspace root.
    candidates = [
        ws_root / "packages" / "contracts" / "node_modules" / ".bin" / "json2ts.cmd",
        ws_root / "packages" / "contracts" / "node_modules" / ".bin" / "json2ts",
        ws_root / "node_modules" / ".pnpm" / "node_modules" / ".bin" / "json2ts.cmd",
        ws_root / "node_modules" / ".pnpm" / "node_modules" / ".bin" / "json2ts",
        ws_root / "node_modules" / ".bin" / "json2ts.cmd",
        ws_root / "node_modules" / ".bin" / "json2ts",
    ]
    for c in candidates:
        if c.exists():
            results.append(
                Result(
                    "JS workspace",
                    "ok",
                    f"json2ts findable: {c.relative_to(ws_root)}",
                )
            )
            return results

    results.append(
        Result(
            "JS workspace",
            "fail",
            "json2ts binary not findable in any expected location",
            hint="run `pnpm install` (json-schema-to-typescript should be a contracts devDep)",
        )
    )
    return results


def _check_codegen(ws_root: Path, manifests: list[PluginManifest]) -> list[Result]:
    contracts_py = ws_root / "packages" / "contracts" / "src" / "its_contracts"
    if not contracts_py.exists():
        return [
            Result(
                "Codegen",
                "fail",
                "packages/contracts/src/its_contracts/ missing",
                hint="restore from git",
            )
        ]

    results: list[Result] = []
    missing: list[str] = []
    for m in manifests:
        if not (m.publishes or m.commands or m.globals):
            continue
        expected = contracts_py / f"{m.id.replace('-', '_')}.py"
        if not expected.exists():
            missing.append(m.id)

    if missing:
        results.append(
            Result(
                "Codegen",
                "fail",
                f"re-export modules missing for: {', '.join(missing)}",
                hint="run `its codegen`",
            )
        )
    else:
        n = sum(1 for m in manifests if m.publishes or m.commands or m.globals)
        results.append(
            Result(
                "Codegen",
                "ok",
                f"re-export modules present for {n} plugin{'s' if n != 1 else ''}",
            )
        )
    return results


def _parse_host_port(nats_url: str) -> tuple[str, int]:
    s = nats_url.split("://", 1)[-1]
    host, _, port = s.partition(":")
    return host or "127.0.0.1", int(port) if port else 4222


def _nats_reachable(host: str, port: int) -> tuple[bool, int]:
    """Returns (reachable, elapsed_ms). 2s timeout."""
    start = time.perf_counter()
    try:
        with socket.create_connection((host, port), timeout=2.0):
            return True, int((time.perf_counter() - start) * 1000)
    except OSError:
        return False, 0


def _port_free(port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", port))
            return True
    except OSError:
        return False


def _check_runtime(nats_url: str, http_port: int) -> list[Result]:
    """Combined view of platform state. "Platform running" and "platform
    not running" are both healthy outcomes - the doctor's job is to flag
    inconsistent combinations, not to demand a particular state.

    Truth table (nats_up, port_free):
        T, F  →  ok    "platform appears to be running"
        F, T  →  ok    "platform not running (this is fine)"
        T, T  →  warn  NATS reachable but no server on the HTTP port - weird
        F, F  →  warn  HTTP port held by something that isn't us
    """
    host, nats_port = _parse_host_port(nats_url)
    nats_up, elapsed_ms = _nats_reachable(host, nats_port)
    port_is_free = _port_free(http_port)

    if nats_up and not port_is_free:
        return [
            Result(
                "Runtime",
                "ok",
                f"platform appears to be running (NATS at {host}:{nats_port} ({elapsed_ms}ms), HTTP port {http_port} held)",
            )
        ]
    if not nats_up and port_is_free:
        return [
            Result(
                "Runtime",
                "ok",
                f"platform not running (NATS down at {host}:{nats_port}, HTTP port {http_port} free)",
                hint="start it with `its dev` (or `its start`) when you need it",
            )
        ]
    if nats_up and port_is_free:
        return [
            Result(
                "Runtime",
                "warn",
                f"NATS reachable at {host}:{nats_port} but HTTP port {http_port} is free",
                hint="another process owns NATS but no ITS server is listening - is something else using port 4222?",
            )
        ]
    # Both bad: NATS down + port held = port held by something non-ITS.
    return [
        Result(
            "Runtime",
            "warn",
            f"NATS unreachable at {host}:{nats_port} but HTTP port {http_port} is held",
            hint="another process is bound to the HTTP port - stop it or pass --port",
        )
    ]


def _print_results(console: Console, results: list[Result]) -> None:
    style_for = {
        "ok": "[green]ok[/green]  ",
        "warn": "[yellow]warn[/yellow]",
        "fail": "[red]fail[/red]",
    }
    sections: list[str] = []
    by_section: dict[str, list[Result]] = {}
    for r in results:
        if r.section not in by_section:
            sections.append(r.section)
            by_section[r.section] = []
        by_section[r.section].append(r)

    for section in sections:
        console.print(f"\n[bold]{section}[/bold]")
        for r in by_section[section]:
            console.print(f"  {style_for[r.status]}  {r.message}")
            if r.hint:
                console.print(f"        [dim]hint:[/dim] [cyan]{r.hint}[/cyan]")


def doctor(
    port: int = typer.Option(
        80,
        "--port",
        help="HTTP server port to check. Default 80. The runtime check pairs "
        "this with NATS reachability to tell platform-running vs platform-idle.",
    ),
    skip_runtime: bool = typer.Option(
        False,
        "--skip-runtime",
        help="Skip the NATS + port runtime check entirely. Use for pure "
        "static-check runs in CI.",
    ),
) -> None:
    """Pre-flight diagnostic: workspace shape, venv installs, codegen,
    JS deps, bus + port (read jointly). Exits non-zero on FAIL only."""
    console = Console()

    try:
        ws_root = _find_workspace_root()
    except RuntimeError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(code=1)

    console.print("[bold]ITS DOCTOR[/bold]")

    results: list[Result] = []
    ws_results, manifests = _check_workspace(ws_root)
    results.extend(ws_results)
    results.extend(_check_venv(ws_root))
    results.extend(_check_js(ws_root))
    results.extend(_check_codegen(ws_root, manifests))
    if not skip_runtime:
        nats_url = os.environ.get("ITS_NATS_URL", "nats://127.0.0.1:4222")
        results.extend(_check_runtime(nats_url, port))

    _print_results(console, results)

    n_fail = sum(1 for r in results if r.status == "fail")
    n_warn = sum(1 for r in results if r.status == "warn")

    console.print()
    if n_fail:
        console.print(
            f"[red]{n_fail} error{'s' if n_fail != 1 else ''}[/red], "
            f"[yellow]{n_warn} warning{'s' if n_warn != 1 else ''}[/yellow]"
        )
        raise typer.Exit(code=1)
    if n_warn:
        console.print(
            f"[yellow]0 errors, {n_warn} warning{'s' if n_warn != 1 else ''}[/yellow]"
        )
    else:
        console.print("[green]all checks passed[/green]")
