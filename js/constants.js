// ============================================================
// constants.js
// Single source of truth for anything other files need to agree on.
// If Phase 2/3/4 need the same landmark names or confidence rules,
// they import from HERE — never redefine them locally.
// ============================================================

// The 33 body points MediaPipe's BlazePose model outputs, in index order.
export const LANDMARK_NAMES = [
  "nose","left_eye_inner","left_eye","left_eye_outer","right_eye_inner","right_eye","right_eye_outer",
  "left_ear","right_ear","mouth_left","mouth_right",
  "left_shoulder","right_shoulder","left_elbow","right_elbow","left_wrist","right_wrist",
  "left_pinky","right_pinky","left_index","right_index","left_thumb","right_thumb",
  "left_hip","right_hip","left_knee","right_knee","left_ankle","right_ankle",
  "left_heel","right_heel","left_foot_index","right_foot_index"
];

// Which pairs of landmarks get a line drawn between them to form the skeleton.
export const POSE_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],[9,10],
  [11,12],[11,13],[13,15],[15,17],[15,19],[15,21],[17,19],
  [12,14],[14,16],[16,18],[16,20],[16,22],[18,20],
  [11,23],[12,24],[23,24],
  [23,25],[25,27],[27,29],[29,31],[27,31],
  [24,26],[26,28],[28,30],[30,32],[28,32]
];

// The ONE place that defines "how confident is confident enough."
// Phase 2 (calibration) and Phase 4 (DTW) should both import these
// instead of hardcoding their own 0.75 / 0.4 numbers.
export const CONFIDENCE = {
  HIGH: 0.75,   // treat as fully reliable
  MEDIUM: 0.4   // below this, treat the joint as untrustworthy
};

// Where the MediaPipe model + runtime files come from.
// Bumping the version only ever needs to happen in this one spot.
export const MODEL_CONFIG = {
  wasmBase: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm",
  modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  numPoses: 1
};

// Colors, kept in sync with confidence tiers above.
export function confidenceColor(vis){
  if (vis > CONFIDENCE.HIGH) return "var(--green)";
  if (vis > CONFIDENCE.MEDIUM) return "var(--amber)";
  return "var(--red)";
}

// Landmarks grouped by body region for the collapsible UI.
export const LANDMARK_GROUPS = {
  "Face": [0,1,2,3,4,5,6,7,8,9,10],
  "Upper Body": [11,12,13,14,15,16,17,18,19,20,21,22],
  "Lower Body": [23,24,25,26,27,28,29,30,31,32]
};

// Joint angle definitions: [pointA, vertex, pointB].
// The angle is measured at the vertex between vectors VA and VB.
export const JOINT_ANGLES = {
  aLElbow:    [11, 13, 15],  // shoulder → elbow → wrist
  aRElbow:    [12, 14, 16],
  aLKnee:     [23, 25, 27],  // hip → knee → ankle
  aRKnee:     [24, 26, 28],
  aLShoulder: [13, 11, 23],  // elbow → shoulder → hip
  aRShoulder: [14, 12, 24],
  aLHip:      [11, 23, 25],  // shoulder → hip → knee
  aRHip:      [12, 24, 26],
};

// Key landmark indices used for pose stability calculation.
export const STABILITY_LANDMARKS = [11, 12, 23, 24]; // shoulders and hips

// Key landmark indices required to be high confidence during calibration
export const CALIBRATION_LANDMARKS = [11, 12, 23, 24]; // shoulders and hips
