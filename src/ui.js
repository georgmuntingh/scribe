/**
 * UI module — settings modal, theme toggle, transcript display helpers,
 * transcript library storage and modal.
 */

// ── Whisper language list ──────────────────────────────

const LANGUAGES = [
  ["auto", "Auto-detect"],
  ["en", "English"],
  ["zh", "Chinese"],
  ["de", "German"],
  ["es", "Spanish"],
  ["ru", "Russian"],
  ["ko", "Korean"],
  ["fr", "French"],
  ["ja", "Japanese"],
  ["pt", "Portuguese"],
  ["tr", "Turkish"],
  ["pl", "Polish"],
  ["ca", "Catalan"],
  ["nl", "Dutch"],
  ["ar", "Arabic"],
  ["sv", "Swedish"],
  ["it", "Italian"],
  ["id", "Indonesian"],
  ["hi", "Hindi"],
  ["fi", "Finnish"],
  ["vi", "Vietnamese"],
  ["he", "Hebrew"],
  ["uk", "Ukrainian"],
  ["el", "Greek"],
  ["ms", "Malay"],
  ["cs", "Czech"],
  ["ro", "Romanian"],
  ["da", "Danish"],
  ["hu", "Hungarian"],
  ["ta", "Tamil"],
  ["no", "Norwegian"],
  ["th", "Thai"],
  ["ur", "Urdu"],
  ["hr", "Croatian"],
  ["bg", "Bulgarian"],
  ["lt", "Lithuanian"],
  ["la", "Latin"],
  ["mi", "Maori"],
  ["ml", "Malayalam"],
  ["cy", "Welsh"],
  ["sk", "Slovak"],
  ["te", "Telugu"],
  ["fa", "Persian"],
  ["lv", "Latvian"],
  ["bn", "Bengali"],
  ["sr", "Serbian"],
  ["az", "Azerbaijani"],
  ["sl", "Slovenian"],
  ["kn", "Kannada"],
  ["et", "Estonian"],
  ["mk", "Macedonian"],
  ["br", "Breton"],
  ["eu", "Basque"],
  ["is", "Icelandic"],
  ["hy", "Armenian"],
  ["ne", "Nepali"],
  ["mn", "Mongolian"],
  ["bs", "Bosnian"],
  ["kk", "Kazakh"],
  ["sq", "Albanian"],
  ["sw", "Swahili"],
  ["gl", "Galician"],
  ["mr", "Marathi"],
  ["pa", "Punjabi"],
  ["si", "Sinhala"],
  ["km", "Khmer"],
  ["sn", "Shona"],
  ["yo", "Yoruba"],
  ["so", "Somali"],
  ["af", "Afrikaans"],
  ["oc", "Occitan"],
  ["ka", "Georgian"],
  ["be", "Belarusian"],
  ["tg", "Tajik"],
  ["sd", "Sindhi"],
  ["gu", "Gujarati"],
  ["am", "Amharic"],
  ["yi", "Yiddish"],
  ["lo", "Lao"],
  ["uz", "Uzbek"],
  ["fo", "Faroese"],
  ["ht", "Haitian Creole"],
  ["ps", "Pashto"],
  ["tk", "Turkmen"],
  ["nn", "Nynorsk"],
  ["mt", "Maltese"],
  ["sa", "Sanskrit"],
  ["lb", "Luxembourgish"],
  ["my", "Myanmar"],
  ["bo", "Tibetan"],
  ["tl", "Tagalog"],
  ["mg", "Malagasy"],
  ["as", "Assamese"],
  ["tt", "Tatar"],
  ["haw", "Hawaiian"],
  ["ln", "Lingala"],
  ["ha", "Hausa"],
  ["ba", "Bashkir"],
  ["jw", "Javanese"],
  ["su", "Sundanese"],
];

// ── Default settings ──────────────────────────────────

export const DEFAULT_SETTINGS = {
  model: "tiny",
  variant: "multilingual",
  language: "auto",
  task: "transcribe",
  device: "webgpu",
  quantization: "q4",
  beamWidth: 1,
  temperature: 0,
  initialPrompt: "",
  chunkInterval: 10,
  overlapDuration: 3,
  recordingMode: "realtime",
  speakerModel: "Xenova/wavlm-base-plus-sv",
  speakerQuantization: "fp32",
  speakerThreshold: 0.86,
  speakerAggregation: "mean",
  speakerMaxChunkSeconds: 10,
};

