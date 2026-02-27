import "./style.css";
import { MicRecorder, decodeAudioFile } from "./recorder.js";
import { SentenceMerger, formatTimestamp } from "./merger.js";
import {
  loadSettings,
  saveSettings,
  initTheme,
  cycleTheme,
  themeIcon,
  buildSettingsModal,
  buildLibraryModal,
  buildSpeakerNamesModal,
  copyTranscript,
  downloadTranscript,
  saveTranscriptToLibrary,
  loadTranscriptLibrary,
  loadTranscriptById,
  deleteTranscriptsFromLibrary,
  SPEAKER_COLORS,
  loadSpeakerNames,
  speakerDisplayName,
} from "./ui.js";

// ── Constants ─────────────────────────────────────────

const SAMPLE_RATE = 16000;
const MAX_AUDIO_DURATION_S = 60 * 60; // 60 minutes
const MAX_AUDIO_SAMPLES = MAX_AUDIO_DURATION_S * SAMPLE_RATE;

// ── State ─────────────────────────────────────────────

let settings = loadSettings();
let theme = initTheme();
let appState = "idle"; // idle | loading | ready | recording | transcribing
let speakerNames = loadSpeakerNames();

const recorder = new MicRecorder();
const worker = new Worker(new URL("./worker.js", import.meta.url), {
  type: "module",
});

/** @type {Array<{text: string, start: number, end: number, speakerId: string|null}>} */
let transcriptSentences = [];
let pendingChunks = 0;
const merger = new SentenceMerger();

// Selection state
let selectedIndices = new Set();
let lastClickedIndex = null;

// Speaker identification state
let identificationInProgress = false;
let pendingEmbeddingRequest = null;

// Audio buffer — retains full audio for waveform slicing (capped at 60 min)
let audioBufferSource = null; // Float32Array for file uploads
let micAudioChunks = []; // Array of Float32Array chunks for mic recording
let micAudioSampleCount = 0;
let micAudioBaseOffset = 0; // absolute sample offset of first retained chunk

// ── DOM references ────────────────────────────────────

const themeBtn = document.getElementById("theme-btn");
const settingsBtn = document.getElementById("settings-btn");
const speakersBtn = document.getElementById("speakers-btn");
const modalBackdrop = document.getElementById("modal-backdrop");
const transcriptEl = document.getElementById("transcript");
const copyBtn = document.getElementById("copy-btn");
const downloadBtn = document.getElementById("download-btn");
const saveBtn = document.getElementById("save-btn");
const clearBtn = document.getElementById("clear-btn");
const identifyBtn = document.getElementById("identify-btn");
const libraryBtn = document.getElementById("library-btn");
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const recordBtn = document.getElementById("record-btn");
const modeRealtime = document.getElementById("mode-realtime");
const modeManual = document.getElementById("mode-manual");
const progressContainer = document.getElementById("progress");
const progressFill = document.getElementById("progress-fill");
const progressText = document.getElementById("progress-text");
const statusEl = document.getElementById("status");

// ── Speaker toolbar (created dynamically) ─────────────

const speakerToolbar = document.createElement("div");
speakerToolbar.className = "speaker-toolbar";
speakerToolbar.style.display = "none";

// "?" button for unclassified (speaker 0)
const unclassifiedBtn = document.createElement("button");
unclassifiedBtn.className = "speaker-btn speaker-btn--unclassified";
unclassifiedBtn.textContent = "?";
unclassifiedBtn.title = "Unknown / unclassified";
unclassifiedBtn.addEventListener("click", () => assignSpeaker("0"));
speakerToolbar.appendChild(unclassifiedBtn);

// Speaker 1-6 buttons
for (const sp of SPEAKER_COLORS) {
  const btn = document.createElement("button");
  btn.className = "speaker-btn";
  btn.textContent = sp.id;
  btn.style.setProperty("--speaker-color", sp.color);
  btn.title = speakerDisplayName(sp.id, speakerNames) || sp.label;
  btn.dataset.speakerId = sp.id;
  btn.addEventListener("click", () => assignSpeaker(sp.id));
  speakerToolbar.appendChild(btn);
}

