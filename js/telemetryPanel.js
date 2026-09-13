// ============================================================
// telemetryPanel.js
// Job: update all side-panel UI — system status, confidence gauge,
// stability meter, joint angles, and grouped landmark list.
// It doesn't know about the camera, MediaPipe, or the canvas —
// hand it landmarks or a status string, it updates the DOM.
// ============================================================

import {
  LANDMARK_NAMES, CONFIDENCE, confidenceColor,
  LANDMARK_GROUPS, JOINT_ANGLES, STABILITY_LANDMARKS
} from "./constants.js";
import { computeAllJointAngles } from "./angles.js";

export class TelemetryPanel {
  constructor(dom){
    // dom = object of element references, passed in from main.js
    this.dom = dom;

    // Stability tracking — rolling window of recent landmark positions
    this._stabilityWindow = 15;
    this._recentLandmarks = [];

    // Group collapse state (Face collapsed by default)
    this._groupCollapsed = { "Face": true, "Upper Body": false, "Lower Body": false };

    // Throttle DOM updates
    this._lastUpdate = 0;
    this._updateInterval = 150; // ms
  }

  // ---- Simple setters (same as original) ----

  setModelStatus(text){
    this.dom.mLoad.textContent = text;
  }

  setDelegate(text){
    this.dom.mDelegate.textContent = text;
  }

  setResolution(width, height){
    this.dom.mRes.textContent = `${width}×${height}`;
  }

  setCalibrationStatus(text, isError=false) {
    if(!this.dom.cStatus) return;
    this.dom.cStatus.textContent = text;
    this.dom.cStatus.style.color = isError ? "var(--red)" : "var(--text)";
  }

  setCalibrationResult(transform) {
    if(!this.dom.cPitch) return;
    if (!transform || !transform.isValid) {
      this.dom.cPitch.textContent = "—";
      this.dom.cScale.textContent = "—";
      this.setCalibrationStatus("Not calibrated", true);
    } else {
      this.dom.cPitch.innerHTML = transform.pitchOffsetDegrees > 0 ? `+${transform.pitchOffsetDegrees}° (Up)` : 
                                 transform.pitchOffsetDegrees < 0 ? `${transform.pitchOffsetDegrees}° (Down)` : `0° (Level)`;
      this.dom.cScale.textContent = transform.scaleFactor.toFixed(2) + "x";
      this.setCalibrationStatus("Calibrated");
    }
  }

  showCalibrationOverlay(show) {
    if(!this.dom.calOverlay) return;
    this.dom.calOverlay.style.display = show ? "block" : "none";
  }

  updateCalibrationOverlay(message, progressPct, isWarning) {
    if(!this.dom.calStatusText) return;
    this.dom.calStatusText.textContent = message;
    this.dom.calBarFill.style.width = `${progressPct * 100}%`;
    if (isWarning) {
      this.dom.calOverlay.classList.add("warning");
    } else {
      this.dom.calOverlay.classList.remove("warning");
    }
  }

  setExtractionStatus(status, isError = false) {
    if (!this.dom.eStatus) return;
    this.dom.eStatus.textContent = status;
    this.dom.eStatus.style.color = isError ? "var(--red)" : "var(--text)";
  }

  setExtractionTime(ms) {
    if (!this.dom.eTime) return;
    this.dom.eTime.textContent = (ms / 1000).toFixed(1) + "s";
  }

  setExtractionFrames(count, skippedCount = 0) {
    if (!this.dom.eFrames) return;
    if (skippedCount > 0) {
      this.dom.eFrames.textContent = `${count} (${skippedCount} skipped)`;
    } else {
      this.dom.eFrames.textContent = count;
    }
  }

  setFps(fps){
    this.dom.mFps.textContent = fps;
    this.dom.fpsBadge.textContent = fps + " FPS";
    this._currentFps = fps; // TEMP DEBUG — cached for budget calc
  }

  // ---- TEMP DEBUG — Pipeline latency meter (remove after verification) ----

