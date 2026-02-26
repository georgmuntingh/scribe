/**
 * Timestamp-based transcript merger and sentence aggregator.
 *
 * For real-time mode: merges overlapping audio windows using timestamps
 * so that the overlap region is not duplicated.
 *
 * For file / manual mode: aggregates Whisper chunks into sentences.
 *
 * Each sentence carries a start/end time and a speaker ID.  Speaker labels
 * are preserved across merger rebuilds using timestamp-range matching.
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

  let fullText = "";
  const charToChunk = [];

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
 * Speaker labels are stored independently and re-applied to sentences
 * after each rebuild, using timestamp-range overlap matching.
 */
export class SentenceMerger {
  constructor() {
    /** @type {Array<{text: string, start: number, end: number}>} */
    this._chunks = [];

    /**
     * Preserved speaker labels keyed by time range.
     * @type {Array<{start: number, end: number, speakerId: string}>}
     */
    this._speakerLabels = [];
  }

  /**
   * Record a speaker assignment for a sentence's time range.
   * Called when the user assigns a speaker to one or more sentences.
   *
   * @param {number} start  – sentence start time (seconds)
   * @param {number} end    – sentence end time (seconds)
   * @param {string|null} speakerId – speaker ID ("1"-"6"), "0" for unclassified, or null to remove
   */
  setSpeakerLabel(start, end, speakerId) {
    // Remove any existing label that substantially overlaps this range
    this._speakerLabels = this._speakerLabels.filter((l) => {
      const overlapStart = Math.max(l.start, start);
      const overlapEnd = Math.min(l.end, end);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      const lDuration = l.end - l.start;
      // Remove if >50% of the old label is covered by the new assignment
      return lDuration > 0 && overlap / lDuration < 0.5;
    });
    if (speakerId != null) {
      this._speakerLabels.push({ start, end, speakerId });
    }
  }

  /**
   * Find the best matching speaker label for a given time range.
   * Requires at least 50% overlap with the sentence duration.
   */
  _findBestLabel(start, end) {
    const duration = end - start;
    if (duration <= 0) return null;

    let best = null;
    let bestOverlap = 0;

    for (const label of this._speakerLabels) {
      const overlapStart = Math.max(start, label.start);
      const overlapEnd = Math.min(end, label.end);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      if (overlap > bestOverlap && overlap >= duration * 0.5) {
        best = label;
        bestOverlap = overlap;
      }
    }

    return best;
  }

  /**
   * Build sentences from chunks and apply preserved speaker labels.
   */
  sentences() {
    const sentences = aggregateIntoSentences(this._chunks);
    for (const s of sentences) {
      const match = this._findBestLabel(s.start, s.end);
      if (match) {
        s.speakerId = match.speakerId;
      }
    }
    return sentences;
  }

  /**
   * Add chunks from a real-time audio window.
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

    this._chunks = this._chunks.filter((c) => c.end <= windowOffset);
    this._chunks.push(...absChunks);
    this._chunks.sort((a, b) => a.start - b.start);

    return this.sentences();
  }

  /**
   * Set chunks directly (file upload or manual recording).
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
   * Append chunks (e.g. a second file upload).
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
   * Return a copy of the raw chunks.
   */
  chunks() {
    return this._chunks.map((c) => ({ ...c }));
  }

  /**
   * Reset for a new session.
   */
  reset() {
    this._chunks = [];
    this._speakerLabels = [];
  }
}
