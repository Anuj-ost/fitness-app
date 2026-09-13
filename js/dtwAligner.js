// ============================================================
// dtwAligner.js
// Incremental Streaming DTW Engine.
// Aligns live user pose against reference sequence R(t) using a
// local-neighborhood search that structurally prevents distant jumps.
//
// Features:
// - Frame-by-frame walk: starts at 0, searches only ± small window.
// - Pace limiter: caps forward advancement at 2.0x real time.
// - Rest/Occlusion detection: 4-second rolling window triggers PAUSED.
// - Primary 8-joint angle RMSE + Secondary 2D normalized coordinate error.
// - Confidence-gated joint exclusion (CONFIDENCE.MEDIUM = 0.4).
// - Explicit TRACKING_LOST state when K=0 valid joints.
// - Capture gap detection.
// ============================================================

import { CONFIDENCE, JOINT_ANGLES } from "./constants.js";
import { computeAllJointAngles } from "./angles.js";

// Key landmark indices used for secondary 2D coordinate distance comparison
const KEY_COORD_LANDMARKS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]; // shoulders, elbows, wrists, hips, knees, ankles

// Default threshold for detecting capture gaps in reference data (ms)
const GAP_THRESHOLD_MS = 5000;

export class DTWAligner {
  /**
   * @param {object} [options]
   * @param {number} [options.throttleIntervalMs=200] Recompute throttle interval (ms)
   * @param {number} [options.lambda=50.0] Scale factor for secondary 2D coord distance
   * @param {number} [options.maxPaceRatio=2.0] Max allowed ref time advancement per real time
   */
  constructor(options = {}) {
    this.throttleIntervalMs = options.throttleIntervalMs || 200;
    this.lambda = options.lambda !== undefined ? options.lambda : 50.0;
    this.gapThresholdMs = GAP_THRESHOLD_MS;
    
    // Limits
    this.backLook = 5;    // frames to look backward (allow small repeated motions)
    this.forwardLook = 15; // frames to look forward
    this.maxPaceRatio = options.maxPaceRatio || 2.0;

    this.referenceSequence = null;
    this.calibrationTransform = null;

    this.isAligning = false;
    this.lastRecomputeTime = 0;
    
    this._refCursor = 0;
    this.captureGaps = [];

    // TEMP DEBUG — per-tick DTW comparison log (cleared on reset/reload)
    this._debugLog = [];
    
    // Callbacks
    this.onAlignmentUpdate = null;
    this.onCaptureGapsDetected = null;
    
    // History buffers for 4-second window (20 frames at 5Hz)
    this.historyWindowSec = 4.0;
    this.historyFrames = Math.ceil(this.historyWindowSec / (this.throttleIntervalMs / 1000));
    
    this.userAngleHistory = [];
    this.matchRmseHistory = [];
    this.paceHistory = [];
    
    // "NONE", "POOR_MATCH", "RESTING"
    this.pauseState = "NONE";

    this._lastResult = {
      status: "IDLE",
      aggregateRmse: null,
      coordDeviation: null,
      compositeScore: null,
      matchedRefTime: 0,
      matchedRefFrame: 0,
      jointDeviations: {}
    };
  }

  setReferenceSequence(rawSequence) {
    if (!rawSequence || rawSequence.length === 0) {
      this.referenceSequence = null;
      this.captureGaps = [];
      return;
    }

    this.referenceSequence = rawSequence.map((frame, idx) => {
      const angles = computeAllJointAngles(frame.landmarks);
      const normCoords = this._preprocessReferenceCoords(frame.landmarks);
      return {
        frameIndex: idx,
        timestamp: frame.timeMs,
        landmarks: frame.landmarks,
        angles,
        normCoords
      };
    });

    this._detectCaptureGaps();
  }

  _detectCaptureGaps() {
    this.captureGaps = [];
    if (!this.referenceSequence || this.referenceSequence.length < 2) return;

    for (let i = 1; i < this.referenceSequence.length; i++) {
      const prev = this.referenceSequence[i - 1];
      const curr = this.referenceSequence[i];
      const delta = curr.timestamp - prev.timestamp;

      if (delta > this.gapThresholdMs) {
        const gap = {
          startMs: prev.timestamp,
          endMs: curr.timestamp,
          durationMs: Math.round(delta),
          afterFrameIndex: i - 1,
          beforeFrameIndex: i
        };
        this.captureGaps.push(gap);
        console.warn(`[Aligner] Capture gap detected: ${(gap.startMs / 1000).toFixed(1)}s → ${(gap.endMs / 1000).toFixed(1)}s`);
      }
    }

    if (this.captureGaps.length > 0 && this.onCaptureGapsDetected) {
      this.onCaptureGapsDetected(this.captureGaps);
    }
  }