// Edit names button
const editNamesBtn = document.createElement("button");
editNamesBtn.className = "speaker-btn speaker-btn--edit";
editNamesBtn.innerHTML = "&#x270E;"; // pencil
editNamesBtn.title = "Edit speaker names";
editNamesBtn.addEventListener("click", openSpeakerNamesModal);
speakerToolbar.appendChild(editNamesBtn);

// Insert toolbar before transcript element
transcriptEl.parentNode.insertBefore(speakerToolbar, transcriptEl);

// ── Init ──────────────────────────────────────────────

function init() {
  updateThemeBtn();
  updateModeToggle();
  updateTranscriptDisplay();
  setStatus("Select a model and start recording or upload a file.");

  if (!navigator.gpu) {
    if (settings.device === "webgpu") {
      settings.device = "wasm";
      saveSettings(settings);
    }
  }

  loadModel();
}

// ── Worker communication ──────────────────────────────

worker.addEventListener("message", (e) => {
  const msg = e.data;

  switch (msg.type) {
    case "loading":
      if (!identificationInProgress) {
        appState = "loading";
      }
      showProgress(msg.progress, msg.status);
      updateControls();
      break;

    case "ready":
      appState = "ready";
      hideProgress();
      setStatus("Model loaded. Ready to transcribe.");
      updateControls();
      break;

    case "result":
      pendingChunks = Math.max(0, pendingChunks - 1);
      {
        const chunks = msg.chunks || [];
        if (chunks.length > 0) {
          if (msg.usesMerger) {
            transcriptSentences = merger.addWindow(
              chunks,
              msg.windowOffset ?? 0,
            );
          } else {
            if (transcriptSentences.length > 0) {
              transcriptSentences = merger.appendChunks(chunks);
            } else {
              transcriptSentences = merger.setChunks(chunks);
            }
          }
          // Clear selection on content change (sentences may have shifted)
          selectedIndices.clear();
          lastClickedIndex = null;
          updateTranscriptDisplay();
        }
      }
      if (pendingChunks <= 0 && appState === "transcribing") {
        appState = "ready";
        setStatus("Transcription complete.");
        updateControls();
      }
      break;

    case "speaker-model-ready":
      hideProgress();
      if (pendingEmbeddingRequest) {
        setStatus("Extracting speaker embeddings...");
        const audioBuffers = pendingEmbeddingRequest.map((it) => it.audio);
        worker.postMessage({ type: "extract-embeddings", audioBuffers });
      }
      break;

    case "embedding-progress":
      showProgress(
        (msg.current / msg.total) * 100,
        `Embedding ${msg.current}/${msg.total}`,
      );
      setStatus(
        `Extracting speaker embeddings: ${msg.current}/${msg.total}...`,
      );
      break;

    case "embeddings":
      hideProgress();
      assignSpeakersFromEmbeddings(msg.embeddings);
      break;

    case "error":
      pendingChunks = Math.max(0, pendingChunks - 1);
      setStatus(`Error: ${msg.message}`);
      if (identificationInProgress) {
        identificationInProgress = false;
        pendingEmbeddingRequest = null;
        hideProgress();
      }
      if (appState === "loading") {
        appState = "idle";
        hideProgress();
      } else if (pendingChunks <= 0) {
        appState = "ready";
      }
      updateControls();
      break;
  }
});

function loadModel() {
  const variantForModel =
    settings.variant === "en" && settings.model === "medium"
      ? "multilingual"
      : settings.variant;
  worker.postMessage({
    type: "load",
    model: settings.model,
    variant: variantForModel,
    device: settings.device,
    quantization: settings.quantization,
  });
}

