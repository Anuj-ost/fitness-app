// ============================================================
// referenceExtractor.js
// Handles tab capture, YouTube IFrame API, and extraction of R(t) sequence.
// ============================================================

import { CONFIDENCE } from './constants.js';
import { LandmarkFilter } from './oneEuroFilter.js';

export class ReferenceExtractor {
  constructor(detector, telemetry) {
    this.detector = detector;
    this.telemetry = telemetry;
    
    this.player = null;
    this.stream = null;
    this.captureVideo = document.getElementById("captureVideo");
    
    this.isExtracting = false;
    this.extractedSequence = [];
    this.skippedFrameCount = 0;
    
    this.vfcId = null;
    this.startTime = 0;
    this.playbackRate = 1;
    
    this.onComplete = null;
    this.onError = null;
    this.onPlayerError = null;
    
    this.filter = new LandmarkFilter();
  }
  
  // init YouTube API
  initPlayer(videoId) {
    return new Promise((resolve, reject) => {
      document.getElementById("ytPlayerContainer").style.display = "block";
      
      if (this.player) {
        this.player.loadVideoById(videoId);
        resolve();
        return;
      }
      
      const checkYt = setInterval(() => {
        if (window.YT && window.YT.Player) {
          clearInterval(checkYt);
          this.player = new window.YT.Player('ytPlayer', {
            height: '100%',
            width: '100%',
            videoId: videoId,
            playerVars: { 
              'playsinline': 1, 
              'rel': 0,
              'enablejsapi': 1,
              'origin': window.location.origin
            },
            events: {
              'onReady': () => resolve(),
              'onStateChange': (e) => {
                if (this.isExtracting && e.data === window.YT.PlayerState.ENDED) {
                  console.log('stopped via ENDED event');
                  this.stopExtraction();
                }
              },
              'onError': (e) => {
                const msg = (e.data === 150 || e.data === 101) ? "Video embedding is disabled by the owner." : "YouTube Player Error: " + e.data;
                if (this.onPlayerError) {
                  this.onPlayerError(new Error(msg));
                }
                reject(new Error(msg));
              }
            }
          });
        }
      }, 100);
      
      setTimeout(() => {
        clearInterval(checkYt);
        if (!this.player) reject(new Error("YouTube API failed to load."));
      }, 5000);
    });
  }

  async startExtraction(onComplete, onError) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error("Reference video extraction is not supported on this browser/device.");
    }
    
    this.onComplete = onComplete;
    this.onError = onError;

    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" },
        audio: false,
        preferCurrentTab: true
      });
    } catch (err) {
      throw new Error("Tab capture was cancelled or denied.");
    }
    
    const track = this.stream.getVideoTracks()[0];
    track.onended = () => {
      this.stopExtraction("Capture ended by user.");
    };

    this.captureVideo.srcObject = this.stream;
    await this.captureVideo.play();

    this.isExtracting = true;
    this.extractedSequence = [];
    this.skippedFrameCount = 0;
    this.filter.reset();
    this.telemetry.setExtractionStatus("Extracting", false);
    
    this.player.setPlaybackRate(2);
    this.player.playVideo();
    
    // Slight delay to ensure video is actually playing and playback rate is registered
    await new Promise(r => setTimeout(r, 500));
    
    this.playbackRate = this.player.getPlaybackRate() || 1;
    this.startTime = performance.now();
    
    this.scheduleNextFrame();
  }

  stopExtraction(reason = null) {
    this.isExtracting = false;
    
    if (this.vfcId) {
      cancelAnimationFrame(this.vfcId); // fallback
      if (this.captureVideo.cancelVideoFrameCallback) {
        this.captureVideo.cancelVideoFrameCallback(this.vfcId);
      }
      this.vfcId = null;
    }
    
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    
    this.captureVideo.srcObject = null;
    if (this.player && this.player.pauseVideo) {
      this.player.pauseVideo();
      this.player.setPlaybackRate(1);
    }
    
    if (reason) {
      this.telemetry.setExtractionStatus("Aborted", true);
      if (this.onError) this.onError(new Error(reason));
    } else {
      this.telemetry.setExtractionStatus("Done", false);
      if (this.onComplete) this.onComplete(this.extractedSequence);
    }
  }

  async processFrame() {
    if (!this.isExtracting) return;

    if (this.captureVideo.readyState >= 2 && this.detector._workerIdle) {
      try {
        // Fallback polling for video end
        if (this.player && this.player.getCurrentTime && this.player.getDuration) {
          const currentTime = this.player.getCurrentTime();
          const duration = this.player.getDuration();
          if (duration > 0 && currentTime >= duration - 0.2) { // Stop near the very end
            console.log('stopped via polling fallback');
            this.stopExtraction();
            return;
          }
        }
        
        const iframe = this.player.getIframe();
        const rect = iframe.getBoundingClientRect();
        
        // Calculate scale between video track and window viewport
        // Assuming the captured browser surface maps to window.innerWidth
        const videoWidth = this.captureVideo.videoWidth;
        const windowWidth = window.innerWidth;
        const scale = videoWidth / windowWidth;
        
        const cropX = Math.max(0, rect.left * scale);
        const cropY = Math.max(0, rect.top * scale);
        const cropW = Math.min(videoWidth - cropX, rect.width * scale);
        const cropH = Math.min(this.captureVideo.videoHeight - cropY, rect.height * scale);
        
        if (cropW > 0 && cropH > 0) {
          const bitmap = await createImageBitmap(this.captureVideo, cropX, cropY, cropW, cropH);
          
          // True video time is elapsed * playbackRate.
          // MediaPipe requires the detectForVideo timestamp to be strictly monotonically increasing.
          // We pass performance.now() as the primary timestamp to satisfy MediaPipe across live/extraction sessions,
          // and we pass the adjusted (rescaled) timestamp as 'meta' so we can record it in R(t).
          const timestamp = performance.now();
          const elapsed = timestamp - this.startTime;
          const adjustedTimestamp = elapsed * this.playbackRate;
          
          this.detector.sendFrame(bitmap, timestamp, adjustedTimestamp);
        }
      } catch (err) {
        this.skippedFrameCount++;
        this.telemetry.setExtractionFrames(this.extractedSequence.length, this.skippedFrameCount);
      }
    }
    
    this.scheduleNextFrame();
  }
  
  scheduleNextFrame() {
    if (!this.isExtracting) return;
    if ("requestVideoFrameCallback" in this.captureVideo) {
      this.vfcId = this.captureVideo.requestVideoFrameCallback(() => this.processFrame());
    } else {
      this.vfcId = requestAnimationFrame(() => this.processFrame());
    }
  }
  
  handleResult(landmarks, adjustedTimestamp) {
    if (!this.isExtracting) return;
    
    this.telemetry.setExtractionTime(adjustedTimestamp);
    
    if (!landmarks) return;
    
    // Smooth reference landmarks using true video time (adjustedTimestamp)
    // so the filter's velocity math is correct regardless of extraction playback speed.
    landmarks = this.filter.apply(landmarks, adjustedTimestamp);
    
    // Confidence Gating: we drop frames where stability landmarks are low confidence
    const STABILITY_LANDMARKS = [11, 12, 23, 24]; // shoulders and hips
    const isGood = STABILITY_LANDMARKS.every(idx => (landmarks[idx]?.visibility ?? 1) > CONFIDENCE.MEDIUM);
    
    if (isGood) {
      this.extractedSequence.push({
        timeMs: adjustedTimestamp,
        landmarks: landmarks
      });
      this.telemetry.setExtractionFrames(this.extractedSequence.length, this.skippedFrameCount);
    }
  }
}