// ── Settings persistence ──────────────────────────────

const STORAGE_KEY = "scribe_settings";
const THEME_KEY = "scribe_theme";
const LIBRARY_INDEX_KEY = "scribe_transcript_index";
const LIBRARY_PREFIX = "scribe_transcript_";
const SPEAKER_NAMES_KEY = "scribe_speaker_names";

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

// ── Theme ─────────────────────────────────────────────

export function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") {
    document.documentElement.setAttribute("data-theme", saved);
  }
  return saved || "auto";
}

export function cycleTheme(current) {
  const order = ["auto", "light", "dark"];
  const next = order[(order.indexOf(current) + 1) % order.length];
  if (next === "auto") {
    document.documentElement.removeAttribute("data-theme");
    localStorage.removeItem(THEME_KEY);
  } else {
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_KEY, next);
  }
  return next;
}

export function themeIcon(theme) {
  switch (theme) {
    case "light":
      return "\u2600\uFE0F"; // sun
    case "dark":
      return "\uD83C\uDF19"; // moon
    default:
      return "\uD83D\uDCBB"; // auto/system
  }
}

// ── Settings modal builder ────────────────────────────

export function buildSettingsModal(container, settings, onSave) {
  container.innerHTML = "";

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.addEventListener("click", (e) => e.stopPropagation());

  // Header
  const header = document.createElement("div");
  header.className = "modal__header";
  header.innerHTML = `
    <span class="modal__title">Settings</span>
    <button class="modal__close" aria-label="Close">&times;</button>
  `;
  modal.appendChild(header);

  // ── Model section ──────────────────
  const modelSection = section("Model");

  const modelRow = document.createElement("div");
  modelRow.className = "field__row";
  modelRow.appendChild(
    selectField("Model size", "s-model", settings.model, [
      ["tiny", "Tiny (~39 MB)"],
      ["base", "Base (~74 MB)"],
      ["small", "Small (~244 MB)"],
      ["medium", "Medium (~769 MB)"],
      ["large-v3-turbo", "Large v3 Turbo (~809 MB)"],
    ]),
  );
  modelRow.appendChild(
    selectField("Variant", "s-variant", settings.variant, [
      ["multilingual", "Multilingual"],
      ["en", "English-only"],
    ]),
  );
  modelSection.appendChild(modelRow);

  const languageField = selectField(
    "Language",
    "s-language",
    settings.language,
    LANGUAGES,
  );
  languageField.id = "field-language";
  modelSection.appendChild(languageField);

  modelSection.appendChild(
    selectField("Task", "s-task", settings.task, [
      ["transcribe", "Transcribe"],
      ["translate", "Translate to English"],
    ]),
  );

  modal.appendChild(modelSection);

  // ── Backend section ────────────────
  const backendSection = section("Backend");

  const backendRow = document.createElement("div");
  backendRow.className = "field__row";
  backendRow.appendChild(
    selectField("Device", "s-device", settings.device, [
      ["webgpu", "WebGPU (GPU)"],
      ["wasm", "WASM (CPU)"],
    ]),
  );
  backendRow.appendChild(
    selectField("Quantization", "s-quantization", settings.quantization, [
      ["fp32", "fp32"],
      ["fp16", "fp16"],
      ["q8", "q8"],
      ["q4", "q4"],
    ]),
  );
  backendSection.appendChild(backendRow);

  const hint = document.createElement("div");
  hint.className = "field__hint";
  hint.textContent =
    "Recommended: fp32 for WebGPU, q4/q8 for WASM. Encoder always uses fp32 for quality.";
  backendSection.appendChild(hint);

  modal.appendChild(backendSection);

  // ── Generation section ─────────────
  const genSection = section("Generation");

  const genRow = document.createElement("div");
  genRow.className = "field__row";
  genRow.appendChild(
    numberField("Beam width", "s-beamWidth", settings.beamWidth, 1, 10, 1),
  );
  genRow.appendChild(
    numberField(
      "Temperature",
      "s-temperature",
      settings.temperature,
      0,
      1,
      0.1,
    ),
  );
  genSection.appendChild(genRow);

  genSection.appendChild(
    textareaField(
      "Initial prompt",
      "s-initialPrompt",
      settings.initialPrompt,
      "Optional text to bias style/vocabulary...",
    ),
  );

  modal.appendChild(genSection);

  // ── Recording section ──────────────
  const recSection = section("Recording");

  recSection.appendChild(
    rangeField(
      "Chunk interval (seconds)",
      "s-chunkInterval",
      settings.chunkInterval,
      5,
      30,
      1,
    ),
  );

  recSection.appendChild(
    rangeField(
      "Overlap duration (seconds)",
      "s-overlapDuration",
      settings.overlapDuration,
      1,
      10,
      1,
    ),
  );

  const overlapHint = document.createElement("div");
  overlapHint.className = "field__hint";
  overlapHint.textContent =
    "Overlap between consecutive audio windows. Higher values improve accuracy at chunk boundaries but increase processing.";
  recSection.appendChild(overlapHint);

  modal.appendChild(recSection);

  // ── Speaker Recognition section ────
  const srSection = section("Speaker Recognition");

  srSection.appendChild(
    textareaField(
      "Speaker model",
      "s-speakerModel",
      settings.speakerModel,
      "HuggingFace model ID for speaker embeddings...",
    ),
  );

  // Make it a single-line textarea visually
  const srModelTa = srSection.querySelector("#s-speakerModel");
  if (srModelTa) {
    srModelTa.style.minHeight = "auto";
    srModelTa.rows = 1;
  }

  srSection.appendChild(
    selectField(
      "Speaker quantization",
      "s-speakerQuantization",
      settings.speakerQuantization,
      [
        ["fp32", "fp32"],
        ["fp16", "fp16"],
        ["q8", "q8"],
        ["q4", "q4"],
      ],
    ),
  );

  srSection.appendChild(
    rangeField(
      "Similarity threshold",
      "s-speakerThreshold",
      settings.speakerThreshold,
      0.5,
      1.0,
      0.01,
    ),
  );

  srSection.appendChild(
    selectField(
      "Score aggregation",
      "s-speakerAggregation",
      settings.speakerAggregation,
      [
        ["mean", "Mean"],
        ["max", "Max"],
        ["median", "Median"],
      ],
    ),
  );

  srSection.appendChild(
    rangeField(
      "Max chunk length (seconds)",
      "s-speakerMaxChunkSeconds",
      settings.speakerMaxChunkSeconds,
      5,
      30,
      1,
    ),
  );

  const srHint = document.createElement("div");
  srHint.className = "field__hint";
  srHint.textContent =
    "Speaker identification compares sentence embeddings to manually labeled references. Aggregation controls how multiple reference scores per speaker are combined. Long sentences are split into chunks for embedding extraction.";
  srSection.appendChild(srHint);

  modal.appendChild(srSection);

  // ── Footer ─────────────────────────
  const footer = document.createElement("div");
  footer.className = "modal__footer";
  footer.innerHTML = `
    <button class="btn" id="settings-cancel">Cancel</button>
    <button class="btn btn--primary" id="settings-save">Save &amp; Apply</button>
  `;
  modal.appendChild(footer);

  container.appendChild(modal);

  // ── Event wiring ───────────────────

  // Toggle language visibility based on variant
  const variantSelect = modal.querySelector("#s-variant");
  const langContainer = modal.querySelector("#field-language");
  function updateLangVisibility() {
    langContainer.style.display =
      variantSelect.value === "en" ? "none" : "block";
  }
  updateLangVisibility();
  variantSelect.addEventListener("change", updateLangVisibility);

  // Close
  header.querySelector(".modal__close").addEventListener("click", () => {
    container.classList.remove("modal-backdrop--open");
  });
  modal.querySelector("#settings-cancel").addEventListener("click", () => {
    container.classList.remove("modal-backdrop--open");
  });

  // Save
  modal.querySelector("#settings-save").addEventListener("click", () => {
    const updated = {
      model: val("s-model"),
      variant: val("s-variant"),
      language: val("s-language"),
      task: val("s-task"),
      device: val("s-device"),
      quantization: val("s-quantization"),
      beamWidth: intVal("s-beamWidth"),
      temperature: floatVal("s-temperature"),
      initialPrompt: val("s-initialPrompt"),
      chunkInterval: intVal("s-chunkInterval"),
      overlapDuration: intVal("s-overlapDuration"),
      recordingMode: settings.recordingMode, // preserved from app state
      speakerModel: val("s-speakerModel"),
      speakerQuantization: val("s-speakerQuantization"),
      speakerThreshold: floatVal("s-speakerThreshold"),
      speakerAggregation: val("s-speakerAggregation"),
      speakerMaxChunkSeconds: intVal("s-speakerMaxChunkSeconds"),
    };
    saveSettings(updated);
    container.classList.remove("modal-backdrop--open");
    onSave(updated);
  });
}

