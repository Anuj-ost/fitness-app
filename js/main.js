// ============================================================
// main.js
// Job: wire the pieces together and own the app's start/stop state.
// This file should stay "thin" — if you find yourself writing real
// logic here (drawing, detection details, camera details), that
// logic probably belongs in one of the other modules instead.
//
// Web Worker architecture:
//   processFrame() captures an ImageBitmap from the <video> and
//   transfers it (zero-copy) to the worker via detector.sendFrame().
//   Results arrive asynchronously via detector.onResult callback,
//   which invokes drawSkeleton + telemetry.updateLandmarks.
// ============================================================

import { Camera } from "./camera.js";
import { PoseDetector } from "./poseDetector.js";
import { drawSkeleton, clearCanvas } from "./skeletonRenderer.js";
import { TelemetryPanel } from "./telemetryPanel.js";
import { JOINT_ANGLES } from "./constants.js";
import { CalibrationSession } from "./calibration.js";
import { ReferenceExtractor } from "./referenceExtractor.js";
import { DTWAligner } from "./dtwAligner.js";
import { LandmarkFilter } from "./oneEuroFilter.js";

// ---- DOM references ----
const video    = document.getElementById("video");
const canvas   = document.getElementById("overlay");
const ctx      = canvas.getContext("2d");
const stage    = document.getElementById("stage");

const stageGrid         = document.getElementById("stageGrid");
const refStage          = document.getElementById("refStage");
const ytPlayerContainer = document.getElementById("ytPlayerContainer");

const stageEmpty    = document.getElementById("stageEmpty");
const stageBadge    = document.getElementById("stageBadge");
const reticle       = document.getElementById("reticle");
const angleOverlay  = document.getElementById("angleOverlay");

const startBtn      = document.getElementById("startBtn");
const stopBtn       = document.getElementById("stopBtn");
const recalBtn      = document.getElementById("recalBtn");
const snapBtn       = document.getElementById("snapBtn");
const fsBtn         = document.getElementById("fsBtn");
const cameraSelect  = document.getElementById("cameraSelect");
const errorBanner   = document.getElementById("errorBanner");
const ytUrl         = document.getElementById("ytUrl");
const ytLoadBtn     = document.getElementById("ytLoadBtn");
const ytExtractBtn  = document.getElementById("ytExtractBtn");
const ytStopBtn     = document.getElementById("ytStopBtn");
const ytInstructions = document.getElementById("ytInstructions");

const telemetry = new TelemetryPanel({
  mModel:         document.getElementById("mModel"),
  mDelegate:      document.getElementById("mDelegate"),
  mLoad:          document.getElementById("mLoad"),
  mRes:           document.getElementById("mRes"),
  mFps:           document.getElementById("mFps"),
  mCount:         document.getElementById("mCount"),
  statusText:     document.getElementById("statusText"),
  statusDot:      document.getElementById("statusDot"),
  fpsBadge:       document.getElementById("fpsBadge"),
  landmarkScroll: document.getElementById("landmarkScroll"),
  angleOverlay:   document.getElementById("angleOverlay"),
  // Gauge + stability
  gaugeCircle:    document.getElementById("gaugeCircle"),
  gaugePct:       document.getElementById("gaugePct"),
  mStability:     document.getElementById("mStability"),
  stabilityFill:  document.getElementById("stabilityFill"),
  // Loading overlay
  loadingOverlay: document.getElementById("loadingOverlay"),
  loadingText:    document.getElementById("loadingText"),
  loadBar:        document.getElementById("loadBar"),
  loadBarFill:    document.getElementById("loadBarFill"),
  // Calibration
  cStatus:        document.getElementById("cStatus"),
  cPitch:         document.getElementById("cPitch"),
  cScale:         document.getElementById("cScale"),
  calOverlay:     document.getElementById("calibrationOverlay"),
  calStatusText:  document.getElementById("calStatusText"),
  calBarFill:     document.getElementById("calBarFill"),
  // Extraction
  eStatus:        document.getElementById("eStatus"),
  eTime:          document.getElementById("eTime"),
  eFrames:        document.getElementById("eFrames"),
  // Alignment
  dStatus:        document.getElementById("dStatus"),
  dRmse:          document.getElementById("dRmse"),
  dMatchTime:     document.getElementById("dMatchTime"),
});

