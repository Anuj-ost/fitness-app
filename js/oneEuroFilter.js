// ============================================================
// oneEuroFilter.js
// Job: smooth high-frequency jitter from MediaPipe landmark x,y
// coordinates without introducing the perceptible lag that a
// static low-pass filter would.
//
// Implements the 1€ (One-Euro) Filter:
//   Casiez, G., Roussel, N., & Vogel, D. (2012).
//   "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy
//   Input in Interactive Systems." ACM CHI '12.
//   https://doi.org/10.1145/2207676.2208639
//
// Applied once per landmark, independently on x and y.
// z and visibility are passed through unchanged — z is MediaPipe's
// depth proxy (unreliable without world landmarks), and visibility
// is MediaPipe's confidence score, not a spatial coordinate.
//
// Usage (from main.js):
//   import { LandmarkFilter } from "./oneEuroFilter.js";
//   const filter = new LandmarkFilter();
//   // in the onResult callback:
//   const smoothed = filter.apply(rawLandmarks, timestamp);
// ============================================================

/**
 * Single-axis 1€ filter instance.
 * All internal timestamps are in seconds.
 */
class OneEuroFilterAxis {
  /**
   * @param {number} minCutoff  Minimum cutoff frequency (Hz). Lower = more smoothing at rest.
   * @param {number} beta       Speed coefficient. Higher = less smoothing during fast motion.
   * @param {number} dCutoff    Derivative cutoff frequency (Hz). Smooths the speed estimate itself.
   */
  constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;

    this._xPrev = null;
    this._dxPrev = 0;
    this._tPrev = null;
  }

  /** Reset filter state (e.g. after tracking loss). */
  reset() {
    this._xPrev = null;
    this._dxPrev = 0;
    this._tPrev = null;
  }

  /**
   * Compute the smoothing factor α for a given cutoff frequency and timestep.
   * @param {number} dt   Time delta in seconds.
   * @param {number} fc   Cutoff frequency in Hz.
   * @returns {number}     Smoothing factor in (0, 1].
   */
  _alpha(dt, fc) {
    const tau = 1.0 / (2.0 * Math.PI * fc);
    return 1.0 / (1.0 + tau / dt);
  }

  /**
   * Filter a single sample.
   * @param {number} x   Raw input value.
   * @param {number} t   Timestamp in seconds.
   * @returns {number}    Filtered value.
   */
  filter(x, t) {
    if (this._xPrev === null) {
      // First sample — no filtering possible yet.
      this._xPrev = x;
      this._dxPrev = 0;
      this._tPrev = t;
      return x;
    }

    const dt = Math.max(t - this._tPrev, 1e-6); // guard against zero/negative dt

    // 1. Estimate derivative (speed) using a low-pass filtered difference.
    const rawDx = (x - this._xPrev) / dt;
    const alphaD = this._alpha(dt, this.dCutoff);
    const dx = alphaD * rawDx + (1 - alphaD) * this._dxPrev;

    // 2. Adaptive cutoff: raise cutoff when speed is high → less smoothing.
    const cutoff = this.minCutoff + this.beta * Math.abs(dx);

    // 3. Low-pass filter the value with the adaptive cutoff.
    const alphaX = this._alpha(dt, cutoff);
    const xFiltered = alphaX * x + (1 - alphaX) * this._xPrev;

    // Store state for next call.
    this._xPrev = xFiltered;
    this._dxPrev = dx;
    this._tPrev = t;

    return xFiltered;
  }
}

// ---- Per-landmark filter bank ----

/**
 * Applies the 1€ filter to all 33 MediaPipe pose landmarks (x, y only).
 * Maintains a pair of filter instances per landmark index.
 *
 * @example
 *   const filter = new LandmarkFilter();
 *   const smoothed = filter.apply(rawLandmarks, performance.now());
 */
export class LandmarkFilter {
  /**
   * @param {object}  [opts]
   * @param {number}  [opts.minCutoff=1.0]  Base cutoff Hz — lower = smoother at rest.
   * @param {number}  [opts.beta=0.007]     Speed coefficient — higher = less smoothing during motion.
   * @param {number}  [opts.dCutoff=1.0]    Derivative smoothing cutoff Hz.
   * @param {number}  [opts.numLandmarks=33] Number of landmarks to track.
   */
  constructor(opts = {}) {
    const minCutoff = opts.minCutoff ?? 1.0;
    const beta      = opts.beta ?? 0.007;
    const dCutoff   = opts.dCutoff ?? 1.0;
    const n         = opts.numLandmarks ?? 33;

    /** @type {Array<{x: OneEuroFilterAxis, y: OneEuroFilterAxis}>} */
    this._filters = Array.from({ length: n }, () => ({
      x: new OneEuroFilterAxis(minCutoff, beta, dCutoff),
      y: new OneEuroFilterAxis(minCutoff, beta, dCutoff)
    }));
  }

  /**
   * Filter a full set of landmarks.
   * Returns a NEW array — the input is not mutated.
   *
   * @param {Array<{x: number, y: number, z: number, visibility: number}>} landmarks
   *   Raw landmarks from the worker (already plain objects, not MediaPipe wrappers).
   * @param {number} timestampMs  Timestamp in milliseconds (e.g. performance.now()).
   * @returns {Array<{x: number, y: number, z: number, visibility: number}>}
   *   Filtered landmarks with smoothed x,y; z and visibility passed through.
   */
  apply(landmarks, timestampMs) {
    if (!landmarks) return null;

    const tSec = timestampMs / 1000; // 1€ filter works in seconds internally

    return landmarks.map((lm, i) => {
      const pair = this._filters[i];
      if (!pair) return lm; // safety: more landmarks than expected

      return {
        x: pair.x.filter(lm.x, tSec),
        y: pair.y.filter(lm.y, tSec),
        z: lm.z,
        visibility: lm.visibility
      };
    });
  }

  /** Reset all filter state (call when tracking is lost and re-acquired). */
  reset() {
    for (const pair of this._filters) {
      pair.x.reset();
      pair.y.reset();
    }
  }
}
