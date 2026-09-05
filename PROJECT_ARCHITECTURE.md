> This file is a curated snapshot derived from ANTIGRAVITY_BRIEF.md and 
> RESEARCH_SCOPE.md. If anything here conflicts with those two documents, 
> they are authoritative — this file should be regenerated, not manually 
> reconciled.

# Project Architecture and Context

This document provides a comprehensive snapshot of the current state of the fitness app, its architecture, established conventions, accepted tradeoffs, and hard constraints. Use this file to understand the project structure and logic to prevent unintentional modifications to critical components.

## 1. Project Overview
A zero-install, privacy-first web application designed for real-time exercise form coaching. All processing occurs locally on the client's device—no video frames, keypoints, or audio data are ever uploaded to a server. 

### Completed Phases:
1. **Phase 1: Environment Initialization & Model Loading:** Live camera feed integration with real-time pose extraction using `@mediapipe/tasks-vision` inside a Web Worker.
2. **Phase 2: Auto-Perspective Camera Calibration:** 3-second routine determining camera pitch and tilt using anatomical proportions.
3. **Phase 3: Reference Trajectory Extraction:** Tab-capturing the browser tab containing the embedded YouTube player (via `getDisplayMedia`) to extract keypoints `R(t)` from reference exercise videos.
4. **Phase 4: Dynamic Time Warping (DTW) Alignment:** Real-time Sakoe-Chiba banded alignment between live user motion and reference trajectory `R(t)`, calculating 8-joint angle RMSE and secondary 2D normalized coordinate deviation.

### Upcoming Phases:
5. **Phase 5: Kinematic Velocity & Fatigue Calculation:** Extracting velocity `v = Δs/Δt` to find jitter, trembling, and concentric-phase slowdowns.
6. **Phase 6: Local Feedback & Data Persistence:** Web Speech API for voice cues, IndexedDB for local data persistence.

## 2. Hard Constraints (Do NOT violate)
- **Zero Server Interaction:** Everything is entirely client-side. No uploading frames or keypoints.
- **Model Backend:** Use `@mediapipe/tasks-vision` exclusively. No MoveNet, OpenPose, or alternative models.
- **Vanilla JavaScript:** Built with Vanilla JS + ES modules. **No frontend framework** or bundler (e.g., React, Webpack) unless explicitly required and approved.
- **Local Server Requirement:** Must run via a local server (`npx serve` or similar) to allow `getUserMedia` and worker files to load properly. It will fail over `file://`.

## 3. Architecture Details

### Web Worker Concurrency
- `poseWorker.js` handles inference on a dedicated web worker to unblock the UI thread.
- **Communication:** `main.js` captures `ImageBitmap` frames and transfers them zero-copy to the worker via `poseDetector.js`.
- **Mode:** The PoseLandmarker is run in `VIDEO` mode using `performance.now()` timestamps per frame — this fixed a skeleton-misalignment bug seen under `IMAGE` mode with non-square camera feeds. Note: the separate `NORM_RECT` console warning is unrelated to this mode choice and persists regardless — see Section 4.

### System Components (One File, One Job)
- `index.html`: Holds DOM structure, UI panels, loading overlays, CSS connections.
- `css/style.css`: All styling, layout grid definitions, animations.
- `js/main.js`: Core orchestrator. Ties UI events to system actions. Maintains application state (`running`, `paused`, `calibrationTransform`, `referenceSequence`).
- `js/constants.js`: Source of truth for confidence thresholds (`CONFIDENCE.MEDIUM`), landmark indices, edge connections, and model CDN endpoints.
- `js/camera.js`: Manages `getUserMedia`, stream instantiation, and track cleanup.
- `js/poseDetector.js`: Thin proxy communicating asynchronously with `poseWorker.js`.
- `js/poseWorker.js`: Classic web worker initializing MediaPipe and executing `detectForVideo`.
- `js/skeletonRenderer.js`: Pure canvas drawing instructions for skeletons and joint markers.
- `js/telemetryPanel.js`: DOM manipulation for side-panel statistics, gauges, and status badges.
- `js/angles.js`: Shared utility for 3D vector joint angle calculations and confidence gating (`computeAllJointAngles`).
- `js/calibration.js`: Measures shoulder-to-torso proportions across high-confidence frames to compute pitch offset and scale factor. Implements 2D planar scale/pitch `normalize()`.
- `js/referenceExtractor.js`: Captures browser tab stream, crops dynamically per frame, and feeds frames to the pose worker to generate reference sequence `R(t)`.
- `js/dtwAligner.js`: Sakoe-Chiba banded Dynamic Time Warping alignment engine. Computes 8-joint angle RMSE ($D_{\text{angles}}$) and secondary 2D normalized coordinate error ($D_{\text{coords}}$) over a 1.5–2s rolling window.

