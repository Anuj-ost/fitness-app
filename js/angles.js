// ============================================================
// angles.js
// Shared helper module for computing joint angles and confidence gating.
// Used identically by both TelemetryPanel (UI) and DTWAligner.
// ============================================================

import { CONFIDENCE, JOINT_ANGLES } from "./constants.js";

/**
 * Calculates the angle (in degrees) at vertex B between vectors BA and BC.
 * Uses 3D coordinates (x, y, z).
 * @param {{x: number, y: number, z?: number}} a
 * @param {{x: number, y: number, z?: number}} b
 * @param {{x: number, y: number, z?: number}} c
 * @returns {number|null} Angle in integer degrees, or null if degenerate.
 */
export function calcAngle(a, b, c) {
  if (!a || !b || !c) return null;
  const ba = { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) };
  const bc = { x: c.x - b.x, y: c.y - b.y, z: (c.z || 0) - (b.z || 0) };
  const dot = ba.x * bc.x + ba.y * bc.y + ba.z * bc.z;
  const magBA = Math.sqrt(ba.x ** 2 + ba.y ** 2 + ba.z ** 2);
  const magBC = Math.sqrt(bc.x ** 2 + bc.y ** 2 + bc.z ** 2);
  if (magBA === 0 || magBC === 0) return null;
  const cosAngle = Math.max(-1, Math.min(1, dot / (magBA * magBC)));
  return Math.round((Math.acos(cosAngle) * 180) / Math.PI);
}

/**
 * Computes all 8 joint angles from a 33-landmark array.
 * Gated by CONFIDENCE.MEDIUM (0.4).
 * @param {Array<{x: number, y: number, z?: number, visibility?: number}>} landmarks
 * @returns {Record<string, {angle: number|null, isValid: boolean}>}
 */
export function computeAllJointAngles(landmarks) {
  const result = {};
  if (!landmarks || landmarks.length < 33) {
    for (const id of Object.keys(JOINT_ANGLES)) {
      result[id] = { angle: null, isValid: false };
    }
    return result;
  }

  for (const [id, [a, vertex, b]] of Object.entries(JOINT_ANGLES)) {
    const la = landmarks[a];
    const lv = landmarks[vertex];
    const lb = landmarks[b];

    const minVis = Math.min(
      la?.visibility ?? 1,
      lv?.visibility ?? 1,
      lb?.visibility ?? 1
    );

    if (minVis > CONFIDENCE.MEDIUM) {
      const angle = calcAngle(la, lv, lb);
      result[id] = { angle, isValid: angle !== null };
    } else {
      result[id] = { angle: null, isValid: false };
    }
  }

  return result;
}