  _checkGap(timeMs) {
    for (const gap of this.captureGaps) {
      if (timeMs >= gap.startMs && timeMs <= gap.endMs) {
        return { inGap: true, gap };
      }
    }
    return { inGap: false, gap: null };
  }

  _preprocessReferenceCoords(landmarks) {
    if (!landmarks || landmarks.length < 33) return null;
    const lS = landmarks[11], rS = landmarks[12], lH = landmarks[23], rH = landmarks[24];
    if (!lS || !rS || !lH || !rH) return null;

    const torsoMid = {
      x: (lS.x + rS.x + lH.x + rH.x) / 4,
      y: (lS.y + rS.y + lH.y + rH.y) / 4
    };

    const dxS = lS.x - rS.x, dyS = lS.y - rS.y;
    const shoulderWidth = Math.sqrt(dxS * dxS + dyS * dyS);
    const midS = { x: (lS.x + rS.x) / 2, y: (lS.y + rS.y) / 2 };
    const midH = { x: (lH.x + rH.x) / 2, y: (lH.y + rH.y) / 2 };
    const dxT = midS.x - midH.x, dyT = midS.y - midH.y;
    const torsoHeight = Math.sqrt(dxT * dxT + dyT * dyT);

    const refScale = torsoHeight > 0 ? 0.65 / (shoulderWidth / torsoHeight) : 1.0;

    return KEY_COORD_LANDMARKS.map(idx => {
      const lm = landmarks[idx];
      if (!lm) return { x: 0, y: 0, visibility: 0 };
      return {
        x: (lm.x - torsoMid.x) * refScale,
        y: (lm.y - torsoMid.y) * refScale,
        visibility: lm.visibility ?? 1
      };
    });
  }

  setCalibrationTransform(transform) {
    this.calibrationTransform = transform;
  }

  start() {
    this.isAligning = true;
    this.lastRecomputeTime = 0;
    this._refCursor = 0;
    
    this.userAngleHistory = [];
    this.matchRmseHistory = [];
    this.paceHistory = [];
    this.pauseState = "NONE";
  }

  stop() {
    this.isAligning = false;
    this._debugLog = [];  // TEMP DEBUG — clear log on session stop
    this._lastResult = {
      status: "IDLE",
      aggregateRmse: null,
      coordDeviation: null,
      compositeScore: null,
      matchedRefTime: 0,
      matchedRefFrame: 0,
      jointDeviations: {}
    };
  }