// ---- App instances ----
const camera   = new Camera(video);
const detector = new PoseDetector();
const extractor = new ReferenceExtractor(detector, telemetry);
const dtwAligner = new DTWAligner();
const landmarkFilter = new LandmarkFilter();

dtwAligner.onAlignmentUpdate = (res) => {
  telemetry.updateAlignmentResults(res);
};

extractor.onPlayerError = (err) => {
  showError(err.message);
  telemetry.setExtractionStatus("Error", true);
  ytExtractBtn.disabled = true;
  ytInstructions.style.display = "none";
};

// ---- App state ----
let running = false;
let paused  = false;
let isTransitioning = false;
let vfcId   = null;
let frameTimes = [];
let calibrationTransform = null;
let activeCalibration = null;
let referenceSequence = null;

let passivePollInterval = null;
let isPassivePlaying    = false;

// ---- Toast ----
const toast = document.getElementById("toast");
let toastTimer = null;
function showToast(msg, durationMs = 2000){
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), durationMs);
}

// ---- Helpers ----
function showError(msg){
  errorBanner.textContent = msg;
  errorBanner.classList.add("show");
}
function clearError(){
  errorBanner.classList.remove("show");
  errorBanner.textContent = "";
}

// ---- Passive Reference Video Playback Control (1x Normal Speed) ----
function startPassivePlayback() {
  if (!extractor || !extractor.player) return;

  isPassivePlaying = true;
  try {
    if (extractor.player.seekTo) extractor.player.seekTo(0, true);
    if (extractor.player.setPlaybackRate) extractor.player.setPlaybackRate(1);
    if (extractor.player.playVideo) extractor.player.playVideo();
  } catch (e) {
    console.warn("Error starting passive YouTube playback:", e);
  }

  // Polling loop to sync video end with alignment lifecycle
  if (passivePollInterval) clearInterval(passivePollInterval);
  passivePollInterval = setInterval(() => {
    if (!isPassivePlaying || !extractor.player) return;
    try {
      if (extractor.player.getCurrentTime && extractor.player.getDuration) {
        const currentTime = extractor.player.getCurrentTime();
        const duration = extractor.player.getDuration();
        if (duration > 0 && currentTime >= duration - 0.2) {
          console.log("[Passive Playback] End reached via polling.");
          stopPassivePlayback();
          if (dtwAligner.isAligning) {
            dtwAligner.stop();
            telemetry.setDtwStatus("Completed");
          }
        }
      }
    } catch (e) {
      // Ignore transient YouTube player API errors during polling
    }
  }, 200);
}

function stopPassivePlayback() {
  isPassivePlaying = false;
  if (passivePollInterval) {
    clearInterval(passivePollInterval);
    passivePollInterval = null;
  }
  if (extractor && extractor.player && extractor.player.pauseVideo) {
    try {
      extractor.player.pauseVideo();
    } catch (e) {}
  }
}

// ---- Camera enumeration ----
async function populateCameraSelect(){
  const cameras = await Camera.enumerate();
  cameraSelect.innerHTML = "";
  if (cameras.length === 0){
    cameraSelect.innerHTML = '<option value="">No cameras found</option>';
    return;
  }
  cameras.forEach(cam => {
    const opt = document.createElement("option");
    opt.value = cam.deviceId;
    opt.textContent = cam.label;
    cameraSelect.appendChild(opt);
  });
}
populateCameraSelect();

