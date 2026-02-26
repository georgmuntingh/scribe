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
  copyTranscript,
  downloadTranscript,
  saveTranscriptToLibrary,
  loadTranscriptLibrary,
  loadTranscriptById,
  deleteTranscriptsFromLibrary,
} from "./ui.js";

// ── State ─────────────────────────────────────────────

let settings = loadSettings();
let theme = initTheme();
let appState = "idle"; // idle | loading | ready | recording | transcribing

const recorder = new MicRecorder();
const worker = new Worker(new URL("./worker.js", import.meta.url), {
  type: "module",
});

/** @type {Array<{text: string, start: number, end: number, speakerId: string|null}>} */
let transcriptSentences = [];
let pendingChunks = 0;
const merger = new SentenceMerger();

// ── DOM references ────────────────────────────────────

const themeBtn = document.getElementById("theme-btn");
const settingsBtn = document.getElementById("settings-btn");
const modalBackdrop = document.getElementById("modal-backdrop");
const transcriptEl = document.getElementById("transcript");
const copyBtn = document.getElementById("copy-btn");
const downloadBtn = document.getElementById("download-btn");
const saveBtn = document.getElementById("save-btn");
const clearBtn = document.getElementById("clear-btn");
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

// ── Init ──────────────────────────────────────────────

function init() {
  updateThemeBtn();
  updateModeToggle();
  updateTranscriptDisplay();
  setStatus("Select a model and start recording or upload a file.");

  // Check WebGPU availability
  if (!navigator.gpu) {
    if (settings.device === "webgpu") {
      settings.device = "wasm";
      saveSettings(settings);
    }
  }

  // Load the model immediately
  loadModel();
}

// ── Worker communication ──────────────────────────────

worker.addEventListener("message", (e) => {
  const msg = e.data;

  switch (msg.type) {
    case "loading":
      appState = "loading";
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
            // Real-time overlapping mode: merge using timestamps
            transcriptSentences = merger.addWindow(
              chunks,
              msg.windowOffset ?? 0,
            );
          } else {
            // File upload / manual mode: append chunks
            if (transcriptSentences.length > 0) {
              transcriptSentences = merger.appendChunks(chunks);
            } else {
              transcriptSentences = merger.setChunks(chunks);
            }
          }
          updateTranscriptDisplay();
        }
      }
      // If no more pending chunks and not recording, go back to ready
      if (pendingChunks <= 0 && appState === "transcribing") {
        appState = "ready";
        setStatus("Transcription complete.");
        updateControls();
      }
      break;

    case "error":
      pendingChunks = Math.max(0, pendingChunks - 1);
      setStatus(`Error: ${msg.message}`);
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
  // Don't change state while recording — real-time chunks are transcribed
  // in the background and the UI should keep showing "Stop".
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
  return sentences
    .map((s) => {
      const ts = `[${formatTimestamp(s.start)} - ${formatTimestamp(s.end)}]`;
      return `${ts} ${s.text}`;
    })
    .join("\n");
}

function updateTranscriptDisplay() {
  if (transcriptSentences.length > 0) {
    transcriptEl.innerHTML = transcriptSentences
      .map((s, i) => {
        const ts = `[${formatTimestamp(s.start)} - ${formatTimestamp(s.end)}]`;
        const speaker = s.speakerId || "";
        return (
          `<div class="sentence" data-sentence-id="s${i}" data-speaker="${escapeHtml(speaker)}">` +
          `<span class="sentence__time">${escapeHtml(ts)}</span> ` +
          `<span class="sentence__text">${escapeHtml(s.text)}</span>` +
          `</div>`
        );
      })
      .join("");
    transcriptEl.classList.remove("transcript--empty");
    // Auto-scroll to bottom
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  } else {
    transcriptEl.textContent = "Transcript will appear here...";
    transcriptEl.classList.add("transcript--empty");
  }
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
  copyBtn.disabled = !hasContent;
  downloadBtn.disabled = !hasContent;
  saveBtn.disabled = !hasContent;
  clearBtn.disabled = !hasContent;

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
  updateTranscriptDisplay();
  updateControls();
});

// Library modal
libraryBtn.addEventListener("click", () => {
  buildLibraryModal(
    modalBackdrop,
    // onOpen: load a single transcript into the display
    (transcript) => {
      transcriptSentences = transcript.sentences;
      merger.reset();
      updateTranscriptDisplay();
      updateControls();
      setStatus(`Opened: ${transcript.title}`);
    },
    // onDelete: handled internally by the modal
    // onSelect: return selected transcript data for future processing
    (selectedTranscripts) => {
      setStatus(`${selectedTranscripts.length} transcript(s) selected for processing.`);
      // Future: wire into processing pipeline
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
