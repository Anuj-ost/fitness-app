// ============================================================
// poseDetector.js
// Job: thin proxy over the poseWorker Web Worker.
// Main thread creates ImageBitmaps and hands them off here;
// this module forwards them to the worker and relays results
// back via the onResult callback.
//
// Public API:
//   await detector.load()           → { delegate }
//   detector.sendFrame(bitmap)      → void (fire-and-forget)
//   detector.onResult = (landmarks) => { ... }
//   detector.onLoadProgress = ({ stage, pct }) => { ... }
//   detector.isLoaded()             → bool
// ============================================================

export class PoseDetector {
  constructor(){
    this._worker = new Worker("./js/poseWorker.js");
    this._loaded = false;
    this._workerIdle = false;
    this._loadResolve = null;
    this._loadReject = null;

    /** @type {(landmarks: Array|null, timestamp: number, meta: any) => void} */
    this.onResult = null;

    /** @type {({ stage: string, pct: number }) => void} */
    this.onLoadProgress = null;

    this._worker.onmessage = (e) => this._handleMessage(e.data);
    this._worker.onerror = (e) => {
      console.error("[PoseDetector] Worker error:", e);
      if (this._loadReject){
        this._loadReject(new Error(e.message));
        this._loadResolve = null;
        this._loadReject = null;
      }
    };
  }

  _handleMessage(msg){
    switch (msg.type){
      case "loaded":
        this._loaded = true;
        if (this._loadResolve){
          this._loadResolve({ delegate: msg.delegate });
          this._loadResolve = null;
          this._loadReject = null;
        }
        break;

      case "ready":
        this._workerIdle = true;
        break;

      case "result":
        if (this.onResult) this.onResult(msg.landmarks, msg.timestamp, msg.meta);
        break;

      case "loadProgress":
        if (this.onLoadProgress) this.onLoadProgress({ stage: msg.stage, pct: msg.pct });
        break;

      case "error":
        console.error("[PoseDetector] Worker reported error:", msg.message);
        if (this._loadReject){
          this._loadReject(new Error(msg.message));
          this._loadResolve = null;
          this._loadReject = null;
        }
        break;
    }
  }

  /**
   * Load the MediaPipe model inside the worker.
   * Returns a promise that resolves to { delegate: "GPU"|"CPU" }.
   */
  async load(){
    return new Promise((resolve, reject) => {
      this._loadResolve = resolve;
      this._loadReject = reject;
      this._worker.postMessage({ type: "load" });
    });
  }

  isLoaded(){
    return this._loaded;
  }

  isReady(){
    return this._loaded && this._workerIdle;
  }

  /**
   * Send an ImageBitmap to the worker for inference.
   * If the worker is still busy processing the previous frame,
   * the bitmap is closed and the frame is silently dropped
   * (back-pressure — prevents memory buildup).
   */
  sendFrame(bitmap, timestamp = performance.now(), meta = null){
    if (!this._loaded || !this._workerIdle){
      bitmap.close();
      return false;
    }
    this._workerIdle = false;
    this._worker.postMessage({ type: "detect", bitmap, timestamp, meta }, [bitmap]);
    return true;
  }
}
