from pydantic import BaseModel, Field


class Tlm(BaseModel):
    """Canonical MIDAS telemetry packet, owned by midas-ground.

    Every source (gss-bridge today, feather later) re-exports this class so the
    platform shares one definition. Field names mirror the GSS reference
    (FullTelemetryView.jsx) to keep the port near-direct.
    """

    # FSM stage: -1 = no data, 0..15 = real states (mapping in GSS
    # midasconversion.jsx). FlightView decodes this to a name.
    FSM_State: int = Field(default=-1)

    # GPS
    latitude: float = 0.0
    longitude: float = 0.0
    altitude: float = 0.0          # GPS altitude (meters)
    sat_count: int = 0
    gps_fixtype: int = -1          # see GPS_FIX_TYPES in midasconversion.jsx

    # Barometric + KF
    barometer_altitude: float = 0.0
    kf_velocity: float = 0.0
    kf_positionX: float = 0.0
    kf_positionY: float = 0.0
    kf_positionZ: float = 0.0

    # IMU
    tilt_angle: float = 0.0        # degrees
    roll_rate: float = 0.0         # rotations/s
    highG_ax: float = 0.0          # m/s^2
    highG_ay: float = 0.0
    highG_az: float = 0.0

    # Pyro continuity (volts on each channel)
    pyro_a: float = 0.0
    pyro_b: float = 0.0
    pyro_c: float = 0.0
    pyro_d: float = 0.0

    # Comms
    RSSI: float = 0.0              # dBm
    frequency: float = 0.0         # MHz
    is_sustainer: int = 0          # 0/1 flag from the link layer

    # Power
    battery_voltage: float = 0.0

    # Camera / control state. Bit layout mirrors FullTelemetryView's decode.
    c_valid: int = 0               # 0 = leading bit clear, cam state valid
    c_on: int = 0                  # 2-bit: bit0=cam1, bit1=cam2
    c_rec: int = 0                 # 2-bit: recording flags
    vtx_on: int = 0                # 1 = video TX locked
    vmux_stat: int = 0             # 0=cam1, 1=cam2
    cam_ack: int = 0               # last cam-command ack code
    cam_battery_voltage: float = 0.0
