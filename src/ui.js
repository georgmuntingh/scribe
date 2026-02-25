/**
 * UI module — settings modal, theme toggle, transcript display helpers.
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
};

// ── Settings persistence ──────────────────────────────

const STORAGE_KEY = "scribe_settings";
const THEME_KEY = "scribe_theme";

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
