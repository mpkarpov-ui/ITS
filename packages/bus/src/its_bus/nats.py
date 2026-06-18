"""NATS server lifecycle: locate the binary, install it, spawn it."""

from __future__ import annotations

import platform
import shutil
import subprocess
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

DEFAULT_NATS_VERSION = "2.14.1"

ITS_HOME = Path.home() / ".its"
BIN_DIR = ITS_HOME / "bin"


def binary_name() -> str:
    return "nats-server.exe" if sys.platform == "win32" else "nats-server"


def locate() -> Path | None:
    """Find nats-server. Search PATH first, then ~/.its/bin/."""
    on_path = shutil.which("nats-server")
    if on_path:
        return Path(on_path)

    local = BIN_DIR / binary_name()
    if local.exists():
        return local

    return None


def _release_asset(version: str) -> tuple[str, str]:
    """Resolve the GitHub release asset URL for this host's OS/arch."""
    osname = {"win32": "windows", "linux": "linux", "darwin": "darwin"}.get(sys.platform)
    if osname is None:
        raise RuntimeError(f"Unsupported platform: {sys.platform}")

    machine = platform.machine().lower()
    arch = {
        "amd64": "amd64",
        "x86_64": "amd64",
        "aarch64": "arm64",
        "arm64": "arm64",
    }.get(machine)
    if arch is None:
        raise RuntimeError(f"Unsupported CPU architecture: {machine}")

    ext = "zip" if osname == "windows" else "tar.gz"
    archive = f"nats-server-v{version}-{osname}-{arch}.{ext}"
    url = (
        f"https://github.com/nats-io/nats-server/releases/download/"
        f"v{version}/{archive}"
    )
    return url, archive


def install(version: str = DEFAULT_NATS_VERSION) -> Path:
    """Download nats-server vN to ~/.its/bin/ and return the binary path."""
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    url, archive_name = _release_asset(version)
    archive_path = BIN_DIR / archive_name

    urllib.request.urlretrieve(url, archive_path)

    target = BIN_DIR / binary_name()
    bin_basename = binary_name()
    suffix = "/" + bin_basename

    if archive_name.endswith(".zip"):
        with zipfile.ZipFile(archive_path) as zf:
            matches = [
                name
                for name in zf.namelist()
                if name == bin_basename or name.endswith(suffix)
            ]
            if not matches:
                raise RuntimeError(f"No {bin_basename} found in {archive_name}.")
            with zf.open(matches[0]) as src, target.open("wb") as dst:
                shutil.copyfileobj(src, dst)
    else:
        with tarfile.open(archive_path) as tf:
            matches = [
                m
                for m in tf.getmembers()
                if m.name == bin_basename or m.name.endswith(suffix)
            ]
            if not matches:
                raise RuntimeError(f"No {bin_basename} found in {archive_name}.")
            extracted = tf.extractfile(matches[0])
            if extracted is None:
                raise RuntimeError(f"Could not extract {bin_basename} from {archive_name}.")
            with extracted as src, target.open("wb") as dst:
                shutil.copyfileobj(src, dst)

    archive_path.unlink()

    if sys.platform != "win32":
        target.chmod(0o755)

    return target


DEFAULT_LEAF_PORT = 7422


def spawn(
    binary: Path,
    port: int = 4222,
    leaf_port: int | None = DEFAULT_LEAF_PORT,
) -> subprocess.Popen[str]:
    """Spawn nats-server on 127.0.0.1:<port>. Caller owns the Popen lifecycle.

    JetStream is enabled (-js) so the platform can use NATS KV for the
    instance_key uniqueness lock. JetStream state goes to a per-run temp dir
    so dev restarts don't accumulate stream files on disk.

    When `leaf_port` is set (default 7422), the server also listens for
    leaf-node connections on that port - this is how `its repeater` attaches
    a spectator-side NATS to the main bus. Pass `leaf_port=None` to disable.
    Closed-LAN trust model: no auth on the leaf listener.
    """
    if leaf_port is None:
        # Plain flag-based launch, no config file.
        return subprocess.Popen(
            [str(binary), "--addr", "127.0.0.1", "--port", str(port), "-js"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )

    # Leaf listener requires a config file - nats-server has no CLI flag
    # for `leafnodes { port: ... }`. Write a tempfile and hand it to -c.
    cfg_path = _write_main_config(port=port, leaf_port=leaf_port)
    return subprocess.Popen(
        [str(binary), "-c", str(cfg_path), "-js"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )


def spawn_leaf(
    binary: Path,
    port: int,
    upstream_url: str,
) -> subprocess.Popen[str]:
    """Spawn nats-server as a leaf node attached to `upstream_url`.

    Local clients (the repeater's web bridge + any spectator-side direct
    NATS clients) talk to 127.0.0.1:<port> normally. Subjects propagate
    on demand via NATS interest-based routing - the leaf only pulls
    subjects that local subscribers actually want. No JetStream locally
    (the platform's KV lives upstream; spectators shouldn't write it).
    """
    cfg_path = _write_leaf_config(port=port, upstream_url=upstream_url)
    return subprocess.Popen(
        [str(binary), "-c", str(cfg_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )


def _write_main_config(port: int, leaf_port: int) -> Path:
    """Config for a main-server NATS with leaf-listener enabled."""
    content = (
        f"host: 127.0.0.1\n"
        f"port: {port}\n"
        f"leafnodes {{\n"
        f"  host: 0.0.0.0\n"
        f"  port: {leaf_port}\n"
        f"}}\n"
    )
    return _write_temp_config("its-nats-main", content)


def _write_leaf_config(port: int, upstream_url: str) -> Path:
    """Config for a leaf-node NATS pointed at an upstream leaf listener."""
    # upstream_url may be a plain `nats://host:port`; rewrite the scheme
    # to nats-leaf:// which nats-server requires for leaf remotes.
    if upstream_url.startswith("nats://"):
        upstream_url = "nats-leaf://" + upstream_url[len("nats://"):]
    content = (
        f"host: 127.0.0.1\n"
        f"port: {port}\n"
        f"leafnodes {{\n"
        f'  remotes: [ {{ url: "{upstream_url}" }} ]\n'
        f"}}\n"
    )
    return _write_temp_config("its-nats-leaf", content)


def _write_temp_config(prefix: str, content: str) -> Path:
    """Write a nats-server config to a temp file. Not auto-cleaned; the OS
    reclaims tempfiles on reboot, which is fine for a long-running process."""
    import tempfile

    fd, path = tempfile.mkstemp(prefix=f"{prefix}-", suffix=".conf", text=True)
    with open(fd, "w", encoding="utf-8") as f:
        f.write(content)
    return Path(path)
