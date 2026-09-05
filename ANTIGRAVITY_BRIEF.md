# PROJECT BRIEF — On-Device Exercise Form Coach

Read this fully before touching any code. It exists so you don't have to
re-derive decisions that have already been made and tested.

## 1. What this project is

A zero-install, privacy-first web app for real-time exercise form coaching.
Everything runs client-side — no video frame, keypoint, or audio data is
ever sent to a server. Full research scope is in `RESEARCH_SCOPE.md`
(attached alongside this brief) — read it before planning any phase beyond
Phase 1, since it defines the exact behavior each phase must implement.

Core pipeline (6 phases total):
1. **Camera + pose landmark extraction** — DONE, this repo's current state
2. Auto-perspective camera calibration (3-second setup routine)
3. Reference exercise video keypoint extraction (via YouTube IFrame API)
4. Dynamic Time Warping alignment between live user and reference
5. Kinematic velocity + fatigue (tremor) tracking
6. Local audio/visual feedback + IndexedDB persistence

## 2. Hard constraints — do not violate these

- **No server-side processing of camera or video data, ever.** This is the
  entire value proposition of the project. If a task seems to need a
  server, stop and flag it instead of building one.
- **Pose extraction library stays `@mediapipe/tasks-vision`.** Do not swap
  in MoveNet, OpenPose, or any other pose backend without being asked —
  this was already evaluated and decided.
- **No frontend framework.** Currently vanilla JS + ES modules, no bundler,
  no build step. Keep it that way unless a task explicitly calls for
  introducing one (e.g. Web Worker bundling might justify it — ask first).
- **Must run from a served origin (`localhost` or HTTPS), never `file://`.**
  `getUserMedia` will silently fail otherwise. When verifying in-browser,
  serve the folder first (`npx serve .` or equivalent).

## 3. Conventions already established — follow these, don't reinvent

- `js/constants.js` is the **single source of truth** for landmark names,
  skeleton connections, confidence thresholds, and model config. Any new
  module that needs these values imports them from here. Never hardcode a
  confidence number (e.g. `0.75`) anywhere else in the codebase.
- **One file, one job.** `camera.js` only knows about `getUserMedia`.
  `poseDetector.js` only knows about MediaPipe inference. `main.js` only
  wires things together and holds app state — it should never contain
  drawing logic, detection logic, or camera logic directly. If you're
  adding a new capability (e.g. DTW, calibration), give it its own module
  under `js/` rather than growing an existing file's responsibilities.
- **Frame timing uses `video.requestVideoFrameCallback`**, with a
  `requestAnimationFrame` fallback for browsers that lack it. Don't revert
  to polling `video.currentTime` — that was a bug we already fixed.
- **Canvas overlay must always match the video's `object-fit` value.**
  If you change how the video is cropped/scaled, update the canvas CSS
  identically or the skeleton will drift off the body.
- Tab-visibility handling already pauses inference when the tab is hidden
  (see `visibilitychange` listener in `main.js`) — extend this pattern for
  any other expensive per-frame work you add (DTW, velocity calc, etc.),
  don't remove it.

## Known fragility — read before touching pose detection or MediaPipe version

- `js/vendor/mediapipe.js` is a manually patched, vendored copy of the
  MediaPipe bundle — not the live CDN file. See the comment block at the
  top of that file for why. It must be manually re-patched if the
  MediaPipe version ever changes.