  processFrame(landmarks, timestamp = performance.now()) {
    if (!this.isAligning || !this.referenceSequence) return null;

    const now = performance.now();
    if (now - this.lastRecomputeTime < this.throttleIntervalMs) {
      return this._lastResult;
    }
    this.lastRecomputeTime = now;

    const userAngles = computeAllJointAngles(landmarks);
    const userFrame = { landmarks, angles: userAngles };
    
    // Check TRACKING_LOST
    const validUserJoints = Object.values(userAngles).filter(j => j.isValid).length;
    if (validUserJoints === 0) {
      return this._emitResult({
        status: "TRACKING_LOST",
        aggregateRmse: null,
        coordDeviation: null,
        compositeScore: null,
        matchedRefTime: this.referenceSequence[this._refCursor].timestamp,
        matchedRefFrame: this._refCursor,
        jointDeviations: this._getEmptyJointDeviations()
      });
    }

    // Update angle history for motion variance
    const extractedAngles = {};
    for (const key of Object.keys(JOINT_ANGLES)) {
      extractedAngles[key] = userAngles[key].isValid ? userAngles[key].angle : null;
    }
    this.userAngleHistory.push(extractedAngles);
    if (this.userAngleHistory.length > this.historyFrames) this.userAngleHistory.shift();

    // Calculate motion standard deviation
    const motionStdev = this._calcUserMotion();

    // Check Pace Limiter
    let paceRatio = 1.0;
    if (this.paceHistory.length >= 5) {
      const oldest = this.paceHistory[0];
      const newest = this.paceHistory[this.paceHistory.length - 1];
      const realElapsed = newest.realTimeMs - oldest.realTimeMs;
      const refElapsed = newest.refTimeMs - oldest.refTimeMs;
      if (realElapsed > 0) {
        paceRatio = refElapsed / realElapsed;
      }
    }

    let forwardSearch = this.forwardLook;
    let backwardSearch = this.backLook;
    
    // Cap advancement if moving too fast through the reference
    if (paceRatio > this.maxPaceRatio) {
      forwardSearch = 0;
    }
    
    // Freeze cursor if paused
    if (this.pauseState !== "NONE") {
      forwardSearch = 0;
      backwardSearch = 0;
    }

    const M = this.referenceSequence.length;
    const minK = Math.max(0, this._refCursor - backwardSearch);
    const maxK = Math.min(M - 1, this._refCursor + forwardSearch);

    let bestK = this._refCursor;
    let minCost = Infinity;
    let bestPairCost = null;

    // Local search window
    for (let k = minK; k <= maxK; k++) {
      const pairCost = this._calcFrameDistance(userFrame, this.referenceSequence[k]);
      if (pairCost && pairCost.compositeCost < minCost) {
        minCost = pairCost.compositeCost;
        bestK = k;
        bestPairCost = pairCost;
      }
    }
    
    if (bestPairCost) {
      this._refCursor = bestK;
      this.matchRmseHistory.push(bestPairCost.dAngles);
      if (this.matchRmseHistory.length > this.historyFrames) this.matchRmseHistory.shift();
      
      this.paceHistory.push({ realTimeMs: now, refTimeMs: this.referenceSequence[this._refCursor].timestamp });
      if (this.paceHistory.length > this.historyFrames) this.paceHistory.shift();
      
      // Update Pause State Machine
      const avgRmse = this.matchRmseHistory.length > 0 ? 
        this.matchRmseHistory.reduce((a,b)=>a+b, 0) / this.matchRmseHistory.length : 0;
      
      const historyFull = this.matchRmseHistory.length >= this.historyFrames;

      if (this.pauseState === "NONE" && historyFull) {
        if (avgRmse > 40.0) {
          this.pauseState = "POOR_MATCH";
        } else if (motionStdev !== Infinity && motionStdev < 3.0) {
          this.pauseState = "RESTING";
        }
      } else if (this.pauseState === "POOR_MATCH") {
        if (bestPairCost.dAngles < 30.0) {
          this._clearHistories();
        }
      } else if (this.pauseState === "RESTING") {
        if (motionStdev !== Infinity && motionStdev > 5.0) {
          this._clearHistories();
        }
      }
    }

    // Gap check
    const matchedRefMs = this.referenceSequence[this._refCursor].timestamp;
    const gapCheck = this._checkGap(matchedRefMs);
    let status = this.pauseState !== "NONE" ? "PAUSED" : "OK";
    if (gapCheck.inGap) status = "REF_GAP";
    
    if (Math.random() < 0.1) {
      console.log(
        `[Aligner] cursor=${this._refCursor}/${M}, pace=${paceRatio.toFixed(1)}x, RMSE=${bestPairCost ? bestPairCost.dAngles.toFixed(1) : '-'}°, status=${status}`
      );
    }

    if (!bestPairCost) {
      return this._emitResult({
        status: "TRACKING_LOST",
        aggregateRmse: null,
        coordDeviation: null,
        compositeScore: null,
        matchedRefTime: matchedRefMs,
        matchedRefFrame: this._refCursor,
        jointDeviations: this._getEmptyJointDeviations()
      });
    }

    // ---- TEMP DEBUG — log one row per throttled DTW tick ----
    const refFrame = this.referenceSequence[this._refCursor];
    const userAngleObj = {};
    for (const [id, d] of Object.entries(userAngles)) {
      userAngleObj[id.substring(1)] = d.isValid ? d.angle : null;
    }
    const refAngleObj = {};
    for (const [id, d] of Object.entries(refFrame.angles)) {
      refAngleObj[id.substring(1)] = d.isValid ? d.angle : null;
    }
    this._debugLog.push({
      userTimeMs:     now,
      matchedRefTime: matchedRefMs,
      userAngles:     userAngleObj,
      refAngles:      refAngleObj,
      aggregateRmse:  Math.round(bestPairCost.dAngles),
      bestJ:          this._refCursor,
      dtwStatus:      status
    });
    // ---- END TEMP DEBUG ----

    return this._emitResult({
      status: status,
      pauseReason: this.pauseState,
      aggregateRmse: Math.round(bestPairCost.dAngles),
      coordDeviation: parseFloat(bestPairCost.dCoords.toFixed(4)),
      compositeScore: Math.round(bestPairCost.compositeCost),
      matchedRefTime: matchedRefMs,
      matchedRefFrame: this._refCursor,
      jointDeviations: bestPairCost.jointDeviations
    });
  }
  
  _clearHistories() {
    this.pauseState = "NONE";
    this.matchRmseHistory = [];
    this.userAngleHistory = [];
    this.paceHistory = [];
  }

