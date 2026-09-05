// ============================================================
// skeletonRenderer.js
// Job: given landmarks + a canvas, draw the skeleton. Nothing else.
// Enhanced: gradient bones with glow, confidence-colored joints
// with outer glow halos.
// ============================================================

import { POSE_CONNECTIONS, CONFIDENCE } from "./constants.js";

export function drawSkeleton(ctx, canvas, landmarks){
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!landmarks) return;

  const w = canvas.width, h = canvas.height;

  // Draw connections — skip any edge where either endpoint is below
  // CONFIDENCE.MEDIUM (don't draw a line to a point that isn't shown).
  POSE_CONNECTIONS.forEach(([a, b]) => {
    const p1 = landmarks[a], p2 = landmarks[b];
    if (!p1 || !p2) return;

    const vis1 = p1.visibility ?? 1;
    const vis2 = p2.visibility ?? 1;
    if (vis1 <= CONFIDENCE.MEDIUM || vis2 <= CONFIDENCE.MEDIUM) return;

    const x1 = p1.x * w, y1 = p1.y * h;
    const x2 = p2.x * w, y2 = p2.y * h;

    const avgVis = (vis1 + vis2) / 2;
    const grad = ctx.createLinearGradient(x1, y1, x2, y2);
    const alpha = Math.max(0.15, avgVis * 0.9);
    grad.addColorStop(0, `rgba(139,92,246,${alpha})`);
    grad.addColorStop(1, `rgba(139,92,246,${alpha})`);

    ctx.save();
    ctx.shadowColor = "rgba(139,92,246,0.35)";
    ctx.shadowBlur = 6;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  });

  // Draw joints — suppress any landmark below CONFIDENCE.MEDIUM entirely.
  landmarks.forEach((lm) => {
    const vis = lm.visibility ?? 1;
    if (vis <= CONFIDENCE.MEDIUM) return;

    const x = lm.x * w, y = lm.y * h;
    const radius = 4;

    // Outer glow
    ctx.beginPath();
    ctx.arc(x, y, radius + 2, 0, 2 * Math.PI);
    const glowColor = vis > CONFIDENCE.HIGH
      ? "rgba(52,211,153,0.3)"
      : "rgba(251,191,36,0.3)";
    ctx.fillStyle = glowColor;
    ctx.fill();

    // Joint dot
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = vis > CONFIDENCE.HIGH
      ? "#34d399"
      : "#fbbf24";
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(7,7,12,0.6)";
    ctx.stroke();
  });
}

export function clearCanvas(ctx, canvas){
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
