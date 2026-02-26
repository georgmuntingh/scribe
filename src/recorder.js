/**
 * Audio recorder module.
 * Handles microphone capture (chunked + manual modes) and file decoding.
 * All output is 16 kHz mono Float32Array — what Whisper expects.
 *
 * In real-time mode, audio is captured continuously via a ScriptProcessorNode
 * (no gaps) and overlapping windows are extracted from the accumulated buffer.
 * This eliminates the gap problem of stop-restart MediaRecorder cycling and
 * ensures words at chunk boundaries are transcribed correctly.
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
    this.overlapDuration = 3; // seconds of overlap between consecutive windows
    this._chunkTimer = null;

    // Continuous capture state (real-time mode)
    this._audioContext = null;
    this._sourceNode = null;
    this._processorNode = null;
    this._pcmBuffer = []; // accumulated Float32 chunks from processor
    this._pcmSampleCount = 0; // total samples accumulated (absolute)
    this._bufferBaseOffset = 0; // absolute sample position of _pcmBuffer[0]
    this._windowStart = 0; // sample offset for the next window's start

    // Callbacks
    this.onChunk = null;
    this.onComplete = null;
    this.onError = null;
    this.onRawSamples = null; // called with each raw PCM chunk (for audio buffer accumulation)
  }

  async start(mode, chunkIntervalSeconds, overlapSeconds) {
    this.mode = mode;
    this.chunkInterval = chunkIntervalSeconds || 10;
    this.overlapDuration =
      typeof overlapSeconds === "number" ? overlapSeconds : 3;
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
      this._startContinuousCapture();
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
   * Start continuous PCM capture at 16 kHz using an AudioContext.
   * Audio flows through: mic → MediaStreamSource → ScriptProcessor → accumulate.
   * A timer fires every (chunkInterval - overlapDuration) seconds to extract
   * overlapping windows from the buffer.
   */
  _startContinuousCapture() {
    this._pcmBuffer = [];
    this._pcmSampleCount = 0;
    this._bufferBaseOffset = 0;
    this._windowStart = 0;

    this._audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    this._sourceNode = this._audioContext.createMediaStreamSource(this.stream);

    // Buffer size 4096 at 16 kHz ≈ 256ms per callback — good balance.
    this._processorNode = this._audioContext.createScriptProcessor(4096, 1, 1);
    this._processorNode.onaudioprocess = (e) => {
      if (!this.recording) return;
      const input = e.inputBuffer.getChannelData(0);
      // Copy the samples (the buffer is reused by the browser)
      const copy = new Float32Array(input.length);
      copy.set(input);
      this._pcmBuffer.push(copy);
      this._pcmSampleCount += copy.length;
      if (this.onRawSamples) this.onRawSamples(copy);
    };

    this._sourceNode.connect(this._processorNode);
    // ScriptProcessorNode requires connection to destination to fire events
    this._processorNode.connect(this._audioContext.destination);

    // The step between windows: chunkInterval minus overlapDuration.
    // For example with 10s chunks and 3s overlap, we step 7s forward each time.
    const stepSeconds = Math.max(1, this.chunkInterval - this.overlapDuration);
    this._chunkTimer = setInterval(() => {
      if (!this.recording) return;
      this._emitWindow();
    }, stepSeconds * 1000);
  }

  /**
   * Extract the current window from the accumulated PCM buffer and emit it.
   * The window spans from _windowStart to _windowStart + chunkInterval*sampleRate,
   * then _windowStart advances by (chunkInterval - overlapDuration)*sampleRate.
   */
  _emitWindow() {
    const windowSamples = Math.round(this.chunkInterval * TARGET_SAMPLE_RATE);
    const stepSamples = Math.round(
      Math.max(1, this.chunkInterval - this.overlapDuration) *
        TARGET_SAMPLE_RATE,
    );

    // Not enough audio accumulated yet for a full window
    if (this._pcmSampleCount - this._windowStart < windowSamples) return;

    const windowOffsetSeconds = this._windowStart / TARGET_SAMPLE_RATE;
    const audio = this._extractSamples(this._windowStart, windowSamples);
    this._windowStart += stepSamples;

    // Trim old samples we no longer need (before the current window start)
    this._trimBuffer();

    if (this.onChunk && audio.length > 0) {
      this.onChunk(audio, windowOffsetSeconds);
    }
  }

  /**
   * Flatten the accumulated PCM chunks and extract a range of samples.
   * startSample is an absolute sample position; we adjust for trimmed chunks
   * using _bufferBaseOffset.
   */
  _extractSamples(startSample, count) {
    const result = new Float32Array(count);
    let written = 0;
    // offset tracks the absolute position of the current chunk's start
    let offset = this._bufferBaseOffset;

    for (const chunk of this._pcmBuffer) {
      const chunkEnd = offset + chunk.length;
      if (chunkEnd <= startSample) {
        offset = chunkEnd;
        continue;
      }
      if (offset >= startSample + count) break;

      const readStart = Math.max(0, startSample - offset);
      const readEnd = Math.min(chunk.length, startSample + count - offset);
      const segment = chunk.subarray(readStart, readEnd);
      result.set(segment, written);
      written += segment.length;
      offset = chunkEnd;
    }

    return result;
  }

  /**
   * Remove PCM chunks that are entirely before _windowStart to free memory.
   */
  _trimBuffer() {
    let offset = this._bufferBaseOffset;
    let trimCount = 0;
    for (const chunk of this._pcmBuffer) {
      if (offset + chunk.length <= this._windowStart) {
        offset += chunk.length;
        trimCount++;
      } else {
        break;
      }
    }
    if (trimCount > 0) {
      this._pcmBuffer.splice(0, trimCount);
      this._bufferBaseOffset = offset;
    }
  }

  stop() {
    this.recording = false;
    if (this._chunkTimer) {
      clearInterval(this._chunkTimer);
      this._chunkTimer = null;
    }

    if (this.mode === "realtime") {
      // Emit any remaining audio as a final chunk
      this._emitFinalWindow();
      this._stopContinuousCapture();
      this._cleanupStream();
    } else {
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        this.mediaRecorder.stop();
      }
    }
  }

  /**
   * Emit whatever audio remains in the buffer after the last emitted window.
   */
  _emitFinalWindow() {
    const remaining = this._pcmSampleCount - this._windowStart;
    if (remaining <= 0) return;

    // Use overlap: start from max(0, windowStart - overlapSamples)
    // so the final window overlaps with the previous one
    const overlapSamples = Math.round(
      this.overlapDuration * TARGET_SAMPLE_RATE,
    );
    const start = Math.max(0, this._windowStart - overlapSamples);
    const count = this._pcmSampleCount - start;

    if (count <= 0) return;

    const windowOffsetSeconds = start / TARGET_SAMPLE_RATE;
    const audio = this._extractSamples(start, count);
    if (this.onChunk && audio.length > 0) {
      this.onChunk(audio, windowOffsetSeconds);
    }
  }

  _stopContinuousCapture() {
    if (this._processorNode) {
      this._processorNode.disconnect();
      this._processorNode = null;
    }
    if (this._sourceNode) {
      this._sourceNode.disconnect();
      this._sourceNode = null;
    }
    if (this._audioContext) {
      this._audioContext.close().catch(() => {});
      this._audioContext = null;
    }
    this._pcmBuffer = [];
    this._pcmSampleCount = 0;
    this._bufferBaseOffset = 0;
    this._windowStart = 0;
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