  _calcUserMotion() {
    if (this.userAngleHistory.length < 5) return Infinity; 
    
    let totalVar = 0;
    let validJoints = 0;
    
    for (const jointId of Object.keys(JOINT_ANGLES)) {
      const vals = this.userAngleHistory.map(h => h[jointId]).filter(v => v !== null);
      if (vals.length > this.userAngleHistory.length * 0.5) {
        const mean = vals.reduce((a,b) => a+b, 0) / vals.length;
        const variance = vals.reduce((a,b) => a + Math.pow(b - mean, 2), 0) / vals.length;
        totalVar += Math.sqrt(variance);
        validJoints++;
      }
    }
    return validJoints > 0 ? (totalVar / validJoints) : Infinity;
  }

  _emitResult(result) {
    this._lastResult = result;
    if (this.onAlignmentUpdate) this.onAlignmentUpdate(result);
    return result;
  }

  _calcFrameDistance(userFrame, refFrame) {
    const uAngles = userFrame.angles;
    const rAngles = refFrame.angles;

    let sumSqAngleErr = 0;
    let validJointCount = 0;
    const jointDeviations = {};

    for (const [id, uObj] of Object.entries(uAngles)) {
      const rObj = rAngles[id];
      if (uObj.isValid && rObj && rObj.isValid && uObj.angle !== null && rObj.angle !== null) {
        const diff = Math.abs(uObj.angle - rObj.angle);
        sumSqAngleErr += diff * diff;
        validJointCount++;
        jointDeviations[id] = { deviation: Math.round(diff), isValid: true };
      } else {
        jointDeviations[id] = { deviation: null, isValid: false };
      }
    }

    if (validJointCount === 0) return null;

    const dAngles = Math.sqrt(sumSqAngleErr / validJointCount);

    let sumCoordDist = 0;
    let validCoordCount = 0;

    if (refFrame.normCoords) {
      let uNormCoords = null;
      if (this.calibrationTransform && this.calibrationTransform.normalizeLandmarks) {
        const normalizedLandmarks = this.calibrationTransform.normalizeLandmarks(userFrame.landmarks);
        uNormCoords = KEY_COORD_LANDMARKS.map(idx => normalizedLandmarks[idx]);
      } else {
        const uLms = userFrame.landmarks;
        const lS = uLms[11], rS = uLms[12], lH = uLms[23], rH = uLms[24];
        if (lS && rS && lH && rH) {
          const torsoMid = { x: (lS.x + rS.x + lH.x + rH.x) / 4, y: (lS.y + rS.y + lH.y + rH.y) / 4 };
          const dxS = lS.x - rS.x, dyS = lS.y - rS.y;
          const sW = Math.sqrt(dxS * dxS + dyS * dyS);
          const midS = { x: (lS.x + rS.x) / 2, y: (lS.y + rS.y) / 2 };
          const midH = { x: (lH.x + rH.x) / 2, y: (lH.y + rH.y) / 2 };
          const dxT = midS.x - midH.x, dyT = midS.y - midH.y;
          const tH = Math.sqrt(dxT * dxT + dyT * dyT);
          const uScale = tH > 0 ? 0.65 / (sW / tH) : 1.0;

          uNormCoords = KEY_COORD_LANDMARKS.map(idx => {
            const lm = uLms[idx];
            if (!lm) return null;
            return {
              x: (lm.x - torsoMid.x) * uScale,
              y: (lm.y - torsoMid.y) * uScale,
              visibility: lm.visibility ?? 1
            };
          });
        }
      }

      if (uNormCoords) {
        uNormCoords.forEach((uPt, i) => {
          const rPt = refFrame.normCoords[i];
          if (uPt && rPt && (uPt.visibility ?? 1) > CONFIDENCE.MEDIUM && (rPt.visibility ?? 1) > CONFIDENCE.MEDIUM) {
            const dx = uPt.x - rPt.x;
            const dy = uPt.y - rPt.y;
            sumCoordDist += Math.sqrt(dx * dx + dy * dy);
            validCoordCount++;
          }
        });
      }
    }

    const dCoords = validCoordCount > 0 ? sumCoordDist / validCoordCount : 0;
    const compositeCost = dAngles + (this.lambda * dCoords);

    return { dAngles, dCoords, compositeCost, jointDeviations };
  }

  _getEmptyJointDeviations() {
    const res = {};
    for (const key of Object.keys(JOINT_ANGLES)) {
      res[key] = { deviation: null, isValid: false };
    }
    return res;
  }

  // ---- TEMP DEBUG — debug log accessors ----
  /** @returns {Array} shallow copy of the accumulated debug log */
  getDebugLog() { return this._debugLog.slice(); }

  /** Clears the debug log (called on session reset). */
  resetDebugLog() { this._debugLog = []; }
  // ---- END TEMP DEBUG ----
}