// ── Helpers for building form fields ──────────────────

function section(title) {
  const el = document.createElement("div");
  el.className = "modal__section";
  const h = document.createElement("div");
  h.className = "modal__section-title";
  h.textContent = title;
  el.appendChild(h);
  return el;
}

function selectField(label, id, value, options) {
  const field = document.createElement("div");
  field.className = "field";
  const lbl = document.createElement("label");
  lbl.className = "field__label";
  lbl.textContent = label;
  lbl.setAttribute("for", id);
  field.appendChild(lbl);
  const sel = document.createElement("select");
  sel.className = "field__select";
  sel.id = id;
  for (const [val, text] of options) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = text;
    if (val === value) opt.selected = true;
    sel.appendChild(opt);
  }
  field.appendChild(sel);
  return field;
}

function numberField(label, id, value, min, max, step) {
  const field = document.createElement("div");
  field.className = "field";
  const lbl = document.createElement("label");
  lbl.className = "field__label";
  lbl.textContent = label;
  lbl.setAttribute("for", id);
  field.appendChild(lbl);
  const inp = document.createElement("input");
  inp.className = "field__input";
  inp.type = "number";
  inp.id = id;
  inp.value = value;
  inp.min = min;
  inp.max = max;
  inp.step = step;
  field.appendChild(inp);
  return field;
}

