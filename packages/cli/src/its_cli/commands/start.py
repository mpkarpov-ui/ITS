import os
import re
import shutil
import subprocess
import sys
import threading
from pathlib import Path

import typer

from its_bus import nats
from its_contracts.codegen import generate_all
from its_core.log import enable_debug, get_logger
from its_core.plugins import PluginManifest, discover
from its_core.supervisor import Supervisor, build_plugin_env, resolve_instance_key
from its_core.watcher import watch_plugins
from its_core.web import build_app, serve

log = get_logger("supervisor")
nats_log = get_logger("nats")
http_log = get_logger("http")
vite_log = get_logger("vite")

VITE_PORT = 5173
VITE_URL = f"http://localhost:{VITE_PORT}"

# nats-server's startup is noisy (config dump, JetStream banner, per-stream
# restores) and we print our own "NATS running on ..." line. Filter to warnings/
# errors by default; ITS_VERBOSE_NATS=1 surfaces every line.
_NATS_VERBOSE = os.environ.get("ITS_VERBOSE_NATS") == "1"
_NATS_KEEP = re.compile(r"\[(WRN|ERR|FTL)\]|Listening for client connections")


def _nats_line_visible(line: str) -> bool:
    return _NATS_VERBOSE or bool(_NATS_KEEP.search(line))


def _terminate_tree(proc: subprocess.Popen) -> None:
    """Kill a process and all descendants.

    Windows terminate() (TerminateProcess) doesn't cascade, so killing a `pnpm
    exec vite` wrapper orphans node and leaks the port. taskkill /T cascades.
    """
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
            capture_output=True,
            check=False,
        )
    else:
        proc.terminate()