function requestTranscription(
  audio,
  { usesMerger = false, windowOffset = 0 } = {},
) {
  pendingChunks++;
  if (appState !== "recording") {
    appState = "transcribing";
    setStatus("Transcribing...");
    updateControls();
  }
  worker.postMessage({
    type: "transcribe",
    audio,
    usesMerger,
    windowOffset,
    options: {
      language: settings.language,
      task: settings.task,
      beamWidth: settings.beamWidth,
      temperature: settings.temperature,
      initialPrompt: settings.initialPrompt,
    },
  });
}

// ── Audio buffer management ───────────────────────────

recorder.onRawSamples = (chunk) => {
  micAudioChunks.push(chunk);
  micAudioSampleCount += chunk.length;
  // Trim from front if exceeding 60-minute cap
  while (
    micAudioSampleCount > MAX_AUDIO_SAMPLES &&
    micAudioChunks.length > 1
  ) {
    const removed = micAudioChunks.shift();
    micAudioSampleCount -= removed.length;
    micAudioBaseOffset += removed.length;
  }
};

/**
 * Get a slice of audio for a given time range (seconds).
 * Returns a Float32Array or null if no audio is available.
 */
export function getAudioSlice(startSec, endSec) {
  if (audioBufferSource) {
    const s = Math.max(0, Math.round(startSec * SAMPLE_RATE));
    const e = Math.min(audioBufferSource.length, Math.round(endSec * SAMPLE_RATE));
    if (e <= s) return null;
    return audioBufferSource.slice(s, e);
  }

  if (micAudioChunks.length === 0) return null;

  const startSample = Math.round(startSec * SAMPLE_RATE);
  const endSample = Math.round(endSec * SAMPLE_RATE);
  const count = endSample - startSample;
  if (count <= 0) return null;

  const result = new Float32Array(count);
  let written = 0;
  let chunkAbsOffset = micAudioBaseOffset;

  for (const chunk of micAudioChunks) {
    const chunkEnd = chunkAbsOffset + chunk.length;
    if (chunkEnd <= startSample) {
      chunkAbsOffset = chunkEnd;
      continue;
    }
    if (chunkAbsOffset >= endSample) break;

    const readStart = Math.max(0, startSample - chunkAbsOffset);
    const readEnd = Math.min(chunk.length, endSample - chunkAbsOffset);
    const segment = chunk.subarray(readStart, readEnd);
    result.set(segment, written);
    written += segment.length;
    chunkAbsOffset = chunkEnd;
  }

  return result;
}

function resetAudioBuffer() {
  audioBufferSource = null;
  micAudioChunks = [];
  micAudioSampleCount = 0;
  micAudioBaseOffset = 0;
}

// ── Recorder callbacks ────────────────────────────────

recorder.onChunk = (audio, windowOffsetSeconds) => {
  requestTranscription(audio, {
    usesMerger: true,
    windowOffset: windowOffsetSeconds ?? 0,
  });
};

recorder.onComplete = (audio) => {
  requestTranscription(audio);
};

recorder.onError = (err) => {
  setStatus(`Microphone error: ${err.message}`);
  appState = "ready";
  updateControls();
};

// ── Recording controls ────────────────────────────────

function startRecording() {
  if (appState !== "ready") return;
  transcriptSentences = [];
  merger.reset();
  selectedIndices.clear();
  lastClickedIndex = null;
  resetAudioBuffer();
  updateTranscriptDisplay();
  appState = "recording";
  updateControls();
  setStatus(
    settings.recordingMode === "realtime"
      ? "Recording (real-time)... Speak now."
      : "Recording... Click Stop when done.",
  );
  recorder.start(
    settings.recordingMode,
    settings.chunkInterval,
    settings.overlapDuration,
  );
}

function stopRecording() {
  if (!recorder.recording) return;
  recorder.stop();
  if (settings.recordingMode === "realtime") {
    appState = pendingChunks > 0 ? "transcribing" : "ready";
    if (appState === "ready") setStatus("Recording stopped.");
  } else {
    setStatus("Processing recording...");
  }
  updateControls();
}

// ── File upload ───────────────────────────────────────