function textareaField(label, id, value, placeholder) {
  const field = document.createElement("div");
  field.className = "field";
  const lbl = document.createElement("label");
  lbl.className = "field__label";
  lbl.textContent = label;
  lbl.setAttribute("for", id);
  field.appendChild(lbl);
  const ta = document.createElement("textarea");
  ta.className = "field__textarea";
  ta.id = id;
  ta.value = value;
  ta.placeholder = placeholder;
  field.appendChild(ta);
  return field;
}

function rangeField(label, id, value, min, max, step) {
  const field = document.createElement("div");
  field.className = "field";
  const lbl = document.createElement("label");
  lbl.className = "field__label";
  lbl.setAttribute("for", id);
  lbl.textContent = `${label}: ${value}`;
  field.appendChild(lbl);
  const inp = document.createElement("input");
  inp.className = "field__input";
  inp.type = "range";
  inp.id = id;
  inp.value = value;
  inp.min = min;
  inp.max = max;
  inp.step = step;
  inp.addEventListener("input", () => {
    lbl.textContent = `${label}: ${inp.value}`;
  });
  field.appendChild(inp);
  return field;
}

function val(id) {
  return document.getElementById(id)?.value ?? "";
}
function intVal(id) {
  return parseInt(val(id), 10) || 0;
}
function floatVal(id) {
  return parseFloat(val(id)) || 0;
}

// ── Transcript helpers ────────────────────────────────

export function copyTranscript(text) {
  return navigator.clipboard.writeText(text);
}