### Key Technical Implementations
- **Dynamic Crop Region Recalculation:** In `js/referenceExtractor.js`, the YouTube iframe bounding box (`getBoundingClientRect()`) is recalculated on **every single frame** rather than cached. This prevents crop misalignment if the layout shifts or reflows during extraction.
- **Session Memory State:** Both `calibrationTransform` and the reference sequence `R(t)` live strictly in session memory in `main.js` and are lost on page reload. This is **by design**—Phase 6 will introduce IndexedDB persistence. Do not build early storage/persistence layers.
- **Constants Only from `constants.js`:** Never hardcode confidence thresholds (e.g., `0.75`) or asset paths elsewhere. Import them.
- **Visibility Pausing:** `main.js` listens to `visibilitychange`. If the tab is hidden, inference is suspended to respect OS power-saving and prevent frame queuing.
- **Canvas Sizing:** Canvas overlay CSS must flawlessly match the `object-fit` of the underlying video.
- **RequestVideoFrameCallback:** Frame timing relies on `requestVideoFrameCallback` with `requestAnimationFrame` as a fallback. Never poll `video.currentTime`.

## 4. Known Fragilities, Accepted Tradeoffs & Benign Warnings

### Fragilities & Structural Notes
- **MediaPipe Vendoring:** `js/vendor/mediapipe.js` is a manually patched bundle (switching `export` to `var $mediapipe`) allowing it to run inside a classic Web Worker. Do not replace it blindly from a CDN.
- **Duplicate WASM/Model paths:** Classic workers cannot import ES modules (`constants.js`). Model endpoints are duplicated inside `poseWorker.js`. Bumping the model version requires updating both files manually.
- **Calibration transform normalization:** `calibrationTransform.normalize()` is currently a stub. The computed pitch and scale factors are valid, but Phase 4 must implement the matrix transformation.
- **State Locks:** `startCamera()` and `stopCamera()` use an `isTransitioning` lock. `startCalibration()` is explicitly *not* locked by `isTransitioning` because its state assignment is synchronous. Do not add asynchronous steps to `startCalibration()` without adding a lock.

### Accepted Limitations (Do NOT treat as bugs to fix)
- **YouTube ToS & Tab Capture:** Reference extraction uses `getDisplayMedia` tab capture instead of raw video downloading. YouTube's Terms of Service restrict automated capture outside the official player/API; never storing or transmitting frames reduces the risk profile significantly compared to downloading, but does not make it explicitly ToS-compliant. This is a documented, accepted tradeoff, not something to "fix."
- **Browser & Mobile Restrictions:** Mobile browsers, Firefox, and Safari do not support `getDisplayMedia` tab capture. Showing an unsupported UI notice is the accepted behavior—do NOT attempt to build a file-upload or alternative fallback.
- **YouTube IFrame `ENDED` Event Inconsistency:** YouTube's `onStateChange` / `ENDED` callback fires inconsistently. A polling fallback using `getCurrentTime()` / `getDuration()` in `referenceExtractor.js` acts as the load-bearing stop mechanism.

### Confirmed Benign Console Warnings (Do NOT re-investigate)
- **`NORM_RECT` ROI Warning:** A known, permanent MediaPipe internal-graph quirk — appears regardless of running mode (IMAGE or VIDEO) or platform, including in Google's own official demos. Confirmed harmless: does not affect tracking accuracy or skeleton alignment. The VIDEO mode switch fixed a separate, related bug (skeleton misalignment on non-square camera feeds) — it did not eliminate this console warning, which will keep appearing every session. Do not attempt to silence it.
- **`postMessage` Origin Mismatch:** Warnings referencing `https://www.youtube.com` vs host origin appear during iframe extraction; benign cross-origin message noise.
- **`[Violation] compute-pressure` Warning:** Permissions policy violation notice coming directly from YouTube's embedded player script; has zero impact on application functionality.