async function handleFile(file) {
  if (appState === "loading" || appState === "idle") {
    setStatus("Please wait for the model to load first.");
    return;
  }
  setStatus(`Processing ${file.name}...`);
  try {
    const audio = await decodeAudioFile(file);
    // Store full audio for waveform slicing
    audioBufferSource = audio;
    micAudioChunks = [];
    micAudioSampleCount = 0;
    micAudioBaseOffset = 0;
    requestTranscription(audio);
  } catch (err) {
    setStatus(`Failed to decode file: ${err.message}`);
  }
}

// ── Transcript display ───────────────────────────────

function escapeHtml(text) {
  const el = document.createElement("span");
  el.textContent = text;
  return el.innerHTML;
}

function sentencesToPlainText(sentences) {
  const names = speakerNames;
  return sentences
    .map((s) => {
      const ts = `[${formatTimestamp(s.start)} - ${formatTimestamp(s.end)}]`;
      const name = speakerDisplayName(s.speakerId, names);
      const prefix = name ? `${name}: ` : "";
      return `${ts} ${prefix}${s.text}`;
    })
    .join("\n");
}

function updateTranscriptDisplay() {
  if (transcriptSentences.length > 0) {
    const names = speakerNames;
    transcriptEl.innerHTML = transcriptSentences
      .map((s, i) => {
        const ts = `[${formatTimestamp(s.start)} - ${formatTimestamp(s.end)}]`;
        const speaker = s.speakerId || "";
        const name = speakerDisplayName(s.speakerId, names);
        const nameHtml = name
          ? `<span class="sentence__speaker">${escapeHtml(name)}:</span> `
          : "";
        const selected = selectedIndices.has(i) ? " sentence--selected" : "";
        const inferred = s.speakerInferred ? " sentence--inferred" : "";
        return (
          `<div class="sentence${selected}${inferred}" data-sentence-id="s${i}" data-speaker="${escapeHtml(speaker)}">` +
          `<span class="sentence__time">${escapeHtml(ts)}</span> ` +
          nameHtml +
          `<span class="sentence__text">${escapeHtml(s.text)}</span>` +
          `</div>`
        );
      })
      .join("");
    transcriptEl.classList.remove("transcript--empty");
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  } else {
    transcriptEl.textContent = "Transcript will appear here...";
    transcriptEl.classList.add("transcript--empty");
  }
  updateSpeakerToolbar();
}

// ── Sentence selection ────────────────────────────────

transcriptEl.addEventListener("click", (e) => {
  const sentenceEl = e.target.closest(".sentence");
  if (!sentenceEl) {
    // Clicked empty space — clear selection
    selectedIndices.clear();
    lastClickedIndex = null;
    updateSelectionDisplay();
    updateSpeakerToolbar();
    return;
  }

  const idStr = sentenceEl.dataset.sentenceId;
  const index = parseInt(idStr.replace("s", ""), 10);
  if (isNaN(index)) return;

  if (e.shiftKey && lastClickedIndex != null) {
    // Range select
    const from = Math.min(lastClickedIndex, index);
    const to = Math.max(lastClickedIndex, index);
    if (!e.ctrlKey && !e.metaKey) selectedIndices.clear();
    for (let i = from; i <= to; i++) selectedIndices.add(i);
  } else if (e.ctrlKey || e.metaKey) {
    // Toggle individual
    if (selectedIndices.has(index)) {
      selectedIndices.delete(index);
    } else {
      selectedIndices.add(index);
    }
  } else {
    // Single select
    selectedIndices.clear();
    selectedIndices.add(index);
  }

  lastClickedIndex = index;
  updateSelectionDisplay();
  updateSpeakerToolbar();
});

function updateSelectionDisplay() {
  const sentenceEls = transcriptEl.querySelectorAll(".sentence");
  sentenceEls.forEach((el) => {
    const idStr = el.dataset.sentenceId;
    const idx = parseInt(idStr.replace("s", ""), 10);
    el.classList.toggle("sentence--selected", selectedIndices.has(idx));
  });
}