export function downloadTranscript(text, filename = "transcript.txt") {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Transcript library storage ────────────────────────

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadLibraryIndex() {
  try {
    const raw = localStorage.getItem(LIBRARY_INDEX_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return [];
}

function saveLibraryIndex(index) {
  localStorage.setItem(LIBRARY_INDEX_KEY, JSON.stringify(index));
}

/**
 * Save the current transcript sentences to the library.
 * Returns the generated transcript ID.
 */
export function saveTranscriptToLibrary(sentences, title) {
  const id = generateId();
  const createdAt = Date.now();

  // Auto-generate title from first sentence if not provided
  if (!title) {
    const firstText = sentences[0]?.text || "Untitled";
    title =
      firstText.length > 50 ? firstText.slice(0, 50) + "..." : firstText;
  }

  const transcript = { id, title, createdAt, sentences };
  localStorage.setItem(LIBRARY_PREFIX + id, JSON.stringify(transcript));

  const index = loadLibraryIndex();
  index.unshift({ id, title, createdAt, sentenceCount: sentences.length });
  saveLibraryIndex(index);

  return id;
}

/**
 * Load the library index (metadata only).
 */
export function loadTranscriptLibrary() {
  return loadLibraryIndex();
}

/**
 * Load a full transcript by ID.
 */
export function loadTranscriptById(id) {
  try {
    const raw = localStorage.getItem(LIBRARY_PREFIX + id);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return null;
}

/**
 * Delete one or more transcripts from the library.
 */
export function deleteTranscriptsFromLibrary(ids) {
  const idSet = new Set(ids);
  for (const id of idSet) {
    localStorage.removeItem(LIBRARY_PREFIX + id);
  }
  const index = loadLibraryIndex().filter((entry) => !idSet.has(entry.id));
  saveLibraryIndex(index);
}

// ── Library modal builder ─────────────────────────────

/**
 * Build and display the transcript library modal.
 *
 * @param {HTMLElement} container   – the modal backdrop element
 * @param {Function}    onOpen     – called with a full transcript object when user opens one
 * @param {Function}    onSelect   – called with an array of full transcript objects for batch processing
 */
export function buildLibraryModal(container, onOpen, onSelect) {
  container.innerHTML = "";

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.addEventListener("click", (e) => e.stopPropagation());

  // Header
  const header = document.createElement("div");
  header.className = "modal__header";
  header.innerHTML = `
    <span class="modal__title">Transcript Library</span>
    <button class="modal__close" aria-label="Close">&times;</button>
  `;
  modal.appendChild(header);

  // Body – transcript list
  const body = document.createElement("div");
  body.className = "library__body";

  const entries = loadLibraryIndex();

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "library__empty";
    empty.textContent = "No saved transcripts yet.";
    body.appendChild(empty);
  } else {
    const list = document.createElement("div");
    list.className = "library__list";

    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "library__item";
      row.dataset.id = entry.id;

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "library__checkbox";
      cb.dataset.id = entry.id;

      const info = document.createElement("div");
      info.className = "library__info";

      const titleEl = document.createElement("div");
      titleEl.className = "library__title";
      titleEl.textContent = entry.title;

      const meta = document.createElement("div");
      meta.className = "library__meta";
      const date = new Date(entry.createdAt);
      meta.textContent = `${date.toLocaleDateString()} ${date.toLocaleTimeString()} \u2022 ${entry.sentenceCount} sentence${entry.sentenceCount !== 1 ? "s" : ""}`;

      info.appendChild(titleEl);
      info.appendChild(meta);

      const openBtn = document.createElement("button");
      openBtn.className = "btn btn--small";
      openBtn.textContent = "Open";
      openBtn.addEventListener("click", () => {
        const transcript = loadTranscriptById(entry.id);
        if (transcript) {
          container.classList.remove("modal-backdrop--open");
          onOpen(transcript);
        }
      });

      row.appendChild(cb);
      row.appendChild(info);
      row.appendChild(openBtn);
      list.appendChild(row);
    }

    body.appendChild(list);
  }

  modal.appendChild(body);

  // Footer with batch actions
  const footer = document.createElement("div");
  footer.className = "modal__footer";

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn btn--danger-outline btn--small";
  deleteBtn.textContent = "Delete Selected";
  deleteBtn.addEventListener("click", () => {
    const checked = modal.querySelectorAll(
      ".library__checkbox:checked",
    );
    const ids = Array.from(checked).map((cb) => cb.dataset.id);
    if (ids.length === 0) return;
    deleteTranscriptsFromLibrary(ids);
    // Rebuild the modal to reflect changes
    buildLibraryModal(container, onOpen, onSelect);
  });

  const selectBtn = document.createElement("button");
  selectBtn.className = "btn btn--primary btn--small";
  selectBtn.textContent = "Process Selected";
  selectBtn.addEventListener("click", () => {
    const checked = modal.querySelectorAll(
      ".library__checkbox:checked",
    );
    const ids = Array.from(checked).map((cb) => cb.dataset.id);
    if (ids.length === 0) return;
    const transcripts = ids
      .map((id) => loadTranscriptById(id))
      .filter(Boolean);
    container.classList.remove("modal-backdrop--open");
    onSelect(transcripts);
  });

  const closeBtn = document.createElement("button");
  closeBtn.className = "btn btn--small";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => {
    container.classList.remove("modal-backdrop--open");
  });

  footer.appendChild(deleteBtn);
  footer.appendChild(selectBtn);
  footer.appendChild(closeBtn);
  modal.appendChild(footer);

  container.appendChild(modal);

  // Close on X
  header.querySelector(".modal__close").addEventListener("click", () => {
    container.classList.remove("modal-backdrop--open");
  });
}

// ── Speaker names storage ─────────────────────────────

const SPEAKER_COLORS = [
  { id: "1", color: "#4a6fa5", label: "Speaker 1" },
  { id: "2", color: "#27ae60", label: "Speaker 2" },
  { id: "3", color: "#e67e22", label: "Speaker 3" },
  { id: "4", color: "#8e44ad", label: "Speaker 4" },
  { id: "5", color: "#c0392b", label: "Speaker 5" },
  { id: "6", color: "#16a085", label: "Speaker 6" },
];

export { SPEAKER_COLORS };

export function loadSpeakerNames() {
  try {
    const raw = localStorage.getItem(SPEAKER_NAMES_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return {};
}

export function saveSpeakerNames(names) {
  localStorage.setItem(SPEAKER_NAMES_KEY, JSON.stringify(names));
}

/**
 * Get the display label for a speaker.
 * Returns the name if set, otherwise "Speaker N".
 */
export function speakerDisplayName(speakerId, names) {
  if (!speakerId || speakerId === "0") return null;
  const n = names || loadSpeakerNames();
  return n[speakerId] || `Speaker ${speakerId}`;
}

// ── Speaker names modal ──────────────────────────────

/**
 * Build and display the speaker names mapping modal.
 *
 * @param {HTMLElement} container – the modal backdrop element
 * @param {Function}    onSave   – called with the updated names object
 */
export function buildSpeakerNamesModal(container, onSave) {
  container.innerHTML = "";

  const names = loadSpeakerNames();

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.addEventListener("click", (e) => e.stopPropagation());

  // Header
  const header = document.createElement("div");
  header.className = "modal__header";
  header.innerHTML = `
    <span class="modal__title">Speaker Names</span>
    <button class="modal__close" aria-label="Close">&times;</button>
  `;
  modal.appendChild(header);

  // Body
  const body = document.createElement("div");
  body.className = "modal__section";

  for (const speaker of SPEAKER_COLORS) {
    const row = document.createElement("div");
    row.className = "speaker-name-row";

    const badge = document.createElement("span");
    badge.className = "speaker-badge";
    badge.style.background = speaker.color;
    badge.textContent = speaker.id;

    const input = document.createElement("input");
    input.className = "field__input";
    input.type = "text";
    input.id = `speaker-name-${speaker.id}`;
    input.value = names[speaker.id] || "";
    input.placeholder = speaker.label;

    row.appendChild(badge);
    row.appendChild(input);
    body.appendChild(row);
  }

  modal.appendChild(body);

  // Footer
  const footer = document.createElement("div");
  footer.className = "modal__footer";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn--small";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    container.classList.remove("modal-backdrop--open");
  });

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn--primary btn--small";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => {
    const updated = {};
    for (const speaker of SPEAKER_COLORS) {
      const input = modal.querySelector(`#speaker-name-${speaker.id}`);
      const val = input?.value?.trim();
      if (val) updated[speaker.id] = val;
    }
    saveSpeakerNames(updated);
    container.classList.remove("modal-backdrop--open");
    if (onSave) onSave(updated);
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);
  modal.appendChild(footer);

  container.appendChild(modal);

  // Close on X
  header.querySelector(".modal__close").addEventListener("click", () => {
    container.classList.remove("modal-backdrop--open");
  });
}