// ---- Visibility change: pause inference & video when tab is hidden ----
document.addEventListener("visibilitychange", () => {
  if (!running) return;
  paused = document.hidden;
  telemetry.setStatus(paused ? "PAUSED (tab hidden)" : "TRACKING", paused ? "" : "live");
  if (!paused) frameTimes = [];

  if (paused) {
    stopPassivePlayback();
  } else if (referenceSequence && referenceSequence.length > 0 && dtwAligner.isAligning) {
    startPassivePlayback();
  }
});

// ---- Wire up async results from the worker ----
detector.onResult = (landmarks, timestamp, meta) => {
  if (extractor && extractor.isExtracting) {
    extractor.handleResult(landmarks, meta);
    return; // Don't run live tracking logic while extracting
  }

  if (!running || !landmarks) return;

  // Smooth high-frequency jitter via 1€ filter (Casiez et al. 2012)
  // before any downstream consumer sees the landmarks.
  landmarks = landmarkFilter.apply(landmarks, timestamp);

  drawSkeleton(ctx, canvas, landmarks);
  telemetry.updateLandmarks(landmarks);

  // FPS is counted when results arrive (measures actual inference throughput)
  const now = performance.now();
  frameTimes.push(now);
  frameTimes = frameTimes.filter(t => now - t < 1000);
  telemetry.setFps(frameTimes.length);

  // Run calibration if active
  if (activeCalibration) {
    const state = activeCalibration.process(landmarks);
    
    if (state.status === 'aborted') {
      telemetry.showCalibrationOverlay(false);
      activeCalibration = null;
      showError(state.message);
      recalBtn.style.display = "inline-block";
      telemetry.setCalibrationStatus("Aborted", true);
    } else if (state.status === 'done') {
      telemetry.showCalibrationOverlay(false);
      calibrationTransform = state.result;
      dtwAligner.setCalibrationTransform(calibrationTransform);
      activeCalibration = null;
      recalBtn.style.display = "inline-block";
      telemetry.setCalibrationResult(calibrationTransform);
      showToast("Calibration successful");
    } else {
      telemetry.updateCalibrationOverlay(state.message, state.progress, state.status === 'paused');
    }
  }

  // Run live DTW alignment if active
  if (dtwAligner.isAligning) {
    dtwAligner.processFrame(landmarks, timestamp);
  }
};

detector.onLoadProgress = ({ stage: stageName, pct }) => {
  telemetry.showLoading(stageName);
  telemetry.setLoadProgress(pct);
  telemetry.setModelStatus(stageName);
};

// ---- Core frame loop (async — captures bitmap and sends to worker) ----
async function processFrame(){
  if (!running) return;

  if (!paused && video.readyState >= 2 && detector.isReady()){
    try {
      const bitmap = await createImageBitmap(video);
      detector.sendFrame(bitmap, performance.now()); // zero-copy transfer; pass timestamp for VIDEO mode
    } catch (e) {
      // createImageBitmap can fail if video is not ready yet — silently skip
    }
  }

  scheduleNextFrame();
}

function scheduleNextFrame(){
  if (!running) return;
  if ("requestVideoFrameCallback" in video){
    vfcId = video.requestVideoFrameCallback(() => processFrame());
  } else {
    vfcId = requestAnimationFrame(() => processFrame()); // fallback for older browsers
  }
}

// ---- Calibration Start ----
function startCalibration() {
  if (activeCalibration || !running || extractor.isExtracting) return;
  
  clearError();
  calibrationTransform = null;
  activeCalibration = new CalibrationSession();
  
  telemetry.setCalibrationResult(null);
  telemetry.showCalibrationOverlay(true);
  telemetry.updateCalibrationOverlay("Calibrating...", 0, false);
  
  recalBtn.style.display = "none";
}