function updateSpeakerToolbar() {
  speakerToolbar.style.display =
    selectedIndices.size > 0 ? "flex" : "none";
}

// ── Speaker assignment ────────────────────────────────

function assignSpeaker(speakerId) {
  for (const idx of selectedIndices) {
    if (idx >= transcriptSentences.length) continue;
    const s = transcriptSentences[idx];
    s.speakerId = speakerId;
    s.speakerInferred = false;
    // Persist in the merger's label store
    merger.setSpeakerLabel(s.start, s.end, speakerId, false);
    // Update DOM element in place
    const el = transcriptEl.querySelector(`[data-sentence-id="s${idx}"]`);
    if (el) {
      el.dataset.speaker = speakerId;
      // Update speaker name
      const existingNameEl = el.querySelector(".sentence__speaker");
      const name = speakerDisplayName(speakerId, speakerNames);
      if (name) {
        if (existingNameEl) {
          existingNameEl.textContent = name + ":";
        } else {
          const nameSpan = document.createElement("span");
          nameSpan.className = "sentence__speaker";
          nameSpan.textContent = name + ":";
          const timeEl = el.querySelector(".sentence__time");
          timeEl.insertAdjacentElement("afterend", nameSpan);
          // Add a space text node after the name
          nameSpan.insertAdjacentText("afterend", " ");
        }
      } else if (existingNameEl) {
        existingNameEl.remove();
      }
    }
  }
  // Clear selection after assignment
  selectedIndices.clear();
  lastClickedIndex = null;
  updateSelectionDisplay();
  updateSpeakerToolbar();
}

// ── Speaker names modal ───────────────────────────────

function openSpeakerNamesModal() {
  buildSpeakerNamesModal(modalBackdrop, (updatedNames) => {
    speakerNames = updatedNames;
    // Update toolbar button tooltips
    for (const sp of SPEAKER_COLORS) {
      const btn = speakerToolbar.querySelector(
        `[data-speaker-id="${sp.id}"]`,
      );
      if (btn) {
        btn.title = speakerDisplayName(sp.id, speakerNames) || sp.label;
      }
    }
    // Re-render transcript to update speaker names
    updateTranscriptDisplay();
  });
  modalBackdrop.classList.add("modal-backdrop--open");
}

// ── Progress ──────────────────────────────────────────

function showProgress(percent, text) {
  progressContainer.classList.add("progress--visible");
  progressFill.style.width = `${Math.min(100, percent || 0)}%`;
  progressText.textContent = text || "";
}

function hideProgress() {
  progressContainer.classList.remove("progress--visible");
  progressFill.style.width = "0%";
  progressText.textContent = "";
}

// ── Status ────────────────────────────────────────────

function setStatus(msg) {
  statusEl.textContent = msg;
}

// ── Controls state ────────────────────────────────────

function updateControls() {
  const isReady = appState === "ready";
  const isRecording = appState === "recording";

  recordBtn.disabled = !isReady && !isRecording;

  if (isRecording) {
    recordBtn.textContent = "Stop";
    recordBtn.classList.add("btn--danger");
    recordBtn.classList.remove("btn--primary");
  } else {
    recordBtn.textContent = "Record";
    recordBtn.classList.remove("btn--danger");
    recordBtn.classList.add("btn--primary");
  }

  const hasContent = transcriptSentences.length > 0;
  const hasAudio = !!(audioBufferSource || micAudioChunks.length > 0);
  copyBtn.disabled = !hasContent;
  downloadBtn.disabled = !hasContent;
  saveBtn.disabled = !hasContent;
  clearBtn.disabled = !hasContent;
  identifyBtn.disabled =
    !hasContent || !hasAudio || identificationInProgress;

  const canInteract = isReady || appState === "transcribing";
  dropzone.style.pointerEvents = canInteract ? "auto" : "none";
  dropzone.style.opacity = canInteract ? "1" : "0.5";
}

