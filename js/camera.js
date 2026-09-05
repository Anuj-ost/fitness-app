// ============================================================
// camera.js
// Job: turn the webcam on/off, enumerate available cameras.
// It knows nothing about pose detection, drawing, or the UI panel.
// ============================================================

export class Camera {
  constructor(videoElement){
    this.video = videoElement;
    this.stream = null;
  }

  /**
   * Enumerate available video input devices.
   * Returns an array of { deviceId, label } objects.
   */
  static async enumerate(){
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices
        .filter(d => d.kind === "videoinput")
        .map((d, i) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${i + 1}`
        }));
    } catch(e){
      return [];
    }
  }

  /**
   * Start the camera stream.
   * @param {string} [deviceId] — optional device ID from enumerate().
   */
  async start(deviceId){
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      throw new Error(
        "getUserMedia is not available. This page must be served over HTTPS or " +
        "localhost — opening it directly from disk (file://) blocks camera access."
      );
    }

    const constraints = {
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false
    };

    if (deviceId){
      constraints.video.deviceId = { exact: deviceId };
      delete constraints.video.facingMode;
    }

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.video.srcObject = this.stream;
    
    this._playPromise = this.video.play();
    try {
      await this._playPromise;
    } catch (e) {
      if (e.name !== "AbortError") throw e;
    }

    return {
      width: this.video.videoWidth,
      height: this.video.videoHeight
    };
  }

  async stop(){
    if (this._playPromise){
      try {
        await this._playPromise;
      } catch (e) {}
      this._playPromise = null;
    }
    if (this.stream){
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
  }

  isActive(){
    return !!this.stream;
  }
}
