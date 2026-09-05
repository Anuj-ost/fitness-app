// ============================================================
// dtwAligner.js
// Dynamic Time Warping (DTW) Alignment Engine.
// Aligns live user motion (rolling window) against reference video sequence R(t).
//
// Features:
// - Throttled DTW computation (200ms interval / 5Hz)
// - Sakoe-Chiba band constraint for fast streaming alignment
// - Primary 8-joint angle RMSE + Secondary 2D normalized coordinate error
// - Confidence-gated joint exclusion (CONFIDENCE.MEDIUM = 0.4)
// - Explicit TRACKING_LOST state when K=0 valid joints
// ============================================================

import { CONFIDENCE, JOINT_ANGLES } from "./constants.js";
import { computeAllJointAngles, calcAngle } from "./angles.js";

// Key landmark indices used for secondary 2D coordinate distance comparison
const KEY_COORD_LANDMARKS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]; // shoulders, elbows, wrists, hips, knees, ankles

export class DTWAligner {
  /**
   * @param {object} [options]
   * @param {number} [options.windowSize=60] Rolling user frame buffer size (~2 sec at 30fps)
   * @param {number} [options.throttleIntervalMs=200] Recompute throttle interval (ms)
   * @param {number} [options.lambda=50.0] Scale factor for secondary 2D coord distance (deg / body-unit)
   * @param {number} [options.bandRadius=15] Sakoe-Chiba band radius (frames)
   */
  constructor(options = {}) {
    this.windowSize = options.windowSize || 60;
    this.throttleIntervalMs = options.throttleIntervalMs || 200;
    this.lambda = options.lambda !== undefined ? options.lambda : 50.0;
    this.bandRadius = options.bandRadius || 15;

    this.userBuffer = []; // Rolling array of { landmarks, timestamp, angles, normCoords }
    this.referenceSequence = null; // Array of reference frame objects
    this.calibrationTransform = null;

    this.isAligning = false;
    this.lastRecomputeTime = 0;

    /** @type {((result: any) => void)|null} Callback invoked when alignment updates */
    this.onAlignmentUpdate = null;

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

  /**
   * Load reference sequence R(t) extracted from Phase 3.
   * Pre-computes joint angles and torso-normalized 2D coordinates for all reference frames.
   * @param {Array<{timestamp: number, landmarks: Array}>} rawSequence
   */
  setReferenceSequence(rawSequence) {
    if (!rawSequence || rawSequence.length === 0) {
      this.referenceSequence = null;
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
  }

  /**
   * Pre-computes 2D torso-centered and normalized coordinates for a reference frame.
   */
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
    this.userBuffer = [];
    this.lastRecomputeTime = 0;
    this._refCursor = 0;        // Current estimated position in R(t)
    this._alignStartTime = 0;   // performance.now() when alignment started
  }

  stop() {
    this.isAligning = false;
    this.userBuffer = [];
    this._refCursor = 0;
    this._alignStartTime = 0;
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

  /**
   * Process a single live frame of landmarks.
   * @param {Array} landmarks
   * @param {number} timestamp
   */
  processFrame(landmarks, timestamp = performance.now()) {
    if (!this.isAligning || !this.referenceSequence) return null;

    if (this._alignStartTime === 0) {
      this._alignStartTime = timestamp;
    }

    const userAngles = computeAllJointAngles(landmarks);

    // Push into rolling user buffer
    this.userBuffer.push({
      timestamp,
      landmarks,
      angles: userAngles
    });

    if (this.userBuffer.length > this.windowSize) {
      this.userBuffer.shift();
    }

    // Check throttle timer
    const now = performance.now();
    if (now - this.lastRecomputeTime >= this.throttleIntervalMs) {
      this.lastRecomputeTime = now;
      const result = this._recomputeAlignment();
      this._lastResult = result;
      if (this.onAlignmentUpdate) {
        this.onAlignmentUpdate(result);
      }
      return result;
    }

    return this._lastResult;
  }

  /**
   * Core alignment algorithm — Subsequence DTW.
   *
   * Instead of stretching U[0..N-1] across all of R[0..M-1] (which forces
   * bestJ toward M-1 regardless of real playback position), we maintain a
   * cursor (_refCursor) tracking our estimated position in R. Each recompute
   * runs a local DTW of the user buffer against a neighborhood of R around
   * the cursor, with the user buffer mapped 1:1 (not stretched).
   *
   * The search window is:
   *   R[ max(0, cursor - bandRadius) .. min(M-1, cursor + N + bandRadius) ]
   *
   * This means the user's ~2-second rolling window is compared against a
   * comparable-length slice of R near the cursor, plus padding.  The cursor
   * advances forward smoothly based on where bestJ lands within that window.
   */
  _recomputeAlignment() {
    if (this.userBuffer.length === 0 || !this.referenceSequence || this.referenceSequence.length === 0) {
      return {
        status: "IDLE",
        aggregateRmse: null,
        coordDeviation: null,
        compositeScore: null,
        matchedRefTime: 0,
        matchedRefFrame: 0,
        jointDeviations: {}
      };
    }

    const N = this.userBuffer.length;
    const M = this.referenceSequence.length;

    // Check if current tail user frame is tracking lost (K = 0 valid joints)
    const latestUserFrame = this.userBuffer[N - 1];
    const validUserJoints = Object.values(latestUserFrame.angles).filter(j => j.isValid).length;

    if (validUserJoints === 0) {
      return {
        status: "TRACKING_LOST",
        aggregateRmse: null,
        coordDeviation: null,
        compositeScore: null,
        matchedRefTime: 0,
        matchedRefFrame: 0,
        jointDeviations: this._getEmptyJointDeviations()
      };
    }

    // ---- Subsequence DTW against a local neighborhood of R ----
    // Define the R-window to search: centered on _refCursor, spanning enough
    // frames to cover the user buffer length plus padding for flexibility.
    const searchPad = this.bandRadius;
    const rStart = Math.max(0, this._refCursor - searchPad);
    const rEnd   = Math.min(M - 1, this._refCursor + N + searchPad);
    const L      = rEnd - rStart + 1; // length of local R window

    if (L <= 0) {
      return {
        status: "OK",
        aggregateRmse: 0,
        coordDeviation: 0,
        compositeScore: 0,
        matchedRefTime: this.referenceSequence[M - 1].timestamp,
        matchedRefFrame: M - 1,
        jointDeviations: this._getEmptyJointDeviations()
      };
    }

    // DP table: dp[i][k] = min cumulative cost aligning U[0..i] to R_local[0..k]
    // where R_local[k] = referenceSequence[rStart + k]
    const dp = Array.from({ length: N }, () => new Float32Array(L).fill(Infinity));

    // Sakoe-Chiba band constraint within the local window.
    // Map user frame i to an expected R_local position proportionally.
    const localStepRatio = L / N;
    const localBandRadius = Math.max(this.bandRadius, Math.ceil(localStepRatio));

    // Initialize first row (i=0)
    const firstUserFrame = this.userBuffer[0];
    const maxKFirst = Math.min(L - 1, localBandRadius * 2);

    for (let k = 0; k <= maxKFirst; k++) {
      const costObj = this._calcFrameDistance(firstUserFrame, this.referenceSequence[rStart + k]);
      if (costObj !== null) {
        dp[0][k] = costObj.compositeCost;
      }
    }

    // Fill DP table with band constraint
    for (let i = 1; i < N; i++) {
      const uFrame = this.userBuffer[i];
      const expectedCenter = Math.floor(i * localStepRatio);
      const minK = Math.max(0, expectedCenter - localBandRadius);
      const maxK = Math.min(L - 1, expectedCenter + localBandRadius);

      for (let k = minK; k <= maxK; k++) {
        const costObj = this._calcFrameDistance(uFrame, this.referenceSequence[rStart + k]);
        if (costObj === null) continue;

        // Transitions from (i-1, k), (i-1, k-1), (i, k-1)
        const cDiag = k > 0 ? dp[i - 1][k - 1] : Infinity;
        const cUp   = dp[i - 1][k];
        const cLeft = k > 0 ? dp[i][k - 1] : Infinity;

        const minPrev = Math.min(cDiag, cUp, cLeft);
        if (minPrev !== Infinity) {
          dp[i][k] = costObj.compositeCost + minPrev;
        }
      }
    }

    // Find best matching R_local position for U[N-1] (the user's latest frame)
    let bestK = 0;
    let minFinalCost = Infinity;
    const lastExpectedCenter = Math.floor((N - 1) * localStepRatio);
    const lastMinK = Math.max(0, lastExpectedCenter - localBandRadius);
    const lastMaxK = Math.min(L - 1, lastExpectedCenter + localBandRadius);

    for (let k = lastMinK; k <= lastMaxK; k++) {
      if (dp[N - 1][k] < minFinalCost) {
        minFinalCost = dp[N - 1][k];
        bestK = k;
      }
    }

    // Convert local index back to global R index
    let bestJ = rStart + bestK;

    // Fallback if band produced no valid path
    if (minFinalCost === Infinity) {
      bestJ = Math.min(M - 1, this._refCursor);
    }

    // Clamp to valid range
    bestJ = Math.max(0, Math.min(M - 1, bestJ));

    // ---- Update cursor with smoothing ----
    // Advance cursor toward bestJ. Use exponential smoothing so the cursor
    // doesn't jump erratically on a single bad frame, but does track forward
    // steadily.  The cursor can only move backward a limited amount (to handle
    // repeated movements) but freely advances forward.
    const alpha = 0.4; // smoothing factor (0 = ignore new, 1 = snap to new)
    const smoothed = Math.round(this._refCursor * (1 - alpha) + bestJ * alpha);

    // Allow backward movement up to bandRadius frames (for repeated motions),
    // but don't let cursor go below 0 or above M-1.
    const minCursor = Math.max(0, this._refCursor - this.bandRadius);
    this._refCursor = Math.max(minCursor, Math.min(M - 1, smoothed));

    const matchedRef = this.referenceSequence[bestJ];
    const finalPairCost = this._calcFrameDistance(latestUserFrame, matchedRef);

    if (!finalPairCost) {
      return {
        status: "TRACKING_LOST",
        aggregateRmse: null,
        coordDeviation: null,
        compositeScore: null,
        matchedRefTime: matchedRef.timestamp,
        matchedRefFrame: bestJ,
        jointDeviations: this._getEmptyJointDeviations()
      };
    }

    // Empirical lambda logging for verification
    if (Math.random() < 0.1) { // 10% sampling of recomputes to avoid console spam
      console.log(`[DTW Sub-seq] cursor=${this._refCursor}, bestJ=${bestJ}, rStart=${rStart}, rEnd=${rEnd}, D_angles=${finalPairCost.dAngles.toFixed(2)}°`);
    }

    return {
      status: "OK",
      aggregateRmse: Math.round(finalPairCost.dAngles),
      coordDeviation: parseFloat(finalPairCost.dCoords.toFixed(4)),
      compositeScore: Math.round(finalPairCost.compositeCost),
      matchedRefTime: matchedRef.timestamp,
      matchedRefFrame: bestJ,
      jointDeviations: finalPairCost.jointDeviations
    };
  }

  /**
   * Calculates distance between a user frame and reference frame.
   * Primary: 8 Joint Angle RMSE (in degrees).
   * Secondary: Mean normalized 2D coordinate distance (in torso-normalized body height units).
   * @returns {{dAngles: number, dCoords: number, compositeCost: number, jointDeviations: Record<string, {deviation: number|null, isValid: boolean}>}|null}
   */
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

    if (validJointCount === 0) return null; // K = 0

    const dAngles = Math.sqrt(sumSqAngleErr / validJointCount);

    // Secondary parameter: Normalized 2D coordinate mean Euclidean distance
    let sumCoordDist = 0;
    let validCoordCount = 0;

    if (refFrame.normCoords) {
      let uNormCoords = null;
      if (this.calibrationTransform && this.calibrationTransform.normalizeLandmarks) {
        const normalizedLandmarks = this.calibrationTransform.normalizeLandmarks(userFrame.landmarks);
        uNormCoords = KEY_COORD_LANDMARKS.map(idx => normalizedLandmarks[idx]);
      } else {
        // Uncalibrated fallback: torso-centered scaling
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

    return {
      dAngles,
      dCoords,
      compositeCost,
      jointDeviations
    };
  }

  _getEmptyJointDeviations() {
    const res = {};
    for (const key of Object.keys(JOINT_ANGLES)) {
      res[key] = { deviation: null, isValid: false };
    }
    return res;
  }
}
