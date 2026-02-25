/**
 * Audio recorder module.
 * Handles microphone capture (chunked + manual modes) and file decoding.
 * All output is 16 kHz mono Float32Array — what Whisper expects.
 */

const TARGET_SAMPLE_RATE = 16000;

/**
 * Resample and convert an AudioBuffer to a 16 kHz mono Float32Array.
 */
async function audioBufferToFloat32(audioBuffer) {
  const offlineCtx = new OfflineAudioContext(
    1,
    Math.ceil(audioBuffer.duration * TARGET_SAMPLE_RATE),
    TARGET_SAMPLE_RATE,
  );
  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineCtx.destination);
  source.start();
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0);
}

/**
 * Decode a Blob (from MediaRecorder or file input) into a 16 kHz mono Float32Array.
 */
export async function decodeAudioBlob(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    return await audioBufferToFloat32(audioBuffer);
  } finally {
    await audioCtx.close();
  }
}

/**
 * Decode an audio File into 16 kHz mono Float32Array.
 */
export async function decodeAudioFile(file) {
  return decodeAudioBlob(file);
}

/**
 * Microphone recorder class.
 *
 * Events (via callbacks):
 *  onChunk(Float32Array)   — fired in real-time mode at each chunk interval
 *  onComplete(Float32Array) — fired in manual mode when recording stops
 *  onError(Error)
 */
export class MicRecorder {
  constructor() {
    this.stream = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.recording = false;
    this.mode = "realtime"; // "realtime" or "manual"
    this.chunkInterval = 10; // seconds
    this._chunkTimer = null;

    // Callbacks
    this.onChunk = null;
    this.onComplete = null;
    this.onError = null;
  }

  async start(mode, chunkIntervalSeconds) {
    this.mode = mode;
    this.chunkInterval = chunkIntervalSeconds || 10;
    this.chunks = [];
    this.recording = true;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      this.recording = false;
      if (this.onError) this.onError(err);
      return;
    }

    if (this.mode === "realtime") {
      // In real-time mode, we stop and restart the MediaRecorder at each
      // interval so that every segment is a complete, independently
      // decodable recording (the timeslice approach produces headerless
      // fragments after the first chunk that cannot be decoded).
      this._startRealtimeSegment();
      this._chunkTimer = setInterval(() => {
        if (!this.recording) return;
        this._rotateRealtimeSegment();
      }, this.chunkInterval * 1000);
    } else {
      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType: this._pickMimeType(),
      });

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.chunks.push(e.data);
      };

      this.mediaRecorder.onstop = async () => {
        if (this.chunks.length > 0) {
          try {
            const fullBlob = new Blob(this.chunks, {
              type: this.chunks[0].type,
            });
            const audio = await decodeAudioBlob(fullBlob);
            if (this.onComplete) this.onComplete(audio);
          } catch (err) {
            if (this.onError) this.onError(err);
          }
        }
        this._cleanup();
      };

      this.mediaRecorder.onerror = (e) => {
        if (this.onError)
          this.onError(e.error || new Error("Recording error"));
        this._cleanup();
      };

      this.mediaRecorder.start();
    }
  }

  /**
   * Start a new real-time segment. Each segment is an independent
   * MediaRecorder session that produces a complete, decodable blob.
   */
  _startRealtimeSegment() {
    // Use a local array so the onstop closure captures this segment's
    // chunks even after _rotateRealtimeSegment overwrites mediaRecorder.
    const segmentChunks = [];

    const mr = new MediaRecorder(this.stream, {
      mimeType: this._pickMimeType(),
    });

    mr.ondataavailable = (e) => {
      if (e.data.size > 0) segmentChunks.push(e.data);
    };

    mr.onstop = async () => {
      if (segmentChunks.length === 0) return;
      try {
        const blob = new Blob(segmentChunks, { type: segmentChunks[0].type });
        const audio = await decodeAudioBlob(blob);
        if (this.onChunk) this.onChunk(audio);
      } catch (err) {
        // Only report errors while actively recording; the final segment
        // when the user presses Stop may be too small to decode.
        if (this.recording && this.onError) this.onError(err);
      }
    };

    mr.onerror = (e) => {
      if (this.onError) this.onError(e.error || new Error("Recording error"));
    };

    this.mediaRecorder = mr;
    mr.start();
  }

  /**
   * Stop the current real-time segment and immediately start a new one.
   * The stopped segment's onstop handler will decode and emit its audio.
   */
  _rotateRealtimeSegment() {
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }
    this._startRealtimeSegment();
  }

  stop() {
    this.recording = false;
    if (this._chunkTimer) {
      clearInterval(this._chunkTimer);
      this._chunkTimer = null;
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }
    if (this.mode === "realtime") {
      this._cleanupStream();
    }
  }

  _cleanup() {
    this._cleanupStream();
    this.mediaRecorder = null;
    this.recording = false;
  }

  _cleanupStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }

  _pickMimeType() {
    const preferred = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ];
    for (const type of preferred) {
      if (MediaRecorder.isTypeSupported(type)) return type;
    }
    return "";
  }
}