def _spawn_local_shell(
    manifests: list[PluginManifest], nats_url: str
) -> subprocess.Popen[str] | None:
    """Spawn a local its-shell (instance_key='server') bound to `its start`'s
    lifecycle. It hosts operator-launched intakes (autostart=false plugins started
    via a UI, e.g. gss-bridge); the supervisor still autostarts everything else.

    Returns None if its-shell isn't in the workspace; start() continues.
    """
    shell_manifest = next((m for m in manifests if m.id == "its-shell"), None)
    if shell_manifest is None:
        log.warn("its-shell plugin not found in workspace; skipping local shell")
        return None
    if shell_manifest.entry_path is None:
        log.warn("its-shell has no [runtime] entry; skipping local shell")
        return None

    config = {"name": "server", "allow_exec": False}
    instance_key = resolve_instance_key(config, ("name",))
    env = build_plugin_env(instance_key, config, nats_url=nats_url)

    proc = subprocess.Popen(
        [sys.executable, str(shell_manifest.entry_path)],
        cwd=shell_manifest.plugin_dir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    shell_log = get_logger("shell:server")

    def relay() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            stripped = line.rstrip()
            if stripped:
                shell_log.info(stripped)

    threading.Thread(target=relay, daemon=True).start()
    log.info(f"local shell 'server' spawned (pid {proc.pid}); ready for intakes")
    return proc


def _resolve_tool(name: str, install_hint: str) -> str:
    """Resolve a CLI tool to an absolute path. Windows CreateProcess won't
    auto-resolve .cmd/.bat shims (pnpm ships as pnpm.cmd), but shutil.which
    respects PATHEXT, so resolve up front to avoid FileNotFoundError.
    """
    resolved = shutil.which(name)
    if resolved is None:
        log.error(f"{name} not found on PATH; install from {install_hint}")
        raise typer.Exit(code=1)
    return resolved


def start(
    dev: bool = typer.Option(
        False, "--dev", help="Enable hot reload, verbose logs, plugin auto-restart."
    ),
    config: str = typer.Option(
        "its.toml", "--config", help="Override the default its.toml lookup."
    ),
    port: int = typer.Option(80, "--port", help="Web server port."),
) -> None:
    """Boot the main server: NATS, plugin host, web server, frontend."""
    if dev:
        enable_debug()
        log.info("--dev: Vite HMR + plugin file watcher enabled")
    if config != "its.toml":
        log.info(f"--config {config!r} acknowledged; config loading not implemented yet")

    uv = _resolve_tool("uv", "https://docs.astral.sh/uv/")
    pnpm = _resolve_tool("pnpm", "https://pnpm.io/installation")

    log.info("syncing workspace...")
    try:
        subprocess.run([uv, "sync"], check=True)
    except subprocess.CalledProcessError as exc:
        log.error(f"uv sync failed (exit {exc.returncode})")
        raise typer.Exit(code=1) from exc
    log.info("sync complete")

    log.info("installing JS deps...")
    try:
        subprocess.run([pnpm, "install"], check=True)
    except subprocess.CalledProcessError as exc:
        log.error(f"pnpm install failed (exit {exc.returncode})")
        raise typer.Exit(code=1) from exc
    log.info("JS deps ready")

    # Codegen before plugin spawn so the plugins can import their typed payloads.
    log.info("generating types from schemas...")
    try:
        result = generate_all(Path("plugins"), Path("packages/contracts"))
    except Exception as exc:
        log.error(f"codegen failed: {exc}")
        raise typer.Exit(code=1) from exc
    if not result.outputs:
        log.info("no schemas found")
    elif result.regenerated == 0:
        log.info(
            f"types up to date ({result.total} file(s) for {len(result.outputs)} plugin(s); cache hit)"
        )
    else:
        log.info(
            f"generated {result.regenerated} of {result.total} type file(s) "
            f"for {len(result.outputs)} plugin(s)"
        )

    # Frontend: --dev runs Vite's dev server, otherwise build a static dist/.
    vite_proc: subprocess.Popen[str] | None = None
    if dev:
        log.info(f"starting vite dev server on {VITE_URL}...")
        # `pnpm exec` runs vite directly; the script-name indirection forwarded
        # "--" as a literal arg.
        vite_proc = subprocess.Popen(
            [pnpm, "--filter", "@its/frontend", "exec", "vite", "--host", "--port", str(VITE_PORT), "--strictPort"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        def relay_vite() -> None:
            assert vite_proc is not None and vite_proc.stdout is not None
            for line in vite_proc.stdout:
                stripped = line.rstrip()
                if stripped:
                    vite_log.info(stripped)

        threading.Thread(target=relay_vite, daemon=True).start()
    else:
        log.info("building frontend...")
        try:
            subprocess.run([pnpm, "--filter", "@its/frontend", "build"], check=True)
        except subprocess.CalledProcessError as exc:
            log.error(f"frontend build failed (exit {exc.returncode})")
            raise typer.Exit(code=1) from exc
        log.info("frontend built")

    # NATS: locate or prompt-to-install, then spawn.
    binary = nats.locate()
    if binary is None:
        log.info(f"nats-server not found on PATH or in {nats.BIN_DIR}")
        ok = typer.confirm(
            f"Download nats-server v{nats.DEFAULT_NATS_VERSION} to {nats.BIN_DIR}?",
            default=False,
        )
        if not ok:
            log.info(
                "install nats-server manually from "
                "https://github.com/nats-io/nats-server/releases and re-run"
            )
            raise typer.Exit(code=1)
        try:
            log.info(f"downloading nats-server v{nats.DEFAULT_NATS_VERSION}...")
            binary = nats.install()
            log.info(f"installed: {binary}")
        except Exception as exc:
            log.error(f"install failed: {exc}")
            raise typer.Exit(code=1) from exc

    nats_port = 4222
    nats_proc = nats.spawn(binary, port=nats_port)
    log.info(
        f"NATS running on nats://127.0.0.1:{nats_port} (pid {nats_proc.pid}); "
        "press Ctrl-C to stop"
    )

    def relay_nats() -> None:
        assert nats_proc.stdout is not None
        for line in nats_proc.stdout:
            stripped = line.rstrip()
            if stripped and _nats_line_visible(stripped):
                nats_log.info(stripped)

    threading.Thread(target=relay_nats, daemon=True).start()

    manifests = discover(Path("plugins"))
    log.info(
        f"discovered {len(manifests)} plugin(s): {[m.id for m in manifests] or '[]'}"
    )
    supervisor = Supervisor()
    supervisor.start(manifests)

    shell_proc = _spawn_local_shell(manifests, f"nats://127.0.0.1:{nats_port}")

    # HTTP server: dev redirects SPA traffic to Vite, prod serves dist/.
    frontend_dist = Path("frontend/dist")
    app = build_app(manifests, frontend_dist, vite_url=VITE_URL if dev else None)
    http_server, http_thread = serve(app, port=port)
    http_log.info(f"HTTP server listening on http://127.0.0.1:{port}")

    # Plugin file watcher (dev only).
    watcher_stop_event = threading.Event()
    watcher_thread: threading.Thread | None = None
    if dev:
        def on_plugin_change(plugin_ids: set[str], schemas_changed: bool) -> None:
            if schemas_changed:
                log.info("schema change detected; regenerating types...")
                try:
                    generate_all(Path("plugins"), Path("packages/contracts"))
                except Exception as exc:
                    log.error(f"codegen failed: {exc}; skipping plugin restart")
                    return
            for pid in plugin_ids:
                supervisor.restart_plugin(pid)

        watcher_thread = threading.Thread(
            target=watch_plugins,
            args=(Path("plugins"), on_plugin_change, watcher_stop_event),
            daemon=True,
        )
        watcher_thread.start()

    # Both Ctrl-C and a natural NATS exit lead to the same teardown.
    try:
        nats_proc.wait()
    except KeyboardInterrupt:
        pass

    # Teardown order: HTTP -> watcher -> supervisor -> vite -> NATS.
    log.info("shutting down...")
    http_log.info("stopping HTTP server...")
    http_server.should_exit = True
    http_thread.join(timeout=5)
    if watcher_thread is not None:
        watcher_stop_event.set()
        watcher_thread.join(timeout=5)
    supervisor.shutdown()
    if shell_proc is not None and shell_proc.poll() is None:
        log.info("stopping local shell...")
        # Tree-terminate: the shell owns intake subprocesses that a plain
        # terminate() would orphan on Windows.
        _terminate_tree(shell_proc)
        try:
            shell_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            log.warn("local shell did not exit in 10s; killing")
            shell_proc.kill()
    if vite_proc is not None and vite_proc.poll() is None:
        vite_log.info("stopping vite...")
        _terminate_tree(vite_proc)
        try:
            vite_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            log.warn("vite did not exit in 10s; killing")
            vite_proc.kill()
    if nats_proc.poll() is None:
        nats_proc.terminate()
        try:
            nats_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            log.warn("nats-server did not exit in 10s; killing")
            nats_proc.kill()
    log.info("NATS stopped")
