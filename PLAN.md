# Scribe - Browser-Based Whisper Transcription App

## Design Decisions Summary

| Decision | Choice |
|---|---|
| Library | Transformers.js v4 preview (`@huggingface/transformers@next`) |
| Audio input | Both microphone + file upload |
| Transcription modes | Both real-time chunked + record-then-transcribe |
| UI theme | Auto light/dark (system preference + manual toggle) |
| Models | whisper-tiny, whisper-base, whisper-small, whisper-medium |
| Language variants | Both English-only (.en) and multilingual |
| Settings exposed | Model, language, generation params, initial prompt, backend/quantization |
| Chunk interval | User-configurable (5-30s, default 10s) |
| Deployment | Vite build → dist/ → GitHub Pages |
| Transcript features | Copy to clipboard, download as file, auto-scroll |
| Inference | Web Worker (keeps UI responsive) |
| Model loading UX | Progress bar with percentage |

---

## Architecture

```
scribe/
├── index.html              # Main HTML shell
├── vite.config.js          # Vite config (base path for GH Pages)
├── package.json            # Dependencies
├── src/
│   ├── main.js             # Entry: wires up UI, recorder, worker comms
│   ├── worker.js           # Web Worker: loads model, runs inference
│   ├── recorder.js         # Mic recording, chunked streaming, file decode
│   ├── ui.js               # Settings modal, theme toggle, transcript UI
│   └── style.css           # Light/dark theme styles
```

### Component Responsibilities

**`index.html`** - Minimal shell with:
- "Scribe" header (Cinzel font)
- Main content area (record controls, transcript)
- Settings modal (hidden by default)
- Theme toggle button

**`src/main.js`** - Application controller:
- Initializes UI, recorder, and worker
- Routes messages between recorder → worker → transcript display
- Manages app state (idle, loading model, recording, transcribing)

**`src/worker.js`** - Web Worker for inference:
- Imports `@huggingface/transformers` (v4 next)
- Loads/caches the selected Whisper model with progress callbacks
- Runs `pipeline("automatic-speech-recognition", ...)` with user settings
- Posts transcription results and progress back to main thread
- Handles model switching when settings change

**`src/recorder.js`** - Audio handling:
- `MediaRecorder` API for microphone capture
- Real-time chunked mode: buffers audio, sends chunks every N seconds
- Record-then-transcribe mode: records full clip, sends on stop
- File upload: reads audio file, decodes to Float32Array at 16kHz
- Uses `AudioContext` for resampling to 16kHz mono (Whisper requirement)

**`src/ui.js`** - UI components:
- Settings modal with all configuration options
- Theme toggle (light/dark/auto)
- Transcript display with auto-scroll
- Copy-to-clipboard and download buttons
- Progress bar for model loading
- State-dependent button labels/icons

**`src/style.css`** - Theming:
- CSS custom properties for light/dark themes
- `prefers-color-scheme` media query for auto mode
- `[data-theme="light"]` / `[data-theme="dark"]` overrides for manual toggle
- Responsive layout

---

## Worker Communication Protocol

Messages from main → worker:
```js
{ type: "load",       model, language, device, dtype }     // Load/switch model
{ type: "transcribe", audio, options }                      // Run transcription
{ type: "cancel" }                                          // Cancel current job
```

Messages from worker → main:
```js
{ type: "loading",    progress, file, loaded, total }       // Model download progress
{ type: "ready" }                                           // Model loaded & ready
{ type: "result",     text, chunks }                        // Transcription result
{ type: "error",      message }                             // Error
```

---

## Settings Modal Layout

### Model Settings
- **Model size**: Dropdown — tiny, base, small, medium
- **Variant**: Toggle — English-only (.en) / Multilingual
- **Language**: Dropdown (visible when multilingual selected) — auto-detect + list of 99 languages

### Backend Settings
- **Device**: Dropdown — WebGPU (GPU) / WASM (CPU)
- **Quantization**: Dropdown — fp32, fp16, q8, q4
  - Note: shows recommendation per device (fp32 for WebGPU, q8 for WASM)

### Generation Parameters
- **Beam width**: Number input (1-10, default 1)
- **Temperature**: Number input (0.0-1.0, default 0)
- **Initial prompt**: Textarea for biasing output style/vocabulary

### Recording Settings
- **Chunk interval**: Slider (5-30 seconds, default 10s)
- **Mode**: Toggle — Real-time / Manual

---

## UI Layout

```
┌─────────────────────────────────────────────┐
│  ☀/🌙  ────────── Scribe ──────────── ⚙️   │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │                                      │   │
│  │         Transcript Area              │   │
│  │         (auto-scrolling)             │   │
│  │                                      │   │
│  │                                      │   │
│  └──────────────────────────────────────┘   │
│  [ 📋 Copy ]  [ ⬇ Download ]               │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │  Drop audio file here or click       │   │
│  └──────────────────────────────────────┘   │
│                                              │
│          [ 🎤 Record / ⏹ Stop ]             │
│          Mode: Real-time | Manual            │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │  ████████████░░░░░  67% Loading...   │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

---

## Implementation Steps

### Step 1: Project Setup
- Configure `vite.config.js` with base path for GitHub Pages
- Add `@huggingface/transformers@next` dependency
- Set up file structure

### Step 2: Web Worker (`src/worker.js`)
- Import transformers.js pipeline
- Implement `load` handler: create pipeline with model/device/dtype, report progress
- Implement `transcribe` handler: run pipeline on audio data, return text
- Handle errors gracefully

### Step 3: Audio Recorder (`src/recorder.js`)
- Implement `startRecording()` / `stopRecording()` with MediaRecorder
- Implement chunked mode: use `MediaRecorder.ondataavailable` with timeslice
- Implement file upload: decode file to 16kHz mono Float32Array via AudioContext
- Export clean API: `onChunk(callback)`, `onComplete(callback)`

### Step 4: Core Styles (`src/style.css`)
- Define CSS custom properties for both themes
- Style all components (transcript area, buttons, modal, progress bar)
- Responsive design
- `prefers-color-scheme` auto-detection

### Step 5: UI Components (`src/ui.js`)
- Build settings modal dynamically
- Theme toggle logic (auto/light/dark with localStorage persistence)
- Transcript display with auto-scroll
- Copy-to-clipboard and download-as-file buttons
- Progress bar component
- File drop zone

### Step 6: Application Controller (`src/main.js`)
- Wire recorder → worker → transcript flow
- Handle state machine: idle → loading → ready → recording → transcribing
- Persist settings to localStorage
- Initialize everything on page load

### Step 7: HTML Shell (`index.html`)
- Minimal markup referencing Vite entry point
- Cinzel font for header
- Meta tags, favicon

### Step 8: Testing & Polish
- Test WebGPU and WASM backends
- Test real-time and manual modes
- Test file upload with various formats
- Test theme switching
- Test model switching
- Verify GitHub Pages deployment works
