import { pipeline, env } from "@huggingface/transformers";

// Disable local model check — always fetch from HF Hub
env.allowLocalModels = false;

let transcriber = null;
let currentModelKey = null;

// Speaker embedding model state
let speakerExtractor = null;
let currentSpeakerModelKey = null;

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
 * Load (or re-load) the speaker embedding model.
 */
async function loadSpeakerModel({ model, device, quantization }) {
  const key = `${model}|${device}|${quantization}`;

  if (key === currentSpeakerModelKey && speakerExtractor) {
    self.postMessage({ type: "speaker-model-ready" });
    return;
  }

  // Dispose previous speaker model
  if (speakerExtractor) {
    try {
      await speakerExtractor.dispose();
    } catch {
      // ignore dispose errors
    }
    speakerExtractor = null;
    currentSpeakerModelKey = null;
  }

  self.postMessage({
    type: "loading",
    progress: 0,
    status: `Loading speaker model ${model}...`,
  });

  speakerExtractor = await pipeline("feature-extraction", model, {
    device,
    dtype: quantization,
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
      }
    },
  });

  currentSpeakerModelKey = key;
  self.postMessage({ type: "speaker-model-ready" });
}

/**
 * Extract speaker embeddings from an array of audio buffers.
 * Returns mean-pooled, L2-normalized embeddings.
 */
async function extractEmbeddings({ audioBuffers }) {
  if (!speakerExtractor) {
    self.postMessage({
      type: "error",
      message: "Speaker model not loaded",
    });
    return;
  }

  const embeddings = [];
  for (let i = 0; i < audioBuffers.length; i++) {
    self.postMessage({
      type: "embedding-progress",
      current: i + 1,
      total: audioBuffers.length,
    });

    const output = await speakerExtractor(audioBuffers[i], {
      pooling: "mean",
      normalize: true,
    });

    embeddings.push(Array.from(output.data));
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
