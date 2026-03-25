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
      speakerInferred: false,
      },
    ];
  }

  // Build sentences by walking through the split parts and tracking
  // our position in fullText directly, rather than using indexOf which
  // can silently skip sentences when there are duplicate substrings.
  const sentences = [];
  let pos = 0;

  for (const sentText of sentenceTexts) {
    if (!sentText) continue;

    // Advance past any leading whitespace in fullText
    while (pos < fullText.length && fullText[pos] === " ") pos++;

    // sentText must appear at pos (it was split from fullText sequentially)
    const idx = fullText.indexOf(sentText, pos);
    if (idx === -1) {
      // Fallback: use current position and advance by sentText length.
      // This ensures the sentence is never silently dropped.
      const startChunkIdx = charToChunk[pos] ?? 0;
      const fallbackEnd = Math.min(pos + sentText.length - 1, charToChunk.length - 1);
      const endChunkIdx = charToChunk[fallbackEnd] ?? chunks.length - 1;
      sentences.push({
        text: sentText,
        start: chunks[startChunkIdx].start,
        end: chunks[endChunkIdx].end,
        speakerId: null,
        speakerInferred: false,
      });
      pos += sentText.length;
      continue;
    }

    const endIdx = idx + sentText.length - 1;
    pos = idx + sentText.length;

    const startChunkIdx = charToChunk[idx] ?? 0;
    const endChunkIdx = charToChunk[endIdx] ?? chunks.length - 1;

    sentences.push({
      text: sentText,
      start: chunks[startChunkIdx].start,
      end: chunks[endChunkIdx].end,
      speakerId: null,
      speakerInferred: false,
    });
  }

  if (sentences.length === 0 && trimmed) {
    sentences.push({
      text: trimmed,
      start: chunks[0].start,
      end: chunks[chunks.length - 1].end,
      speakerId: null,
      speakerInferred: false,
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
     * Sentences that have been finalized and will not be re-aggregated.
     * Once a sentence's time range is fully before the current overlap
     * window, it is moved here so that later re-aggregation cannot
     * alter or drop it.
     * @type {Array<{text: string, start: number, end: number, speakerId: string|null, speakerInferred: boolean}>}
     */
    this._finalizedSentences = [];

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
  setSpeakerLabel(start, end, speakerId, inferred = false) {
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
      this._speakerLabels.push({ start, end, speakerId, inferred });
    }
    // Also update any finalized sentences that match this time range
    for (const s of this._finalizedSentences) {
      const dur = s.end - s.start;
      if (dur <= 0) continue;
      const oStart = Math.max(s.start, start);
      const oEnd = Math.min(s.end, end);
      const overlap = Math.max(0, oEnd - oStart);
      if (overlap >= dur * 0.5) {
        s.speakerId = speakerId;
        s.speakerInferred = !!inferred;
      }
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
   * Finalized sentences are prepended as-is (already have speaker labels).
   * Only active (non-finalized) chunks are re-aggregated.
   */
  sentences() {
    const active = aggregateIntoSentences(this._chunks);
    for (const s of active) {
      const match = this._findBestLabel(s.start, s.end);
      if (match) {
        s.speakerId = match.speakerId;
        s.speakerInferred = !!match.inferred;
      }
    }
    return [...this._finalizedSentences, ...active];
  }

  /**
   * Add chunks from a real-time audio window.
   *
   * Before discarding overlap-region chunks, sentences that end strictly
   * before the new window's start are finalized so they can never be
   * lost by subsequent re-aggregation.
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

    // ── Finalize sentences that are entirely before the new window ──
    // Aggregate current active chunks into sentences, and move any
    // sentence whose end time is strictly before windowOffset into
    // _finalizedSentences.  These sentences will never be re-aggregated.
    const currentSentences = aggregateIntoSentences(this._chunks);
    for (const s of currentSentences) {
      if (s.end < windowOffset) {
        // Apply speaker label before finalizing
        const match = this._findBestLabel(s.start, s.end);
        if (match) {
          s.speakerId = match.speakerId;
          s.speakerInferred = !!match.inferred;
        }
        this._finalizedSentences.push(s);
      }
    }

    // ── Keep only chunks that overlap or follow the new window ──
    // Use strict < so chunks ending exactly at windowOffset are kept
    // rather than silently discarded (off-by-one fix).
    this._chunks = this._chunks.filter((c) => c.end >= windowOffset);

    // ── Remove old chunks that are now fully covered by new window ──
    // Among the kept chunks, discard those from previous windows whose
    // time range is entirely within the new window's coverage.  The new
    // window's transcription of this region is more accurate because it
    // has more surrounding context.
    if (absChunks.length > 0) {
      const newStart = absChunks[0].start;
      const newEnd = absChunks[absChunks.length - 1].end;
      this._chunks = this._chunks.filter(
        (c) => !(c.start >= newStart && c.end <= newEnd),
      );
    }

    this._chunks.push(...absChunks);
    this._chunks.sort((a, b) => a.start - b.start);

    return this.sentences();
  }

  /**
   * Add chunks from a real-time audio window WITHOUT merging.
   * Each window's sentences are appended as-is, avoiding overlap
   * de-duplication (and the sentence loss it can cause).
   */
  addWindowNoMerge(whisperChunks, windowOffset) {
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

    // Aggregate only the NEW window's chunks into sentences and append them
    // to the existing chunk list without touching previous chunks.
    const newSentences = aggregateIntoSentences(absChunks);
    for (const s of newSentences) {
      // Store each sentence as a single consolidated chunk so previous
      // sentences are never re-aggregated or discarded.
      this._chunks.push({ text: s.text, start: s.start, end: s.end });
    }

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
    this._finalizedSentences = [];
    this._speakerLabels = [];
  }
}