  /**
   * Update the rolling-average pipeline latency display.
   * @param {number} latencyMs — single frame round-trip time
   */
  pushPipelineLatency(latencyMs){
    if (!this._latencyRing) this._latencyRing = [];
    this._latencyRing.push(latencyMs);
    if (this._latencyRing.length > 30) this._latencyRing.shift();

    const avg = this._latencyRing.reduce((s, v) => s + v, 0) / this._latencyRing.length;
    const rounded = Math.round(avg);

    if (this.dom.mPipeLatency){
      this.dom.mPipeLatency.textContent = `${rounded}ms avg`;
    }

    if (this.dom.mPipeBudget){
      const fps = this._currentFps || 0;
      if (fps > 0){
        const budgetMs = 1000 / fps;
        const pct = Math.round((avg / budgetMs) * 100);
        this.dom.mPipeBudget.textContent = `${pct}% of ${Math.round(budgetMs)}ms`;
        // Color-code: green < 60%, amber 60-90%, red > 90%
        this.dom.mPipeBudget.className = "value " + (pct < 60 ? "good" : pct < 90 ? "warn" : "");
      } else {
        this.dom.mPipeBudget.textContent = "—";
        this.dom.mPipeBudget.className = "value";
      }
    }
  }
  // ---- END TEMP DEBUG ----

  setStatus(text, kind){
    this.dom.statusText.textContent = text;
    this.dom.statusDot.className = "dot" + (kind ? " " + kind : "");
  }

  // ---- Loading progress ----

  showLoading(stage){
    this.dom.loadingOverlay.classList.add("show");
    this.dom.loadingText.textContent = stage;
  }

  setLoadProgress(pct){
    this.dom.loadBar.classList.add("show");
    this.dom.loadBarFill.style.width = pct + "%";
  }

  hideLoading(){
    this.dom.loadingOverlay.classList.remove("show");
    setTimeout(() => {
      this.dom.loadBar.classList.remove("show");
      this.dom.loadBarFill.style.width = "0%";
    }, 600);
  }

  // ---- Full landmark update (throttled) ----

  updateLandmarks(landmarks){
    if (!landmarks){
      this.dom.mCount.textContent = "0 / 33";
      return;
    }

    const now = performance.now();
    if (now - this._lastUpdate < this._updateInterval) return;
    this._lastUpdate = now;

    // Tracked count
    const tracked = landmarks.filter(lm => (lm.visibility ?? 1) > CONFIDENCE.MEDIUM).length;
    this.dom.mCount.textContent = `${tracked} / 33`;

    // Overall confidence gauge
    this._updateGauge(landmarks);

    // Stability meter
    this._updateStability(landmarks);

    // Joint angles
    this._updateAngles(landmarks);

    // Grouped landmark confidence list
    this._updateLandmarkList(landmarks);
  }

  // ---- Gauge ----

  _updateGauge(landmarks){
    const avgConf = landmarks.reduce((s, lm) => s + (lm.visibility ?? 1), 0) / landmarks.length;
    const pct = Math.round(avgConf * 100);
    this.dom.gaugePct.textContent = pct + "%";

    const circumference = 176;
    this.dom.gaugeCircle.style.strokeDashoffset = circumference - (circumference * avgConf);
    this.dom.gaugeCircle.style.stroke =
      avgConf > CONFIDENCE.HIGH ? "var(--green)" :
      avgConf > CONFIDENCE.MEDIUM ? "var(--amber)" : "var(--red)";
  }

  // ---- Stability ----

  _updateStability(landmarks){
    this._recentLandmarks.push(landmarks.map(lm => ({ x: lm.x, y: lm.y })));
    if (this._recentLandmarks.length > this._stabilityWindow) this._recentLandmarks.shift();
    if (this._recentLandmarks.length < 3) return;

    let totalVar = 0;
    let count = 0;

    for (const idx of STABILITY_LANDMARKS){
      const positions = this._recentLandmarks.map(frame => frame[idx]);
      const meanX = positions.reduce((s,p) => s + p.x, 0) / positions.length;
      const meanY = positions.reduce((s,p) => s + p.y, 0) / positions.length;
      const variance = positions.reduce((s,p) => s + (p.x - meanX)**2 + (p.y - meanY)**2, 0) / positions.length;
      totalVar += variance;
      count++;
    }

    const avgVar = totalVar / count;
    const stability = Math.max(0, Math.min(100, Math.round((1 - Math.min(avgVar * 500, 1)) * 100)));

    this.dom.mStability.textContent = stability + "%";
    this.dom.mStability.className = "value " + (stability > 75 ? "good" : stability > 40 ? "warn" : "");
    this.dom.stabilityFill.style.width = stability + "%";
  }

  // ---- Joint angles ----