- `poseWorker.js` contains its own copies of `WASM_BASE` and
  `MODEL_ASSET_PATH` (duplicated from `js/constants.js`, because classic
  workers can't `import` from it). If you change the model version or CDN
  path in `constants.js`, you must update `poseWorker.js` by hand too —
  there is no automatic sync between them.
- **`calibrationTransform.normalize()` is a non-functional placeholder.**
  It logs `console.warn("normalize() not yet implemented — Phase 4
  dependency")` and returns the landmark unchanged. `pitchOffsetDegrees`
  and `scaleFactor` ARE correctly calculated and stored, but nothing
  currently applies them to landmark data. **Phase 4 must implement the
  actual correction math in `normalize()` before relying on it** — don't
  assume calibration is "fully wired up" just because the transform object
  looks complete.
- **`startCalibration()` deliberately skips the `isTransitioning` lock.**
  Reason: unlike `startCamera()`/`stopCamera()`, it has no `await` before
  `activeCalibration` is assigned — the assignment is synchronous, so
  `if (activeCalibration || !running) return;` is a watertight guard on
  its own (JS's single-threaded event loop guarantees no second click can
  interleave before that assignment completes). If you ever add an
  `await` before that assignment in a future edit, this guard stops being
  safe and the `isTransitioning` lock must be added back in at that point.
- **Footer text in `index.html` is stale** — as of Phase 1 it read "camera
  init + landmark extraction only, no calibration...". This should be
  updated to reflect that calibration now runs in this build. Low
  priority, but fix before Phase 3 adds another feature that makes the
  footer even more wrong.
- **YouTube IFrame API's `onStateChange`/`ENDED` event fires
  inconsistently** during extraction — sometimes it correctly triggers
  auto-stop, sometimes it doesn't and the `getCurrentTime()`/
  `getDuration()` polling fallback catches it instead. This is likely tied
  to persistent `postMessage` origin-mismatch console errors seen during
  extraction (`https://www.youtube.com` vs the page's actual origin) —
  those errors are benign otherwise (same treatment as the MediaPipe
  NORM_RECT warning — don't spend further effort silencing them), but
  **treat the polling fallback as the real, load-bearing stop mechanism,
  not a backup.** This may behave differently once/if the app is served
  over HTTPS instead of localhost, but don't assume the event-based path
  is fixed without re-testing in that environment.
- **A separate `[Violation] compute-pressure` permissions warning** also
  appears during extraction; this originates from YouTube's own embedded
  player code, not this project's logic, and has shown no effect on
  functionality across multiple test runs.
- **No fallback for unsupported platforms.** Mobile browsers, Firefox, and
  Safari cannot use reference-video extraction at all (no tab-capture
  support). This is an accepted limitation, not a bug — do not "fix" this
  by building a file-upload fallback path unless explicitly asked to.
- **`getDisplayMedia` requires a fresh permission prompt every time**
  extraction starts — there is no way to remember/skip this across
  sessions, since browsers do not allow persisting this permission for
  security reasons. This is expected, not a bug to chase.
- **YouTube's Terms of Service** generally restrict automated capture of
  their video content outside the official player/API. Never storing or
  transmitting frames reduces the risk profile significantly compared to
  downloading videos, but doesn't make this explicitly ToS-compliant. This
  is a documented, accepted tradeoff for this project, not something to
  "fix."
- **Intermittent inference FPS drops.** Inference FPS has been observed to
  intermittently drop to 2–3 (from a normal 15–23) under conditions not yet
  fully isolated — confirmed NOT caused by lighting. Root cause not
  resolved; deprioritized as out of scope for this project's timeline. If
  this resurfaces as a significant problem, revisit with a Performance-tab
  recording captured during the actual drop, not during normal operation.
- **Facial landmark hallucination when face is out of frame.** Facial
  landmarks (indices 0–10) can occasionally render at incorrect positions
  (e.g. on the torso) when the face is fully out of frame or turned away —
  a known, architecturally-inherent MediaPipe/BlazePose hallucination
  behavior, not a bug in this codebase. The renderer's visibility gate
  correctly suppresses genuinely low-confidence points, but this specific
  case can occur with artificially high visibility scores that don't get
  caught by threshold gating. Investigated using MediaPipe's `presence`
  field as a possible additional gate — inconclusive/not pursued further,
  deprioritized as out of scope. Fixing this properly would require
  architectural additions (e.g. inverse kinematics, bone-length constraints)
  that are explicitly out of scope for this project's 2D, real-time,
  lightweight-model design. Not something to revisit without a scope change.

## 4. Current repo structure

```
phase1/
├── index.html              markup only
├── css/style.css            all styling
└── js/
    ├── constants.js          landmark names, skeleton edges, thresholds, model config
    ├── camera.js              getUserMedia lifecycle only
    ├── poseDetector.js        MediaPipe load + detectForVideo wrapper
    ├── skeletonRenderer.js    canvas drawing only
    ├── telemetryPanel.js      side-panel DOM updates only
    └── main.js                 orchestration + app state, no business logic
```

## 5. Phase 1 — definition of done (met, verified in-browser)

- Camera starts/stops cleanly with proper permission-error messaging
- Start/Stop is guarded against rapid double-clicks via an `isTransitioning`
  lock (`main.js`/`camera.js`) — fixes a prior `AbortError` race between
  `video.play()` and `srcObject` teardown. Reuse this lock pattern for any
  future async lifecycle logic (e.g. calibration routine start/stop).
- 33-point pose landmarks extracted live via `PoseLandmarker`, running in a
  dedicated Web Worker (see Section 6 log) using **VIDEO mode**
  (`detectForVideo()` with `ImageBitmap` + `performance.now()` timestamp) —
  NOT image mode. Image mode was tried first per the original plan but
  caused a NORM_RECT/square-ROI bug that visibly misaligned the skeleton on
  the non-square 1280×720 feed; VIDEO mode resolved it.
- Skeleton overlay renders in sync with the mirrored video feed, confirmed
  aligned during arm/edge-of-frame movement, not just centered-and-still
- Per-joint confidence is visible in the UI, color-coded by threshold
- Inference FPS is visible and accurate
- Tab backgrounding pauses inference instead of silently degrading — confirmed
- Joint Angles and Body Tracking Quality panels were added independently to
  the telemetry UI (outside original scope). Joint Angles follows a
  confidence-gate rule: if any of the 3 landmarks defining an angle has
  visibility below `CONFIDENCE.MEDIUM`, display `—` instead of a number —
  never show a computed angle for a low-confidence joint. Apply this same
  gating rule to any future numeric display derived from landmark data.

## 6. Completed — Web Worker migration for pose detection

Status: DONE, verified (Performance tab confirms inference isolated to
worker thread; Main thread stays responsive under load).

Notable deviation from the original plan: running mode ended up as VIDEO,
not IMAGE — see Section 5 for why. Implementation required vendoring a
manually patched copy of the MediaPipe bundle to work around a real library
limitation (see "Known fragility" section below) — this was not part of
the original plan and should not be treated as a template for other
CDN dependencies.



## 7. Completed — Phase 2: Auto-Perspective Camera Calibration

Status: DONE, fully verified across 7 manual test cases (see below). Built
per `PHASE2_BRIEF.md`.

**What shipped:**
- `js/calibration.js` — a stateless `CalibrationSession` service. Measures
  shoulder-width-to-torso-height ratio across a window of high-confidence
  frames, derives `pitchOffsetDegrees` and `scaleFactor`, and returns a
  result object. Torso height is explicitly defined in-code as the
  distance between shoulder midpoint and hip midpoint.
- Calibration auto-triggers the first time the camera starts. A
  **Recalibrate** button appears afterward to re-run it on demand, no page
  reload required.
- The 3-second countdown only accumulates *good* frames — shoulder/hip
  landmarks must stay above `CONFIDENCE.MEDIUM` for a frame to count. A
  confidence dip pauses the countdown with a visible "Hold steady — losing
  tracking..." message and resumes (does not restart) once tracking
  recovers. Capped at 10 seconds of real elapsed time; if 3 good seconds
  aren't collected by then, calibration aborts cleanly with a red error
  state rather than hanging.
- Calibration runs **alongside** normal tracking, not instead of it — the
  skeleton overlay and telemetry panel keep updating live throughout the
  countdown.
- Calibration result lives as app state in `main.js` (`calibrationTransform`),
  not inside `calibration.js` — per the architectural decision in
  `PHASE2_BRIEF.md`, so Phase 4 can read it from one place later without
  reaching into the calibration module directly.
- New "Camera Calibration" telemetry panel shows live status
  (Pending / Calibrated / Aborted / Not calibrated), Pitch Offset, and
  Scale Factor.

**Verified test results (7/7 passed, each confirmed with a screenshot or
console check, not taken on summary alone):**
1. Normal completion → real output, e.g. `Pitch Offset -21° (Down)`,
   `Scale Factor 1.48x`, `Status: Calibrated`
2. Rapid double-click on Recalibrate → only one countdown runs, confirmed
   safe without an `isTransitioning` lock (see fragility note below)
3. Phase 1 regression check → camera start/stop, tab-pause all still work
4. Confidence-gating pause/resume → confirmed via screenshot showing the
   amber "Hold steady" state
5. 10-second timeout abort → confirmed via screenshot showing
   `Status: Aborted`
6. Mid-countdown Stop → clean teardown, no console errors
7. Recalibrate after a successful run → confirmed the panel's numbers
   actually change (`-25°`/`1.63x` → `-22°`/`1.50x`), not stuck or
   duplicated

**Deviation from `PHASE2_BRIEF.md` worth knowing about:**
`startCalibration()` intentionally does NOT use the `isTransitioning` lock
pattern that every other async lifecycle routine in this app uses. This
was a deliberate, verified exception, not an oversight — see the "Known
fragility" section for the reasoning. Do not "fix" this by adding the lock
back in.

## 8. Completed — Phase 3: Reference Video Keypoint Extraction

Status: DONE, fully verified across all 10 acceptance criteria in
`PHASE3_BRIEF.md`, each confirmed with direct screenshot/screen-recording
evidence rather than taken on summary alone.

**What shipped:**
- `js/referenceExtractor.js` — captures the browser tab via
  `getDisplayMedia({ preferCurrentTab: true })`, crops each frame to the
  YouTube iframe's on-screen bounding box (`getBoundingClientRect()`,
  recalculated every single frame — not cached, so it can't go stale if
  the page reflows), and runs the existing pose detector against the
  cropped result to build a timestamp-accurate `R(t)` sequence.
- Extraction runs at 2x (API-capped) sped-up YouTube playback (`setPlaybackRate(2)`), reading back `getPlaybackRate()` dynamically to rescale captured timestamps back to true video time before being stored — verified accurate against video durations up to ~8.5 minutes.
- Auto-stops when the video ends, via a dual mechanism: YouTube's
  `onStateChange`/`ENDED` event when it fires, with a `getCurrentTime()`/
  `getDuration()` polling fallback that reliably catches it when the event
  doesn't (see fragility note below — the event is inconsistent, treat
  polling as the real primary mechanism, not a backup).
- Mutually exclusive with live camera tracking — starting one visibly
  disables the other, confirmed on screen, not just enforced silently in
  code.
- `R(t)` lives in memory only for the session — confirmed lost on page
  reload, no persistence logic added (correctly deferred to Phase 6).
- Full, specific error handling: cancelled/denied tab-share permission,
  the native browser "Stop sharing" control mid-extraction, and
  embedding-disabled videos (Extract button now disables itself
  immediately via the player's `onError` callback, rather than staying
  clickable on a broken video) all produce clear, distinct, non-hanging
  UI states.
- Unsupported platforms (mobile, Firefox, Safari) show a clear
  "not supported" message with no fallback path, per spec.

**Verified test results (10/10 passed, each with real evidence — not
summarized):**
1. Correctly-rescaled `R(t)` timestamps — confirmed on 3 separate videos
   (up to 508.9s / ~8.5 min), final timestamp matched real video duration
2. Auto-stop at video end — confirmed across multiple runs
3. Crop-region isolation — confirmed via a temporary debug preview canvas
   showing tight video-only content, no YouTube page UI bleeding in
4. Cancel/deny tab-share permission — confirmed clean, non-stuck error state
5. Native browser "Stop sharing" mid-extraction — confirmed clean abort
   with real non-zero frame data captured beforehand
6. Embedding-disabled video — confirmed clear message, Extract button
   correctly disables itself
7. Mutual exclusivity with live tracking — confirmed visibly enforced
   (Start Camera button disabled during extraction)
8. Data lost on reload — confirmed, Reference Extraction panel resets to
   Idle/0 after a page reload
9. No regression to Phase 1/2 behavior — confirmed via a full manual pass
   (live tracking, confidence-gating, calibration, recalibration, clean
   stop) after all Phase 3 edits
10. Works on a different video — confirmed across 3 distinct videos of
    varying length and channel

**Deviation from `RESEARCH_SCOPE.md` worth knowing about:**
The paper describes Phase 3 as extracting keypoints "via the YouTube
IFrame API." That's not literally buildable — the IFrame API only gives
playback control, not pixel access, since YouTube's video element is
cross-origin. The actual implementation uses `getDisplayMedia()` tab
capture instead, which requires one extra one-time browser permission
prompt per reference video that the original paper doesn't account for.
Still fully on-device and private — capture produces a local
`MediaStream`, nothing is transmitted anywhere.

Next task: Phase 5 (Kinematic velocity + fatigue tracking) — brief to follow separately.

## 9. Completed — Phase 4: Dynamic Time Warping (DTW) Alignment

Status: DONE, fully verified.

**What shipped:**
- `js/angles.js` — unified joint angle extraction module used by both TelemetryPanel and DTWAligner.
- `js/calibration.js` — genuine 2D-only planar `normalize()` function with pitch angle clamping ([-60, 60] deg) and literature citations (Büker et al., Patel & Shah, Zhang et al.).
- `js/dtwAligner.js` — Sakoe-Chiba banded DTW alignment engine running over a rolling 1.5–2s user frame window on a 200ms (5Hz) throttled interval.
- **Scoring:** Primary 8-joint angle RMSE + Secondary 2D normalized coordinate mean displacement ($\lambda = 50.0^\circ/\text{unit}$).
- **Confidence Gating & Out-of-Frame:** Low-confidence joints ($< 0.4$) are excluded per-frame without pausing. If all 8 joints are untracked ($K=0$), an explicit `TRACKING_LOST` UI state is displayed with dashes (`—`) instead of a fake high-error score.
- **Telemetry UI:** Added DTW Form Alignment side panel in `index.html` featuring status, Aggregate RMSE, matched reference timestamp, and per-joint deviation cards.
