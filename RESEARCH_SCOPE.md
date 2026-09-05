# RESEARCH SCOPE — Reference Document for Agentic Implementation

Source: "On-Device Real-Time Exercise Assessment Using Dynamic Sequence
Alignment and Kinematic Velocity Tracking" (project research paper).
This is a condensed implementation-relevant extract, not the full paper —
ask the project owner if you need methodology/citation detail beyond this.

## Problem being solved

Existing web-based exercise-form tools rely on rigid, pre-coded joint-angle
thresholds (e.g. "flag if knee_angle < 90°"). These fail under real-world
camera placement, ignore execution speed differences between users, and
ignore fatigue signals like joint velocity and micro-jitter. This project
replaces static rules with dynamic, on-device comparison against an
arbitrary reference video.

## The six phases

**Phase 1 — Environment Initialization & Model Loading** (DONE)
Initialize `@mediapipe/tasks-vision` via WASM inside Web Workers. Capture
webcam frames via `getUserMedia`.

**Phase 2 — Auto-Perspective Camera Calibration**
A 3-second setup routine where the user stands facing the camera. Compute
anatomical ratios (e.g. shoulder-width to torso-height) to estimate camera
pitch/tilt, then build a transformation matrix that normalizes later
keypoint vectors so accuracy holds across different camera heights/angles.

**Phase 3 — Reference Trajectory Extraction**
User supplies a reference exercise video (e.g. via YouTube IFrame API).
Process it frame-by-frame to extract a 33-point landmark matrix `R(t)`
representing the baseline/correct exercise execution curve.

**Phase 4 — Dynamic Time Warping (DTW) Alignment**
Live webcam keypoints `U(t)` are temporally aligned against `R(t)` using a
fast, sliding-window DTW algorithm, adjusting for pace differences between
the user and the reference. Spatial deviation beyond a variance threshold
triggers a form-correction alert.

**Phase 5 — Kinematic Velocity & Fatigue Calculation**
Frame-to-frame keypoint displacement gives joint velocity `v = Δs/Δt`.
Used to detect:
- Concentric-phase slowdown (velocity drop during the lifting phase)
- Keypoint jitter/tremor (high-frequency spatial fluctuation → local fatigue)

**Phase 6 — Local Feedback & Data Persistence**
Skeleton overlay rendered on `<canvas>`. Voice cues via the native
`window.speechSynthesis` API (Web Speech API) — no network call. Session
stats (rep count, velocity curves, form-deviation scores) saved to
IndexedDB. Raw video frames are discarded immediately after inference —
never persisted, never uploaded.

## Explicitly out of scope

- No cloud processing or server-side inference of any kind
- No dependency on dedicated GPU/lab hardware (target: consumer laptop,
  e.g. Intel i5 + RTX 3050 class)
- 3D pose reconstruction is not part of this project — 2D only

## Known/expected limitations (design around these, don't try to "fix")

- Full occlusion of a limb (e.g. far-side leg in a profile view) causes
  tracking loss for that joint — this is inherent to monocular 2D pose
  estimation, not a bug.
- Extreme low light reduces keypoint confidence.
- Backgrounding the browser tab may throttle Web Worker execution under
  aggressive OS power-saving — Phase 1 already handles this by pausing
  inference and communicating it in the UI rather than degrading silently.
- No formal clinical biomechanics validation — evaluation is algorithmic/
  benchmark-based, not a substitute for medical assessment. Do not add
  language to the UI that implies clinical or medical accuracy.
