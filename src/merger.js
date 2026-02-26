/**
 * Timestamp-based transcript merger and sentence aggregator.
 *
 * For real-time mode: merges overlapping audio windows using timestamps
 * so that the overlap region is not duplicated.
 *
 * For file / manual mode: aggregates Whisper chunks into sentences.
 *
 * Each sentence carries a start/end time and a placeholder for a future
 * speaker ID, making the data model ready for speaker-diarisation colouring.
 */

// ── Helpers ──────────────────────────────────────────

/**
 * Format a time in seconds as MM:SS or H:MM:SS.
 */
export function formatTimestamp(seconds) {
  if (seconds == null || isNaN(seconds)) return "00:00";
  const totalSec = Math.round(seconds);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/**
 * Split a block of text into sentences at sentence-ending punctuation
 * (period, exclamation mark, question mark) followed by whitespace.
 * Returns an array of non-empty sentence strings.
 */
function splitTextAtSentenceBoundaries(text) {
  // Split after sentence-ending punctuation that is followed by whitespace
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.map((s) => s.trim()).filter(Boolean);
}

// ── Sentence aggregation ─────────────────────────────

/**
 * Aggregate an ordered array of chunks into sentences.
 *
 * @param {Array<{text: string, start: number, end: number}>} chunks
 * @returns {Array<{text: string, start: number, end: number, speakerId: string|null}>}
 */
export function aggregateIntoSentences(chunks) {
  if (!chunks || chunks.length === 0) return [];

  // Build a single text string and record which chunk each character belongs to.
  let fullText = "";
  const charToChunk = []; // index into `chunks` for each char position

  for (let i = 0; i < chunks.length; i++) {
    const t = chunks[i].text;
    if (
      fullText.length > 0 &&
      !fullText.endsWith(" ") &&
      !t.startsWith(" ")
    ) {
      fullText += " ";
      charToChunk.push(i);
    }
    for (let j = 0; j < t.length; j++) {
      charToChunk.push(i);
    }
    fullText += t;
  }

  const trimmed = fullText.trim();
  if (!trimmed) return [];

  const sentenceTexts = splitTextAtSentenceBoundaries(trimmed);
  if (sentenceTexts.length === 0) {
    return [
      {
        text: trimmed,
        start: chunks[0].start,
        end: chunks[chunks.length - 1].end,
        speakerId: null,
      },
    ];
  }

  const sentences = [];
  let searchFrom = 0;

  for (const sentText of sentenceTexts) {
    if (!sentText) continue;

    const idx = fullText.indexOf(sentText, searchFrom);
    if (idx === -1) continue;

    const endIdx = idx + sentText.length - 1;
    searchFrom = idx + sentText.length;

    const startChunkIdx = charToChunk[idx] ?? 0;
    const endChunkIdx = charToChunk[endIdx] ?? chunks.length - 1;

    sentences.push({
      text: sentText,
      start: chunks[startChunkIdx].start,
      end: chunks[endChunkIdx].end,
      speakerId: null,
    });
  }

  // Fallback: if sentence splitting produced nothing, use the whole text
  if (sentences.length === 0 && trimmed) {
    sentences.push({
      text: trimmed,
      start: chunks[0].start,
      end: chunks[chunks.length - 1].end,
      speakerId: null,
    });
  }

  return sentences;
}

// ── SentenceMerger ───────────────────────────────────

/**
 * Accumulates Whisper chunks across overlapping audio windows and
 * produces an array of sentences with absolute timestamps.
 *
 * Usage (real-time mode):
 *   const merger = new SentenceMerger();
 *   recorder.onChunk = (audio, windowOffset) => { ... };
 *   // After each worker result:
 *   const sentences = merger.addWindow(whisperChunks, windowOffset);
 *
 * Usage (file / manual mode):
 *   const sentences = merger.setChunks(whisperChunks);
 */
export class SentenceMerger {
  constructor() {
    /** @type {Array<{text: string, start: number, end: number}>} */
    this._chunks = [];
  }

  /**
   * Add chunks from a real-time audio window.
   *
   * @param {Array} whisperChunks – raw Whisper chunks [{text, timestamp: [start, end]}]
   * @param {number} windowOffset – absolute start time of the audio window (seconds)
   * @returns {Array} Current sentence list.
   */
  addWindow(whisperChunks, windowOffset) {
    if (!whisperChunks || whisperChunks.length === 0) return this.sentences();

    const absChunks = [];
    for (const c of whisperChunks) {
      const text = (c.text || "").replace(/\[BLANK_AUDIO\]/gi, "").trim();
      if (!text) continue;
      const start = windowOffset + (c.timestamp?.[0] ?? 0);
      const end = windowOffset + (c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0);
      absChunks.push({ text, start, end });
    }

    if (absChunks.length === 0) return this.sentences();

    // Remove existing chunks that end after the new window's start.
    // These fall in the overlap region and are re-transcribed by the new window.
    this._chunks = this._chunks.filter((c) => c.end <= windowOffset);

    this._chunks.push(...absChunks);
    this._chunks.sort((a, b) => a.start - b.start);

    return this.sentences();
  }

  /**
   * Set chunks directly (file upload or manual recording).
   * Replaces any existing chunks.
   *
   * @param {Array} whisperChunks – raw Whisper chunks
   * @returns {Array} Sentence list.
   */
  setChunks(whisperChunks) {
    this._chunks = [];
    for (const c of whisperChunks) {
      const text = (c.text || "").replace(/\[BLANK_AUDIO\]/gi, "").trim();
      if (!text) continue;
      const start = c.timestamp?.[0] ?? 0;
      const end = c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0;
      this._chunks.push({ text, start, end });
    }
    return this.sentences();
  }

  /**
   * Append chunks (e.g. a second file upload appended to the current transcript).
   * Timestamps are offset so they follow the existing chunks.
   *
   * @param {Array} whisperChunks – raw Whisper chunks
   * @returns {Array} Sentence list.
   */
  appendChunks(whisperChunks) {
    const timeOffset =
      this._chunks.length > 0
        ? this._chunks[this._chunks.length - 1].end + 1.0
        : 0;

    for (const c of whisperChunks) {
      const text = (c.text || "").replace(/\[BLANK_AUDIO\]/gi, "").trim();
      if (!text) continue;
      const start = timeOffset + (c.timestamp?.[0] ?? 0);
      const end = timeOffset + (c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0);
      this._chunks.push({ text, start, end });
    }

    return this.sentences();
  }

  /**
   * Return the current sentences.
   */
  sentences() {
    return aggregateIntoSentences(this._chunks);
  }

  /**
   * Return a copy of the raw chunks (useful for persistence).
   */
  chunks() {
    return this._chunks.map((c) => ({ ...c }));
  }

  /**
   * Reset for a new recording / transcription session.
   */
  reset() {
    this._chunks = [];
  }
}
