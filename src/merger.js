/**
 * Overlap-aware transcription merger.
 *
 * When using overlapping audio windows for continuous transcription, each
 * consecutive pair of transcriptions shares a region of audio. This module
 * detects the overlapping text and merges the transcriptions so that:
 *   - The shared region is not duplicated.
 *   - Words at the boundary of the previous chunk are corrected by the
 *     next chunk's transcription of the same audio.
 *
 * The algorithm tokenises transcriptions into words and uses a longest
 * common subsequence (LCS) search over the tail of the previous text and
 * the head of the new text. When a sufficiently good match is found the
 * overlap is resolved and the texts are joined seamlessly.
 */

/**
 * Normalise a string for fuzzy matching: lowercase, strip punctuation,
 * collapse whitespace.
 */
function normalise(s) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split text into word tokens (preserving original casing for output).
 */
function tokenise(text) {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Find the best overlap between the tail of `prevWords` and the head of
 * `newWords`. We search for the longest matching subsequence where
 * normalised words agree.
 *
 * Returns { prevEnd, newStart } — the indices at which to cut:
 *   merged = prevWords[0..prevEnd-1] + newWords[newStart..]
 *
 * If no good overlap is found, returns null.
 */
function findOverlap(prevWords, newWords, maxSearchWords) {
  // We only search within the last `maxSearchWords` of prev and the first
  // `maxSearchWords` of new — the overlap region cannot be larger than the
  // audio overlap duration allows.
  const pLen = prevWords.length;
  const nLen = newWords.length;
  const searchP = Math.min(pLen, maxSearchWords);
  const searchN = Math.min(nLen, maxSearchWords);

  if (searchP === 0 || searchN === 0) return null;

  // Build normalised versions for comparison
  const pNorm = prevWords.slice(pLen - searchP).map((w) => normalise(w));
  const nNorm = newWords.slice(0, searchN).map((w) => normalise(w));

  // Try every possible overlap length from longest to shortest.
  // An "overlap of length k" means: the last k words of the prev search
  // region match the first k words of the new search region.
  let bestLen = 0;
  let bestScore = 0;

  for (let k = Math.min(searchP, searchN); k >= 2; k--) {
    // Compare pNorm[searchP-k .. searchP-1] with nNorm[0 .. k-1]
    let matches = 0;
    for (let i = 0; i < k; i++) {
      if (pNorm[searchP - k + i] === nNorm[i]) {
        matches++;
      }
    }
    const score = matches / k;
    // Require at least 60% of words to match, and prefer longer overlaps
    if (score >= 0.6 && (matches > bestScore || (matches === bestScore && k < bestLen))) {
      bestLen = k;
      bestScore = matches;
    }
    // Perfect match of reasonable length — take it immediately
    if (score === 1.0 && k >= 2) {
      bestLen = k;
      break;
    }
  }

  if (bestLen < 2) return null;

  return {
    prevEnd: pLen - bestLen,
    newStart: bestLen,
  };
}

/**
 * TranscriptMerger accumulates transcription results and merges overlapping
 * regions.
 *
 * Usage:
 *   const merger = new TranscriptMerger();
 *   // For each chunk result:
 *   const fullText = merger.add(chunkText);
 */
export class TranscriptMerger {
  constructor(options = {}) {
    // Maximum number of words to search for overlap. This should
    // correspond roughly to the number of words spoken during the overlap
    // duration. At ~150 WPM and 3s overlap ≈ 7-8 words; we use a generous
    // bound to account for faster speech and transcription variance.
    this.maxSearchWords = options.maxSearchWords || 30;

    // The accumulated merged transcript as word tokens.
    this._words = [];
  }

  /**
   * Add a new chunk transcription and return the full merged transcript.
   */
  add(text) {
    if (!text || !text.trim()) return this.text();

    const newWords = tokenise(text.trim());
    if (newWords.length === 0) return this.text();

    if (this._words.length === 0) {
      this._words = newWords;
      return this.text();
    }

    const overlap = findOverlap(
      this._words,
      newWords,
      this.maxSearchWords,
    );

    if (overlap) {
      // Cut the previous text at the overlap point and append the new
      // text from after the overlap. We prefer the new transcription's
      // rendering of the overlap region since it had more context (the
      // overlap was in the middle of its window, not at the edge).
      this._words = [
        ...this._words.slice(0, overlap.prevEnd),
        ...newWords,
      ];
    } else {
      // No detectable overlap — just append (with a space).
      this._words = [...this._words, ...newWords];
    }

    return this.text();
  }

  /**
   * Return the full merged transcript as a string.
   */
  text() {
    return this._words.join(" ");
  }

  /**
   * Reset the merger for a new recording session.
   */
  reset() {
    this._words = [];
  }
}
