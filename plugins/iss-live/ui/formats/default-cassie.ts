// Seed format written when the formats KV is empty on first boot. From the
// legacy Cassie launch config.

export const DEFAULT_CASSIE_YAML = `name: cassie
version: 1

program_name: Cassie
booster_target: m007
sustainer_target: m008

# Map overlay (?mode=map) camera home. Legacy GSS launch site.
launch_site: { lat: 40.388527, lon: -87.51416 }

timeline:
  - { t: "5:30:00", desc: "Integration starts" }
  - { t: "3:30:00", desc: "Recovery hands off" }
  - { t: "2:30:00", desc: "Avionics hands off" }
  - { t: "1:00:00", desc: "Team photo" }
  - { t: "0:30:00", desc: "Vehicle on pad" }
  - { t: "0:05:00", desc: "Vehicle power on" }
  - { t: "0:00:00", desc: "Launch" }

fun_facts:
  - "Cassie is a shortening of Cassiopeia, the team's summer launch rocket"
  - "Cassie is flying a high-altitude reefing system designed in-house"
  - "We have 9 separate video sources looking at this rocket"
  - "Cassie has the highest dynamic pressure (Max Q) of any vehicle we have designed"
  - "Cassie's in-house developed recovery system is 100% 3D printed"
  - "Cassie pulls 32Gs at liftoff - 32x Earth's gravity"
  - "Our team formed 4 years ago. We started at IREC and moved to high altitude launches last year"
  - "Cassie breaks the sound barrier in under two seconds of flight"
  - "To avoid damage on landing, the rocket reefs to descend at a gentle 25 ft/s"
  - "This is our third streamed launch. Our first was Aether 1, in March 2025"
  - "Cassie is our first single-staged vehicle launched since IREC 2023"
  - "All camera communication is through an in-house flight computer (MIDAS) and camera control board"
  - "We have a fully SRAD video system on board, transmitting from the edge of space"
  - "Cassie's telemetry systems are fully student-designed end-to-end"
  - "Our team Slack has over 2,000,000 messages sent"
  - "Cassie's maximum speed is Mach 2.2 - faster than the Concorde"

sponsors:
  - "Illinois Space Society"
  - "University of Illinois Urbana-Champaign"
  - "Aerospace Engineering Department"

# Pre / idle / goodbye interstitial screens. Backgrounds are URLs served from
# the site root (see frontend/public). Headlines fall back to the legacy
# defaults when omitted.
idle_screen:
  subtitle: Cassie Launch
  pre_background: /idle-team.jpg
  idle_background: /idle-landscape.jpg
  footer_top: Spaceshot
  footer_bottom: Illinois Space Society
  goodbye_text: "The team is now beginning the rocket recovery process. Stay updated by following our social media!"
  social_handles:
    - { handle: "@illinoisspacesociety", platform: Instagram }
    - { handle: "@Illinois Space Society", platform: YouTube }

# OBS scene names this format expects to exist. The Presets tab
# validates each preset's scene refs against this list (warning, not
# error) so a missing scene is visible before launch day.
scenes:
  - IPCAM_1
  - IPCAM_2
  - ROCKET_LIVE
  - GENERIC_HOST
  - HOST_INTERVIEWEE
  - THANK_YOU

# Audio mute states keyed by name. Each value is { input_name: on },
# where true = unmuted, false = muted. Presets reference one by key
# via the audio_preset field.
audio_presets:
  radio_only:
    RADIO_AUDIO: true
    SHOTGUN_MIC_1: false
    SHOTGUN_MIC_2: false
    MIC_BUILTIN: false
  shotgun:
    RADIO_AUDIO: false
    SHOTGUN_MIC_1: true
    SHOTGUN_MIC_2: false
    MIC_BUILTIN: false

presets:
  - id: broll_cycle
    name: B-Roll Cycle
    description: Auto-rotate between pad and ground cameras
    scenes: [IPCAM_1, IPCAM_2]
    cycle_interval: 20
    overlay_state: { spot: false, top_timer: true, timeline: false, tag: false }

  - id: host_solo
    name: Host Solo
    description: Host camera with name tag
    scene: GENERIC_HOST
    overlay_state: { spot: false, top_timer: true, tag: true }
    target_desc: { title: "Host Name", subtitle: "Stream Host" }

  - id: interview
    name: Interview
    description: Host + interview split
    scene: HOST_INTERVIEWEE
    overlay_state: { spot: false, top_timer: true, tag: true }
    target_desc: { title: "Interviewee", subtitle: "Team Lead" }

  - id: launch
    name: Launch
    description: Launch camera with telemetry overlay
    scene: ROCKET_LIVE
    overlay_state: { spot: true, top_timer: false, timeline: false, tag: false }

  - id: thank_you
    name: Thank You
    description: End card
    scene: THANK_YOU
    overlay_state: { spot: false, top_timer: false, timeline: false, tag: false }
`;