  _updateAngles(landmarks){
    const angleChips = [];
    const computedAngles = computeAllJointAngles(landmarks);

    for (const [id, data] of Object.entries(computedAngles)){
      const el = document.getElementById(id);
      const card = el ? el.closest('.angle-card') : null;

      if (data.isValid && data.angle !== null){
        if (el) el.innerHTML = data.angle + '<span>°</span>';
        if (card) card.classList.remove('low-confidence');
        const shortName = id.replace(/^a/, '').replace(/([A-Z])/g, ' $1').trim();
        angleChips.push(
          `<div class="angle-chip"><span class="angle-label">${shortName}</span><span class="angle-val">${data.angle}°</span></div>`
        );
      } else {
        if (el) el.innerHTML = '—<span>°</span>';
        if (card) card.classList.add('low-confidence');
      }
    }

    if (this.dom.angleOverlay) this.dom.angleOverlay.innerHTML = angleChips.join("");
  }

  // ---- DTW Alignment Telemetry ----

  setDtwStatus(text, isError = false){
    if (this.dom.dStatus) {
      this.dom.dStatus.textContent = text;
      this.dom.dStatus.className = isError ? "value error" : "value";
    }
  }

  updateAlignmentResults(res){
    if (!res) return;

    if (res.status === "TRACKING_LOST") {
      this.setDtwStatus("TRACKING LOST", true);
      if (this.dom.dRmse) this.dom.dRmse.textContent = "—";
      if (this.dom.dMatchTime) this.dom.dMatchTime.textContent = "—";
      this._updateJointDeviations({});
      return;
    }

    if (res.status === "PAUSED") {
      const reason = res.pauseReason === "POOR_MATCH" ? "Paused (Occlusion)" : "Paused (Resting)";
      this.setDtwStatus(reason);
      if (this.dom.dStatus) this.dom.dStatus.className = "value warn";
      if (this.dom.dRmse) this.dom.dRmse.textContent = res.aggregateRmse !== null ? `${res.aggregateRmse}°` : "—";
      
      try {
        if (this.dom.dMatchTime) {
          const t = res.matchedRefTime;
          this.dom.dMatchTime.textContent = (t !== undefined && t !== null && !isNaN(t)) ? `${(t / 1000).toFixed(1)}s` : "—";
        }
      } catch (e) {
        console.warn("Failed to format matchedRefTime:", e);
      }

      this._updateJointDeviations(res.jointDeviations);
      return;
    }

    if (res.status === "REF_GAP") {
      this.setDtwStatus("Ref Gap");
      if (this.dom.dStatus) this.dom.dStatus.className = "value warn";
      if (this.dom.dRmse) this.dom.dRmse.textContent = "—";
      try {
        if (this.dom.dMatchTime) {
          const t = res.matchedRefTime;
          this.dom.dMatchTime.textContent = (t !== undefined && t !== null && !isNaN(t)) ? `${(t / 1000).toFixed(1)}s` : "—";
        }
      } catch (e) {
        console.warn("Failed to format matchedRefTime:", e);
      }
      this._updateJointDeviations({});
      return;
    }

    if (res.status === "OK") {
      this.setDtwStatus("Active");
      if (this.dom.dRmse) this.dom.dRmse.textContent = res.aggregateRmse !== null ? `${res.aggregateRmse}°` : "—";
      
      try {
        if (this.dom.dMatchTime) {
          const t = res.matchedRefTime;
          this.dom.dMatchTime.textContent = (t !== undefined && t !== null && !isNaN(t)) ? `${(t / 1000).toFixed(1)}s` : "—";
        }
      } catch (e) {
        console.warn("Failed to format matchedRefTime:", e);
      }

      this._updateJointDeviations(res.jointDeviations);
    } else {
      this.setDtwStatus(res.status || "Idle");
      if (this.dom.dRmse) this.dom.dRmse.textContent = "—";
      if (this.dom.dMatchTime) this.dom.dMatchTime.textContent = "—";
      this._updateJointDeviations({});
    }
  }

