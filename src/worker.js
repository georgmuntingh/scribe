import { pipeline, env, AutoProcessor, AutoModel } from "@huggingface/transformers";

// Disable local model check — always fetch from HF Hub
env.allowLocalModels = false;

let transcriber = null;
let currentModelKey = null;

// Speaker embedding model state (using AutoModel + AutoProcessor directly,
// since audio models don't have a tokenizer and the pipeline API requires one)
let speakerProcessor = null;
let speakerModel = null;
let currentSpeakerModelKey = null;
let speakerModelConfig = null; // { model, device, quantization }

/**
 * Build the HF model id from user settings.
 * English-only models use the ".en" suffix (only available for tiny/base/small).
 */
function modelId(size, variant) {
  const base = `onnx-community/whisper-${size}`;
  return variant === "en" && size !== "medium" ? `${base}.en` : base;
}

/**
 * Map the user-friendly quantization label to the dtype config
 * Whisper is an encoder-decoder model so we can set per-module dtypes.
 * The encoder is more sensitive to quantization, so we keep it at higher
 * precision while the decoder can tolerate lower precision.
 */
function buildDtype(quantization) {
  switch (quantization) {
    case "fp32":
      return { encoder_model: "fp32", decoder_model_merged: "fp32" };
    case "fp16":
      return { encoder_model: "fp16", decoder_model_merged: "fp16" };
    case "q8":
      return { encoder_model: "fp32", decoder_model_merged: "q8" };
    case "q4":
      return { encoder_model: "fp32", decoder_model_merged: "q4" };
    default:
      return { encoder_model: "fp32", decoder_model_merged: "q8" };
  }
}

/**
 * Load (or re-load) the Whisper pipeline.
 */
async function loadModel({ model, variant, device, quantization }) {
  const id = modelId(model, variant);
  const key = `${id}|${device}|${quantization}`;

  // Skip if already loaded with the same config
  if (key === currentModelKey && transcriber) {
    self.postMessage({ type: "ready" });
    return;
  }

  // Dispose previous pipeline if switching models
  if (transcriber) {
    try {
      await transcriber.dispose();
    } catch {
      // ignore dispose errors
    }
    transcriber = null;
    currentModelKey = null;
  }

  self.postMessage({ type: "loading", progress: 0, status: `Loading ${id}...` });

  transcriber = await pipeline("automatic-speech-recognition", id, {
    device,
    dtype: buildDtype(quantization),
    progress_callback: (progress) => {
      if (progress.status === "progress") {
        self.postMessage({
          type: "loading",
          file: progress.file,
          progress: progress.progress,
          loaded: progress.loaded,
          total: progress.total,
          status: `Downloading ${progress.file}...`,
        });
      } else if (progress.status === "done") {
        self.postMessage({
          type: "loading",
          progress: 100,
          status: `Loaded ${progress.file}`,
        });
      } else if (progress.status === "ready") {
        // Pipeline fully ready
      }
    },
  });

  currentModelKey = key;
  self.postMessage({ type: "ready" });
}

/**
 * Run transcription on an audio buffer.
 */
async function transcribe({ audio, options, usesMerger, windowOffset }) {
  if (!transcriber) {
    self.postMessage({ type: "error", message: "Model not loaded" });
    return;
  }

  try {
    const generateKwargs = {};

    if (options.language && options.language !== "auto") {
      generateKwargs.language = options.language;
    }

    if (options.task) {
      generateKwargs.task = options.task;
    }

    if (options.beamWidth > 1) {
      generateKwargs.num_beams = options.beamWidth;
    }

    if (typeof options.temperature === "number") {
      generateKwargs.temperature = options.temperature;
    }

    const pipelineOptions = {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
    };

    if (options.initialPrompt) {
      pipelineOptions.initial_prompt = options.initialPrompt;
    }

    if (Object.keys(generateKwargs).length > 0) {
      pipelineOptions.generate_kwargs = generateKwargs;
    }

    const result = await transcriber(audio, pipelineOptions);

    self.postMessage({
      type: "result",
      text: result.text,
      chunks: result.chunks || [],
      usesMerger: !!usesMerger,
      windowOffset: windowOffset ?? 0,
    });
  } catch (err) {
    self.postMessage({ type: "error", message: err.message });
  }
}

/**
 * Shared progress callback for speaker model downloads.
 */
function speakerProgressCallback(progress) {
  if (progress.status === "progress") {
    self.postMessage({
      type: "loading",
      file: progress.file,
      progress: progress.progress,
      loaded: progress.loaded,
      total: progress.total,
      status: `Downloading ${progress.file}...`,
    });
  } else if (progress.status === "done") {
    self.postMessage({
      type: "loading",
      progress: 100,
      status: `Loaded ${progress.file}`,
    });
  }
}

/**
 * Load (or re-load) the speaker embedding model.
 * Uses AutoProcessor + AutoModel directly (audio models lack a tokenizer,
 * so the pipeline("feature-extraction") API cannot be used).
 */
async function loadSpeakerModel({ model, device, quantization }) {
  const key = `${model}|${device}|${quantization}`;

  if (key === currentSpeakerModelKey && speakerModel) {
    self.postMessage({ type: "speaker-model-ready" });
    return;
  }

  // Dispose previous speaker model
  if (speakerModel) {
    try {
      await speakerModel.dispose();
    } catch {
      // ignore dispose errors
    }
    speakerModel = null;
    speakerProcessor = null;
    currentSpeakerModelKey = null;
  }

  self.postMessage({
    type: "loading",
    progress: 0,
    status: `Loading speaker model ${model}...`,
  });

  speakerProcessor = await AutoProcessor.from_pretrained(model, {
    progress_callback: speakerProgressCallback,
  });

  speakerModel = await AutoModel.from_pretrained(model, {
    device,
    dtype: quantization,
    progress_callback: speakerProgressCallback,
  });

  speakerModelConfig = { model, device, quantization };
  currentSpeakerModelKey = key;
  self.postMessage({ type: "speaker-model-ready" });
}

