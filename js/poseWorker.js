// ============================================================
// poseWorker.js  (Web Worker — classic, NOT module)
// Job: load the MediaPipe model inside this worker thread and
// run inference on ImageBitmaps received from the main thread.
//
// Protocol:
//   Main → Worker:
//     { type: "load" }
//     { type: "detect", bitmap: ImageBitmap }
//
//   Worker → Main:
//     { type: "loaded", delegate: "GPU"|"CPU" }
//     { type: "result", landmarks: Array|null }
//     { type: "ready" }          (signals the worker is idle)
//     { type: "error", message }
//     { type: "loadProgress", stage, pct }
// ============================================================

/* Load the local, vendored MediaPipe vision bundle.
   This file was downloaded from the jsDelivr ESM CDN and patched:
   the trailing `export { ... }` was replaced with `var $mediapipe = { ... }`
   so it works inside a classic (non-module) Web Worker. */
importScripts("./vendor/mediapipe.js");

// ⚠️  SYNC WARNING — these two URLs are duplicated from js/constants.js
// because classic workers cannot import ES modules.  If you bump the
// MediaPipe model version, update BOTH files.
const WASM_BASE       = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_ASSET_PATH = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const NUM_POSES        = 1;

let landmarker = null;

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === "load"){
    try {
      self.postMessage({ type: "loadProgress", stage: "Resolving WASM runtime…", pct: 15 });

      const vision = await $mediapipe.FilesetResolver.forVisionTasks(WASM_BASE);

      self.postMessage({ type: "loadProgress", stage: "Downloading pose model…", pct: 50 });

      let delegate = "GPU";
      try {
        landmarker = await $mediapipe.PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: MODEL_ASSET_PATH,
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numPoses: NUM_POSES,
          minTrackingConfidence: 0.7
        });
      } catch (gpuErr) {
        delegate = "CPU";
        self.postMessage({ type: "loadProgress", stage: "GPU unavailable, falling back to CPU…", pct: 65 });
        landmarker = await $mediapipe.PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: MODEL_ASSET_PATH,
            delegate: "CPU"
          },
          runningMode: "VIDEO",
          numPoses: NUM_POSES,
          minTrackingConfidence: 0.7
        });
      }

      self.postMessage({ type: "loadProgress", stage: "Ready", pct: 100 });
      self.postMessage({ type: "loaded", delegate });
      self.postMessage({ type: "ready" });

    } catch (err) {
      self.postMessage({ type: "error", message: err.message });
    }

  } else if (msg.type === "detect"){
    const { bitmap, timestamp, meta } = msg;

    try {
      if (!landmarker){
        bitmap.close();
        self.postMessage({ type: "result", landmarks: null });
        self.postMessage({ type: "ready" });
        return;
      }

      const result = landmarker.detectForVideo(bitmap, timestamp);
      bitmap.close(); // release GPU/CPU memory for the bitmap

      let landmarks = null;
      if (result.landmarks && result.landmarks.length > 0){
        // Serialize to plain objects (strip MediaPipe wrapper classes)
        landmarks = result.landmarks[0].map(lm => ({
          x: lm.x,
          y: lm.y,
          z: lm.z,
          visibility: lm.visibility
        }));
      }

      self.postMessage({ type: "result", landmarks, timestamp, meta });
      self.postMessage({ type: "ready" });

    } catch (err) {
      bitmap.close();
      self.postMessage({ type: "error", message: err.message });
      self.postMessage({ type: "ready" });
    }
  }
};