// ---- Start / stop ----
async function startCamera(){
  if (isTransitioning || extractor.isExtracting) return;
  isTransitioning = true;
  
  clearError();
  startBtn.disabled = true;
  ytExtractBtn.disabled = true; // Mutual exclusivity during extraction
  telemetry.setStatus("INITIALIZING", "");

  try {
    if (!detector.isLoaded()){
      telemetry.setModelStatus("loading WASM + model…");
      const { delegate } = await detector.load();
      telemetry.setDelegate(delegate);
      telemetry.setModelStatus("ready");
      telemetry.hideLoading();
    }

    const selectedId = cameraSelect.value;
    const { width, height } = await camera.start(selectedId || undefined);

    // Re-enumerate now that permission is granted (labels become available)
    populateCameraSelect();

    stageEmpty.style.display = "none";
    stageBadge.style.display = "flex";
    document.getElementById("fpsBadge").style.display = "block";
    angleOverlay.style.display = "flex";
    reticle.classList.add("active");
    stage.classList.add("active");

    telemetry.setResolution(width, height);
    canvas.width = width;
    canvas.height = height;

    running = true;
    paused  = false;
    stopBtn.disabled = false;
    snapBtn.disabled = false;
    telemetry.setStatus("TRACKING", "live");

    frameTimes = [];
    scheduleNextFrame();
    
    if (!calibrationTransform) {
      startCalibration();
    } else {
      recalBtn.style.display = "inline-block";
    }

    // Auto-start alignment & side-by-side view if reference sequence exists
    if (referenceSequence && referenceSequence.length > 0) {
      stageGrid.classList.add("dual-stage");
      refStage.style.display = "flex";
      ytPlayerContainer.style.display = "block";
      dtwAligner.start();
      telemetry.setDtwStatus("Aligning...");
      startPassivePlayback();
    } else {
      stageGrid.classList.remove("dual-stage");
      refStage.style.display = "none";
    }

  } catch (err){
    console.error(err);
    telemetry.setStatus("ERROR", "");
    telemetry.hideLoading();
    startBtn.disabled = false;

    if (err.name === "NotAllowedError"){
      showError("Camera permission was denied. Allow camera access in your browser's site settings and try again.");
    } else if (err.name === "NotFoundError"){
      showError("No camera device was found on this machine.");
    } else {
      showError("Startup failed: " + err.message);
    }
  } finally {
    isTransitioning = false;
  }
}

async function stopCamera(){
  if (isTransitioning) return;
  isTransitioning = true;

  try {
    running = false;
    landmarkFilter.reset();
    if (vfcId && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(vfcId);

    await camera.stop();
    clearCanvas(ctx, canvas);

    stageEmpty.style.display = "flex";
    stageBadge.style.display = "none";
    document.getElementById("fpsBadge").style.display = "none";
    angleOverlay.style.display = "none";
    reticle.classList.remove("active");
    stage.classList.remove("active");

    if (activeCalibration) {
      activeCalibration = null;
      telemetry.showCalibrationOverlay(false);
      telemetry.setCalibrationStatus("Not calibrated", true);
    }
    recalBtn.style.display = "none";

    if (dtwAligner.isAligning) {
      dtwAligner.stop();
      telemetry.setDtwStatus("Idle");
    }

    stopPassivePlayback();
    stageGrid.classList.remove("dual-stage");

    startBtn.disabled = false;
    stopBtn.disabled  = true;
    snapBtn.disabled  = true;
    ytExtractBtn.disabled = false; // Restore extraction ability
    telemetry.setStatus("IDLE", "");
    telemetry.reset();
  } finally {
    isTransitioning = false;
  }
}

// ---- Screenshot ----
function takeScreenshot(){
  if (!running) return;
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = canvas.width;
  tempCanvas.height = canvas.height;
  const tctx = tempCanvas.getContext("2d");

  // Draw mirrored video
  tctx.save();
  tctx.scale(-1, 1);
  tctx.drawImage(video, -tempCanvas.width, 0, tempCanvas.width, tempCanvas.height);
  tctx.restore();

  // Draw skeleton overlay (mirrored to match CSS transform)
  tctx.save();
  tctx.scale(-1, 1);
  tctx.drawImage(canvas, -tempCanvas.width, 0, tempCanvas.width, tempCanvas.height);
  tctx.restore();

  const link = document.createElement("a");
  link.download = `pose-snapshot-${Date.now()}.png`;
  link.href = tempCanvas.toDataURL("image/png");
  link.click();

  showToast("📷 Screenshot saved");
}

// ---- Fullscreen ----
function toggleFullscreen(){
  if (!document.fullscreenElement){
    stage.requestFullscreen().catch(err => {
      console.warn("Error attempting to enable fullscreen:", err);
    });
  } else {
    document.exitFullscreen();
  }
}

// ---- YouTube Reference Extraction Events ----
function extractVideoId(url) {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([^&?]+)/);
  return match ? match[1] : null;
}