  _updateJointDeviations(jointDeviations = {}){
    for (const id of Object.keys(JOINT_ANGLES)){
      const devId = 'd' + id.substring(1); // e.g. dLElbow
      const el = document.getElementById(devId);
      if (!el) continue;
      const card = el.closest('.dev-card');

      const data = jointDeviations[id];
      if (data && data.isValid && data.deviation !== null){
        el.textContent = `${data.deviation}°`;
        if (card) {
          card.classList.remove('low-confidence');
          if (data.deviation < 15) {
            card.classList.add('good');
            card.classList.remove('warn', 'error');
          } else if (data.deviation < 30) {
            card.classList.add('warn');
            card.classList.remove('good', 'error');
          } else {
            card.classList.add('error');
            card.classList.remove('good', 'warn');
          }
        }
      } else {
        el.textContent = '—°';
        if (card) {
          card.classList.add('low-confidence');
          card.classList.remove('good', 'warn', 'error');
        }
      }
    }
  }

  // ---- Grouped landmark list ----

  _updateLandmarkList(landmarks){
    if (!this.dom.landmarkScroll) return;

    // Build DOM structure once if empty
    if (!this._landmarkNodes) {
      let html = "";
      for (const [groupName, indices] of Object.entries(LANDMARK_GROUPS)){
        const collapsed = this._groupCollapsed[groupName];
        const arrowClass = collapsed ? "arrow collapsed" : "arrow";
        html += `<div class="landmark-group">
          <div class="group-header" data-group="${groupName}">
            <span class="${arrowClass}">▼</span> ${groupName} (${indices.length})
          </div>
          <div class="group-items" style="${collapsed ? 'max-height:0;overflow:hidden;' : 'max-height:500px;'}">`;

        for (const i of indices){
          html += `<div class="lm-item" data-idx="${i}">
            <span class="lm-name">${LANDMARK_NAMES[i]}</span>
            <div class="lm-bar-track"><div class="lm-bar-fill" id="lmFill_${i}"></div></div>
            <span class="lm-pct" id="lmPct_${i}">0%</span>
          </div>`;
        }
        html += "</div></div>";
      }

      this.dom.landmarkScroll.innerHTML = html;
      this._landmarkNodes = true;

      // Attach collapse toggles once
      this.dom.landmarkScroll.querySelectorAll(".group-header").forEach(header => {
        header.addEventListener("click", () => {
          const group = header.dataset.group;
          this._groupCollapsed[group] = !this._groupCollapsed[group];
          const items = header.nextElementSibling;
          const arrow = header.querySelector(".arrow");
          if (this._groupCollapsed[group]){
            items.style.maxHeight = "0";
            items.style.overflow = "hidden";
            arrow.classList.add("collapsed");
          } else {
            items.style.maxHeight = "500px";
            items.style.overflow = "visible";
            arrow.classList.remove("collapsed");
          }
        });
      });
    }

    // Fast in-place DOM updates
    for (let i = 0; i < landmarks.length; i++) {
      const fillEl = document.getElementById(`lmFill_${i}`);
      const pctEl = document.getElementById(`lmPct_${i}`);
      if (fillEl && pctEl) {
        const lm = landmarks[i];
        const vis = lm.visibility ?? 1;
        const p = Math.round(vis * 100);
        const color = confidenceColor(vis);
        fillEl.style.width = `${p}%`;
        fillEl.style.background = color;
        pctEl.textContent = `${p}%`;
      }
    }
  }

  // ---- Reset (on camera stop) ----

  reset(){
    this.dom.mFps.textContent = "—";
    this.dom.mCount.textContent = "0 / 33";
    this.dom.gaugePct.textContent = "—";
    this.dom.gaugeCircle.style.strokeDashoffset = 176;
    this.dom.mStability.textContent = "—";
    this.dom.stabilityFill.style.width = "0%";
    this._recentLandmarks = [];
    this._landmarkNodes = false;

    // TEMP DEBUG — reset pipeline latency meter
    this._latencyRing = [];
    this._currentFps = 0;
    if (this.dom.mPipeLatency) this.dom.mPipeLatency.textContent = "—";
    if (this.dom.mPipeBudget) { this.dom.mPipeBudget.textContent = "—"; this.dom.mPipeBudget.className = "value"; }
    
    this.setCalibrationResult(null);
    this.showCalibrationOverlay(false);

    // Reset angle cards
    for (const key of Object.keys(JOINT_ANGLES)){
      const el = document.getElementById(key);
      el.innerHTML = '—<span>°</span>';
      const card = el.closest('.angle-card');
      if (card) card.classList.remove('low-confidence');
    }

    this.dom.landmarkScroll.innerHTML =
      '<p class="empty-note">Landmark visibility scores will appear here once tracking starts.</p>';
  }
}
