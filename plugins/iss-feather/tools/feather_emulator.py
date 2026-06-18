"""Dev-only feather_duo emulator. Not part of the plugin runtime.

A plain TCP server the plugin reaches via pyserial's `socket://` URL, so the
plugin path matches a real COM port:
    python plugins/iss-feather/tools/feather_emulator.py
    its connect iss-feather --channel dev --port socket://127.0.0.1:5555

Emits `{"type": "data", ...}` ~10 Hz per rocket, alternating two MIDAS serials
to exercise the dual-receiver fan-out. Field names match feather_duo/Output.cpp.
Replies `command_sent`+`command_success` for known verbs, `bad_command`
otherwise, and plain-text `IDENT_RESPONSE:FEATHER_DUO` for `ident`.
"""

from __future__ import annotations

import json
import math
import random
import socket
import threading
import time

HOST = "127.0.0.1"
PORT = 5555

# 7 and 8 render as m007 / m008, both selectable targets in midas-ground.
SERIALS = [7, 8]

# Verbs the real MShell registers (feather_duo/midas_shell_commands.h);
# `ident` is handled separately as plain text.
KNOWN_VERBS = {"fire", "safe", "pt", "arm", "cam", "calib", "kfr", "frequency", "serial", "hi"}


def make_packet(serial_no: int, t: float) -> str:
    """One synthetic telemetry line for a rocket serial at flight-time t."""
    alt = max(0.0, 3000.0 * math.exp(-((t - 18.0) ** 2) / 90.0)) + random.uniform(-0.5, 0.5)
    dt = 0.1
    alt_next = max(0.0, 3000.0 * math.exp(-(((t + dt) - 18.0) ** 2) / 90.0))
    velocity = (alt_next - alt) / dt
    boost = 1.5 < t < 8.0
    value = {
        "barometer_altitude": round(alt + random.uniform(-1.0, 1.0), 3),
        "latitude": round(40.1106 + alt * 5e-8, 7),
        "longitude": -88.2073,
        "altitude": int(alt),
        "highG_ax": round(random.uniform(-1.5, 1.5), 3),
        "highG_ay": round(random.uniform(-1.5, 1.5), 3),
        "highG_az": round((60.0 if boost else -9.81) + random.uniform(-3.0, 3.0), 3),
        "battery_voltage": round(11.8 + random.uniform(-0.05, 0.05), 3),
        "cam_battery_voltage": round(7.4 + random.uniform(-0.05, 0.05), 3),
        "FSM_State": 3 if boost else 5,
        "tilt_angle": round(0.0 if t < 8.0 else min(25.0, (t - 8.0) * 0.4), 3),
        "frequency": 421.15,
        "RSSI": round(-45.0 - alt * 0.015 + random.uniform(-2.0, 2.0), 1),
        "sat_count": 10,
        "kf_velocity": round(velocity, 3),
        "kf_positionX": 0.0,
        "kf_positionY": 0.0,
        "kf_positionZ": round(alt, 3),
        "serial": serial_no,
        "roll_rate": round(random.uniform(-0.2, 0.2), 3),
        "c_valid": 0,
        "c_on": 0,
        "c_rec": 0,
        "vtx_on": 0,
        "vmux_stat": 0,
        "cam_ack": 0,
        "cmd_ack": 0,
        "gps_fixtype": 3,
        "pyro_a": 3.2,
        "pyro_b": 3.2,
        "pyro_c": 3.2,
        "pyro_d": 3.2,
        "err_flags": 0,
    }
    return json.dumps({"type": "data", "value": value})


def reply_to(conn: socket.socket, lock: threading.Lock, cmd: str) -> None:
    print(f"  RX command: {cmd!r}")
    verb = cmd.split()[0] if cmd.split() else ""
    if verb == "ident":
        replies = ["IDENT_RESPONSE:FEATHER_DUO"]
    elif verb in KNOWN_VERBS:
        replies = ['{"type": "command_sent"}', '{"type": "command_success"}']
    else:
        replies = ['{"type": "bad_command"}']
    with lock:
        for r in replies:
            conn.sendall((r + "\n").encode("utf-8"))


def handle(conn: socket.socket, addr: tuple) -> None:
    print(f"client connected: {addr}")
    send_lock = threading.Lock()
    stop = threading.Event()

    def sender() -> None:
        t0 = time.monotonic()
        i = 0
        while not stop.is_set():
            serial_no = SERIALS[i % len(SERIALS)]
            i += 1
            line = make_packet(serial_no, time.monotonic() - t0) + "\n"
            with send_lock:
                try:
                    conn.sendall(line.encode("utf-8"))
                except OSError:
                    stop.set()
                    return
            time.sleep(0.05)  # ~20 lines/s total -> ~10 Hz per rocket

    threading.Thread(target=sender, daemon=True).start()

    buf = b""
    try:
        while not stop.is_set():
            data = conn.recv(4096)
            if not data:
                break
            buf += data
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                cmd = raw.decode("utf-8", errors="replace").strip()
                if cmd:
                    reply_to(conn, send_lock, cmd)
    except OSError:
        pass
    finally:
        stop.set()
        try:
            conn.close()
        except OSError:
            pass
        print(f"client disconnected: {addr}")


def main() -> None:
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((HOST, PORT))
    srv.listen(1)
    print(f"feather emulator listening on {HOST}:{PORT} (serials {SERIALS})")
    try:
        while True:
            conn, addr = srv.accept()
            threading.Thread(target=handle, args=(conn, addr), daemon=True).start()
    except KeyboardInterrupt:
        print("\nshutting down")
    finally:
        srv.close()


if __name__ == "__main__":
    main()