function updateModeToggle() {
  const isRealtime = settings.recordingMode === "realtime";
  modeRealtime.classList.toggle("mode-toggle__btn--active", isRealtime);
  modeManual.classList.toggle("mode-toggle__btn--active", !isRealtime);
}

function updateThemeBtn() {
  themeBtn.textContent = themeIcon(theme);
  themeBtn.title = `Theme: ${theme}`;
}

// ── Speaker identification ────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function aggregateScores(scores, method) {
  if (scores.length === 0) return 0;
  if (scores.length === 1) return scores[0];

  switch (method) {
    case "max":
      return Math.max(...scores);
    case "median": {
      const sorted = [...scores].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    case "mean":
    default:
      return scores.reduce((sum, s) => sum + s, 0) / scores.length;
  }
}

function identifySpeakers() {
  if (identificationInProgress) return;

  // Collect all sentences with their audio slices
  const items = [];
  for (let i = 0; i < transcriptSentences.length; i++) {
    const s = transcriptSentences[i];
    const audio = getAudioSlice(s.start, s.end);
    if (!audio || audio.length === 0) continue;
    items.push({
      index: i,
      audio,
      speakerId: s.speakerId,
      inferred: !!s.speakerInferred,
    });
  }

  if (items.length === 0) {
    setStatus("No audio available for speaker identification.");
    return;
  }

  // Check we have at least one manually labeled sentence
  const hasManualLabels = items.some(
    (it) => it.speakerId && it.speakerId !== "0" && !it.inferred,
  );
  if (!hasManualLabels) {
    setStatus(
      "Please manually label at least one sentence per speaker before identifying.",
    );
    return;
  }

  identificationInProgress = true;
  pendingEmbeddingRequest = items;
  updateControls();

  setStatus("Loading speaker model...");
  worker.postMessage({
    type: "load-speaker-model",
    model: settings.speakerModel,
    device: settings.device,
    quantization: settings.speakerQuantization,
  });
}

function assignSpeakersFromEmbeddings(embeddings) {
  if (!pendingEmbeddingRequest) return;

  const items = pendingEmbeddingRequest;
  pendingEmbeddingRequest = null;

  // Attach embeddings to items
  for (let i = 0; i < items.length; i++) {
    items[i].embedding = embeddings[i];
  }

  // Separate reference (manually labeled, non-inferred) from unlabeled
  const references = items.filter(
    (it) => it.speakerId && it.speakerId !== "0" && !it.inferred,
  );
  const unlabeled = items.filter(
    (it) => !it.speakerId || it.speakerId === "0" || it.inferred,
  );

  if (references.length === 0) {
    identificationInProgress = false;
    updateControls();
    setStatus("No manually labeled sentences to use as reference.");
    return;
  }

  // Group reference embeddings by speaker
  const speakerRefs = {};
  for (const ref of references) {
    if (!speakerRefs[ref.speakerId]) speakerRefs[ref.speakerId] = [];
    speakerRefs[ref.speakerId].push(ref.embedding);
  }

  // For each unlabeled sentence, compute similarity to each speaker
  let assignedCount = 0;
  for (const item of unlabeled) {
    let bestSpeaker = null;
    let bestScore = -Infinity;

    for (const [speakerId, refEmbeddings] of Object.entries(speakerRefs)) {
      const scores = refEmbeddings.map((ref) =>
        cosineSimilarity(item.embedding, ref),
      );
      const aggregated = aggregateScores(scores, settings.speakerAggregation);

      if (aggregated > bestScore) {
        bestScore = aggregated;
        bestSpeaker = speakerId;
      }
    }

    const s = transcriptSentences[item.index];
    if (bestScore >= settings.speakerThreshold && bestSpeaker) {
      s.speakerId = bestSpeaker;
      s.speakerInferred = true;
      merger.setSpeakerLabel(s.start, s.end, bestSpeaker, true);
      assignedCount++;
    } else {
      s.speakerId = "0";
      s.speakerInferred = true;
      merger.setSpeakerLabel(s.start, s.end, "0", true);
    }
  }

  identificationInProgress = false;
  selectedIndices.clear();
  lastClickedIndex = null;
  updateTranscriptDisplay();
  updateControls();
  setStatus(
    `Speaker identification complete. Assigned ${assignedCount} of ${unlabeled.length} sentence(s).`,
  );
}