ytLoadBtn.addEventListener("click", async () => {
  const url = ytUrl.value.trim();
  const videoId = extractVideoId(url);
  if (!videoId) {
    showError("Invalid YouTube URL");
    return;
  }
  
  clearError();
  ytLoadBtn.disabled = true;
  ytExtractBtn.disabled = true;
  ytInstructions.style.display = "none";
  telemetry.setExtractionStatus("Loading Player...");
  
  try {
    await extractor.initPlayer(videoId);
    refStage.style.display = "flex";
    ytPlayerContainer.style.display = "block";
    telemetry.setExtractionStatus("Ready", false);
    ytInstructions.style.display = "block";
    ytExtractBtn.disabled = false;
  } catch (err) {
    showError(err.message);
    telemetry.setExtractionStatus("Error", true);
  } finally {
    ytLoadBtn.disabled = false;
  }
});

ytExtractBtn.addEventListener("click", async () => {
  if (running) {
    showError("Cannot extract while live tracking is running. Stop camera first.");
    return;
  }
  
  clearError();
  ytExtractBtn.disabled = true;
  ytStopBtn.disabled = false;
  startBtn.disabled = true; // mutual exclusivity during extraction
  
  if (!detector.isLoaded()){
    telemetry.setModelStatus("loading WASM + model…");
    const { delegate } = await detector.load();
    telemetry.setDelegate(delegate);
    telemetry.setModelStatus("ready");
    telemetry.hideLoading();
  }
  
  try {
    await extractor.startExtraction((sequence) => {
      referenceSequence = sequence;
      dtwAligner.setReferenceSequence(sequence);
      ytExtractBtn.disabled = false;
      ytStopBtn.disabled = true;
      startBtn.disabled = false;
      refStage.style.display = "flex";
      ytPlayerContainer.style.display = "block";
      telemetry.setDtwStatus("Ready (Reference Loaded)");
      showToast(`Extraction complete: ${sequence.length} frames`);
    }, (err) => {
      showError(err.message);
      ytExtractBtn.disabled = false;
      ytStopBtn.disabled = true;
      startBtn.disabled = false;
    });
  } catch (err) {
    showError(err.message);
    ytExtractBtn.disabled = false;
    ytStopBtn.disabled = true;
    startBtn.disabled = false;
  }
});

ytStopBtn.addEventListener("click", () => {
  extractor.stopExtraction("Extraction stopped by user.");
});

// ---- Event wiring ----
startBtn.addEventListener("click", startCamera);
stopBtn.addEventListener("click", stopCamera);
recalBtn.addEventListener("click", startCalibration);
snapBtn.addEventListener("click", takeScreenshot);
fsBtn.addEventListener("click", toggleFullscreen);

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
  if (e.code === "Space"){
    e.preventDefault();
    if (running) stopCamera(); else startCamera();
  } else if (e.code === "KeyF"){
    toggleFullscreen();
  } else if (e.code === "KeyS"){
    takeScreenshot();
  }
});

window.addEventListener("beforeunload", () => camera.stop());

