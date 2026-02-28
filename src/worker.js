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
 * onnx-community/whisper-medium does not exist on HF Hub; use Xenova/whisper-medium
 * which ships ONNX files with a transformers.js-compatible tokenizer.
 */
function modelId(size, variant) {
  if (size === "medium") {
    return "Xenova/whisper-medium";
  }
  const base = `onnx-community/whisper-${size}`;
  const hasEnglishOnly = ["tiny", "base", "small"].includes(size);
  return variant === "en" && hasEnglishOnly ? `${base}.en` : base;
}

/**
 * Map the user-friendly quantization label to the dtype config.
 * Whisper is an encoder-decoder model so we can set per-module dtypes.
 * The encoder is more sensitive to quantization, so we keep it at higher
 * precision while the decoder can tolerate lower precision.
 *
 * Xenova/whisper-medium uses the old "_quantized" file-name suffix for its
 * 8-bit decoder (not "_q8"), so we must pass "quantized" for that model.
 */
function buildDtype(quantization, model) {
  const decoderQ8 = model === "medium" ? "quantized" : "q8";
  switch (quantization) {
    case "fp32":
      return { encoder_model: "fp32", decoder_model_merged: "fp32" };
    case "fp16":
      return { encoder_model: "fp32", decoder_model_merged: "fp16" };
    case "q8":
      return { encoder_model: "fp32", decoder_model_merged: decoderQ8 };
    case "q4":
      return { encoder_model: "fp32", decoder_model_merged: "q4" };
    default:
      return { encoder_model: "fp32", decoder_model_merged: decoderQ8 };
  }
}

/**
 * Some models only have a limited set of decoder quantization formats.
 * Returns the effective quantization for the given model, falling back
 * to the nearest supported option.
 */
function effectiveQuantization(model, quantization) {
  if (model === 'large-v3-turbo') {
    // onnx-community/whisper-large-v3-turbo only ships decoder_model_merged.onnx
    // (fp32) and decoder_model_merged_fp16.onnx — there is no _q4 or _quantized
    // variant, so clamp anything heavier than fp16 down to fp16.
    if (quantization === 'q4' || quantization === 'q8' || quantization === 'q4f16') {
      return 'fp16';
    }
  }
  if (model === 'medium') {
    // Xenova/whisper-medium only ships decoder_model_merged.onnx (fp32) and
    // decoder_model_merged_quantized.onnx (q8) — clamp fp16 and q4 to q8.
    if (quantization === 'fp16' || quantization === 'q4' || quantization === 'q4f16') {
      return 'q8';
    }
  }
  return quantization;
}

/**
 * Load (or re-load) the Whisper pipeline.
 */
async function loadModel({ model, variant, device, quantization }) {
  const id = modelId(model, variant);
  quantization = effectiveQuantization(model, quantization);
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
    dtype: buildDtype(quantization, model),
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

const SAMPLE_RATE = 16000;

/**
 * Run the speaker model on a single audio buffer and return the
 * L2-normalised embedding as a plain Array.
 */
async function extractSingleEmbedding(audioBuffer) {
  const inputs = await speakerProcessor(audioBuffer);
  const output = await speakerModel(inputs);

  if (output.embeddings) {
    // XVector model — speaker embeddings already computed
    const raw = Array.from(output.embeddings.data);
    let norm = 0;
    for (let d = 0; d < raw.length; d++) norm += raw[d] * raw[d];
    norm = Math.sqrt(norm);
    if (norm > 0) for (let d = 0; d < raw.length; d++) raw[d] /= norm;
    return raw;
  } else if (output.last_hidden_state) {
    // Base model — mean-pool hidden states
    const hs = output.last_hidden_state;
    const [, seqLen, hiddenDim] = hs.dims;
    return meanPoolAndNormalize(hs.data, seqLen, hiddenDim);
  } else {
    throw new Error("Unexpected model output format");
  }
}

/**
 * Split an audio buffer into chunks of at most maxSamples.
 * Returns an array of Float32Array slices (always at least one).
 */
function chunkAudioBuffer(audioBuffer, maxSamples) {
  if (audioBuffer.length <= maxSamples) return [audioBuffer];
  const chunks = [];
  for (let offset = 0; offset < audioBuffer.length; offset += maxSamples) {
    chunks.push(audioBuffer.subarray(offset, offset + maxSamples));
  }
  return chunks;
}

/**
 * Average an array of embeddings and L2-normalise the result.
 */
function averageEmbeddings(embeddingList) {
  if (embeddingList.length === 1) return embeddingList[0];
  const dim = embeddingList[0].length;
  const avg = new Float32Array(dim);
  for (const emb of embeddingList) {
    for (let d = 0; d < dim; d++) avg[d] += emb[d];
  }
  for (let d = 0; d < dim; d++) avg[d] /= embeddingList.length;
  // L2-normalise
  let norm = 0;
  for (let d = 0; d < dim; d++) norm += avg[d] * avg[d];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let d = 0; d < dim; d++) avg[d] /= norm;
  return Array.from(avg);
}

/**
 * Extract speaker embeddings from an array of audio buffers.
 *
 * Long audio buffers are split into chunks of `maxChunkSeconds` before
 * inference, and the per-chunk embeddings are averaged. This keeps GPU
 * memory usage bounded and avoids WebGPU shader failures on some devices.
 *
 * If the model exposes an `embeddings` output (XVector architecture) those
 * are used directly; otherwise we fall back to mean-pooling the last hidden
 * state. All embeddings are L2-normalised before being returned.
 */
async function extractEmbeddings({ audioBuffers, maxChunkSeconds }) {
  if (!speakerModel || !speakerProcessor) {
    self.postMessage({
      type: "error",
      message: "Speaker model not loaded",
    });
    return;
  }

  const maxSamples =
    maxChunkSeconds > 0 ? maxChunkSeconds * SAMPLE_RATE : Infinity;
  const embeddings = [];
  let didFallback = false;

  for (let i = 0; i < audioBuffers.length; i++) {
    self.postMessage({
      type: "embedding-progress",
      current: i + 1,
      total: audioBuffers.length,
    });

    const chunks = chunkAudioBuffer(audioBuffers[i], maxSamples);
    const chunkEmbeddings = [];

    for (const chunk of chunks) {
      let emb;
      try {
        emb = await extractSingleEmbedding(chunk);
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
          emb = await extractSingleEmbedding(chunk); // retry on WASM
        } else {
          throw err;
        }
      }
      chunkEmbeddings.push(emb);
    }

    embeddings.push(averageEmbeddings(chunkEmbeddings));
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