// ── Event listeners ───────────────────────────────────

// Theme toggle
themeBtn.addEventListener("click", () => {
  theme = cycleTheme(theme);
  updateThemeBtn();
});

// Settings modal
settingsBtn.addEventListener("click", () => {
  buildSettingsModal(modalBackdrop, settings, (updated) => {
    const modelChanged =
      updated.model !== settings.model ||
      updated.variant !== settings.variant ||
      updated.device !== settings.device ||
      updated.quantization !== settings.quantization;
    settings = updated;
    updateModeToggle();
    if (modelChanged) {
      loadModel();
    }
  });
  modalBackdrop.classList.add("modal-backdrop--open");
});

// Speakers names modal (header icon)
speakersBtn.addEventListener("click", openSpeakerNamesModal);

// Close modal on backdrop click
modalBackdrop.addEventListener("click", () => {
  modalBackdrop.classList.remove("modal-backdrop--open");
});

// Record button
recordBtn.addEventListener("click", () => {
  if (recorder.recording) {
    stopRecording();
  } else {
    startRecording();
  }
});

// Mode toggle
modeRealtime.addEventListener("click", () => {
  settings.recordingMode = "realtime";
  saveSettings(settings);
  updateModeToggle();
});

modeManual.addEventListener("click", () => {
  settings.recordingMode = "manual";
  saveSettings(settings);
  updateModeToggle();
});

// Copy
copyBtn.addEventListener("click", async () => {
  if (transcriptSentences.length === 0) return;
  try {
    await copyTranscript(sentencesToPlainText(transcriptSentences));
    const orig = copyBtn.textContent;
    copyBtn.textContent = "Copied!";
    setTimeout(() => (copyBtn.textContent = orig), 1500);
  } catch {
    setStatus("Failed to copy to clipboard.");
  }
});

// Download
downloadBtn.addEventListener("click", () => {
  if (transcriptSentences.length === 0) return;
  downloadTranscript(sentencesToPlainText(transcriptSentences));
});

// Save to library
saveBtn.addEventListener("click", () => {
  if (transcriptSentences.length === 0) return;
  saveTranscriptToLibrary(transcriptSentences);
  const orig = saveBtn.textContent;
  saveBtn.textContent = "Saved!";
  setTimeout(() => (saveBtn.textContent = orig), 1500);
  setStatus("Transcript saved to library.");
});

// Clear
clearBtn.addEventListener("click", () => {
  transcriptSentences = [];
  merger.reset();
  selectedIndices.clear();
  lastClickedIndex = null;
  resetAudioBuffer();
  updateTranscriptDisplay();
  updateControls();
});

// Identify speakers
identifyBtn.addEventListener("click", identifySpeakers);

// Library modal
libraryBtn.addEventListener("click", () => {
  buildLibraryModal(
    modalBackdrop,
    (transcript) => {
      transcriptSentences = transcript.sentences;
      merger.reset();
      selectedIndices.clear();
      lastClickedIndex = null;
      updateTranscriptDisplay();
      updateControls();
      setStatus(`Opened: ${transcript.title}`);
    },
    (selectedTranscripts) => {
      setStatus(
        `${selectedTranscripts.length} transcript(s) selected for processing.`,
      );
    },
  );
  modalBackdrop.classList.add("modal-backdrop--open");
});

// File drop zone
dropzone.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) handleFile(file);
  fileInput.value = "";
});

dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dropzone--active");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dropzone--active");
});

dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dropzone--active");
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// ── Start ─────────────────────────────────────────────

init();