/**
 * Detect WebGPU shader / compute-pipeline errors that indicate the GPU
 * backend cannot handle a particular kernel (common on Android Chrome).
 */
function isWebGPUError(err) {
  const msg = (err.message || String(err)).toLowerCase();
  return (
    msg.includes("webgpu") ||
    msg.includes("shadermodule") ||
    msg.includes("compute pipeline")
  );
}

/**
 * Reload the speaker model using the WASM (CPU) backend.
 * Called as a fallback when WebGPU fails mid-extraction.
 * The processor is device-independent so we keep it as-is.
 */
async function reloadSpeakerModelAsWasm() {
  if (!speakerModelConfig) throw new Error("No speaker model config");

  const { model, quantization } = speakerModelConfig;

  if (speakerModel) {
    try {
      await speakerModel.dispose();
    } catch {
      // ignore dispose errors
    }
    speakerModel = null;
    currentSpeakerModelKey = null;
  }

  self.postMessage({
    type: "loading",
    progress: 0,
    status: "WebGPU error \u2014 reloading speaker model on CPU...",
  });

  speakerModel = await AutoModel.from_pretrained(model, {
    device: "wasm",
    dtype: quantization,
    progress_callback: speakerProgressCallback,
  });

  speakerModelConfig.device = "wasm";
  currentSpeakerModelKey = `${model}|wasm|${quantization}`;
}

/**
 * Mean-pool a 3-D hidden-state tensor [1, seqLen, hiddenDim] and
 * L2-normalise the result, returning a plain Array of length hiddenDim.
 */
function meanPoolAndNormalize(data, seqLen, hiddenDim) {
  const embedding = new Float32Array(hiddenDim);
  for (let t = 0; t < seqLen; t++) {
    const offset = t * hiddenDim;
    for (let d = 0; d < hiddenDim; d++) {
      embedding[d] += data[offset + d];
    }
  }
  for (let d = 0; d < hiddenDim; d++) embedding[d] /= seqLen;

  let norm = 0;
  for (let d = 0; d < hiddenDim; d++) norm += embedding[d] * embedding[d];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let d = 0; d < hiddenDim; d++) embedding[d] /= norm;
  }
  return Array.from(embedding);
}

/**
 * Extract speaker embeddings from an array of audio buffers.
 *
 * If the model exposes an `embeddings` output (XVector architecture) those
 * are used directly; otherwise we fall back to mean-pooling the last hidden
 * state. All embeddings are L2-normalised before being returned.
 */
async function extractEmbeddings({ audioBuffers }) {
  if (!speakerModel || !speakerProcessor) {
    self.postMessage({
      type: "error",
      message: "Speaker model not loaded",
    });
    return;
  }

  const embeddings = [];
  let didFallback = false;

  for (let i = 0; i < audioBuffers.length; i++) {
    self.postMessage({
      type: "embedding-progress",
      current: i + 1,
      total: audioBuffers.length,
    });

    let output;
    try {
      const inputs = await speakerProcessor(audioBuffers[i]);
      output = await speakerModel(inputs);
    } catch (err) {
      // If WebGPU failed and we haven't already fallen back, reload on CPU
      if (
        !didFallback &&
        speakerModelConfig &&
        speakerModelConfig.device !== "wasm" &&
        isWebGPUError(err)
      ) {
        didFallback = true;
        await reloadSpeakerModelAsWasm();
        i--; // retry this sentence on WASM
        continue;
      }
      throw err;
    }

    let embedding;
    if (output.embeddings) {
      // XVector model — speaker embeddings already computed
      const raw = Array.from(output.embeddings.data);
      // L2-normalise
      let norm = 0;
      for (let d = 0; d < raw.length; d++) norm += raw[d] * raw[d];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let d = 0; d < raw.length; d++) raw[d] /= norm;
      embedding = raw;
    } else if (output.last_hidden_state) {
      // Base model — mean-pool hidden states
      const hs = output.last_hidden_state;
      const [, seqLen, hiddenDim] = hs.dims;
      embedding = meanPoolAndNormalize(hs.data, seqLen, hiddenDim);
    } else {
      throw new Error("Unexpected model output format");
    }

    embeddings.push(embedding);
  }

  self.postMessage({ type: "embeddings", embeddings });
}

// Message handler
self.addEventListener("message", async (e) => {
  const { type, ...data } = e.data;

  switch (type) {
    case "load":
      try {
        await loadModel(data);
      } catch (err) {
        self.postMessage({ type: "error", message: `Failed to load model: ${err.message}` });
      }
      break;
    case "transcribe":
      await transcribe(data);
      break;
    case "load-speaker-model":
      try {
        await loadSpeakerModel(data);
      } catch (err) {
        self.postMessage({
          type: "error",
          message: `Failed to load speaker model: ${err.message}`,
        });
      }
      break;
    case "extract-embeddings":
      try {
        await extractEmbeddings(data);
      } catch (err) {
        self.postMessage({
          type: "error",
          message: `Embedding extraction failed: ${err.message}`,
        });
      }
      break;
  }
});
