// ============================================================
// calibration.js
// Stateless service for auto-perspective camera calibration.
// ============================================================

import { CONFIDENCE, CALIBRATION_LANDMARKS } from './constants.js';

export class CalibrationSession {
  constructor() {
    this.accumulatedTimeMs = 0;
    this.elapsedRealTimeMs = 0;
    this.lastFrameTime = performance.now();
    this.firstFrameTime = this.lastFrameTime;
    this.ratios = [];
    this.TARGET_MS = 3000;
    this.TIMEOUT_MS = 10000;
  }

  /**
   * Process a frame of landmarks for calibration.
   * Torso height is defined as the distance between the shoulder midpoint and hip midpoint.
   * Shoulder width is defined as the distance between the left and right shoulders.
   */
  process(landmarks) {
    const now = performance.now();
    const dt = now - this.lastFrameTime;
    this.lastFrameTime = now;
    
    this.elapsedRealTimeMs = now - this.firstFrameTime;
    
    if (this.elapsedRealTimeMs > this.TIMEOUT_MS) {
      return { 
        status: 'aborted', 
        message: "Calibration timed out (10s elapsed). Please check lighting or camera angle and try again.",
        result: { isValid: false, timestamp: Date.now() }
      };
    }
    
    // Check confidence
    const isGood = CALIBRATION_LANDMARKS.every(idx => (landmarks[idx]?.visibility ?? 1) > CONFIDENCE.MEDIUM);
    
    if (!isGood) {
      return {
        status: 'paused',
        message: "Hold steady — losing tracking...",
        progress: this.accumulatedTimeMs / this.TARGET_MS
      };
    }
    
    this.accumulatedTimeMs += dt;
    
    // Calculate ratio
    const lShoulder = landmarks[11];
    const rShoulder = landmarks[12];
    const lHip = landmarks[23];
    const rHip = landmarks[24];
    
    const dxS = lShoulder.x - rShoulder.x;
    const dyS = lShoulder.y - rShoulder.y;
    const shoulderWidth = Math.sqrt(dxS*dxS + dyS*dyS);
    
    // Torso height: distance between shoulder midpoint and hip midpoint
    const midShoulder = { x: (lShoulder.x + rShoulder.x)/2, y: (lShoulder.y + rShoulder.y)/2 };
    const midHip = { x: (lHip.x + rHip.x)/2, y: (lHip.y + rHip.y)/2 };
    const dxT = midShoulder.x - midHip.x;
    const dyT = midShoulder.y - midHip.y;
    const torsoHeight = Math.sqrt(dxT*dxT + dyT*dyT);
    
    if (torsoHeight > 0) {
      this.ratios.push(shoulderWidth / torsoHeight);
    }
    
    if (this.accumulatedTimeMs >= this.TARGET_MS) {
      this.ratios.sort((a,b) => a-b);
      const medianRatio = this.ratios.length > 0 ? this.ratios[Math.floor(this.ratios.length / 2)] : 1.0;
      
      const IDEAL_RATIO = 0.65;
      const pitchOffsetDegrees = Math.round((medianRatio - IDEAL_RATIO) * 100);
      const scaleFactor = IDEAL_RATIO / medianRatio; 
      
      const result = {
        pitchOffsetDegrees,
        scaleFactor,
        referenceRatio: medianRatio,
        isValid: true,
        timestamp: Date.now(),
        /**
         * 2D-only planar scale and camera-pitch perspective normalization.
         * Implementation derived from Büker et al., Patel & Shah, Zhang et al.
         * Note: z coordinate is intentionally untouched to respect 2D-only scope.
         * 
         * @param {{x: number, y: number, z?: number, visibility?: number}} landmark
         * @param {{x: number, y: number}} [torsoMidpoint]
         */
        normalize: (landmark, torsoMidpoint = { x: 0.5, y: 0.5 }) => {
          if (!landmark) return landmark;

          // 1. Torso Centering (Translation Invariance)
          const xRel = landmark.x - torsoMidpoint.x;
          const yRel = landmark.y - torsoMidpoint.y;

          // 2. Isotropic Scale Normalization (Distance Invariance)
          const xScaled = xRel * scaleFactor;
          const yScaled = yRel * scaleFactor;

          // 3. 2D Pitch Foreshortening Correction (Camera Tilt Invariance)
          // Clamp pitch angle to [-60, 60] deg to prevent cos(phi) -> 0 division blowup
          const clampedPitch = Math.max(-60, Math.min(60, pitchOffsetDegrees));
          const phiRad = (clampedPitch * Math.PI) / 180;
          const cosPhi = Math.cos(phiRad);

          const xNorm = xScaled;
          const yNorm = yScaled / (cosPhi || 1.0);

          return {
            ...landmark,
            x: xNorm,
            y: yNorm
          };
        },

        /**
         * Helper to normalize an array of 33 landmarks at once.
         */
        normalizeLandmarks: (landmarks) => {
          if (!landmarks || landmarks.length === 0) return landmarks;
          const lS = landmarks[11], rS = landmarks[12], lH = landmarks[23], rH = landmarks[24];
          let torsoMidpoint = { x: 0.5, y: 0.5 };
          if (lS && rS && lH && rH) {
            torsoMidpoint = {
              x: (lS.x + rS.x + lH.x + rH.x) / 4,
              y: (lS.y + rS.y + lH.y + rH.y) / 4
            };
          }
          return landmarks.map(lm => result.normalize(lm, torsoMidpoint));
        }
      };
      
      return { status: 'done', message: "Calibration complete.", progress: 1.0, result };
    }
    
    return {
      status: 'running',
      message: "Calibrating...",
      progress: this.accumulatedTimeMs / this.TARGET_MS
    };
  }
}
