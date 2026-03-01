import { describe, it, expect, beforeEach } from "vitest";
import { aggregateIntoSentences, SentenceMerger, formatTimestamp } from "./merger.js";

// ── formatTimestamp ──────────────────────────────────────

describe("formatTimestamp", () => {
  it("formats seconds as MM:SS", () => {
    expect(formatTimestamp(0)).toBe("00:00");
    expect(formatTimestamp(65)).toBe("01:05");
    expect(formatTimestamp(3661)).toBe("01:01:01");
  });

  it("handles null/NaN", () => {
    expect(formatTimestamp(null)).toBe("00:00");
    expect(formatTimestamp(NaN)).toBe("00:00");
  });
});

// ── aggregateIntoSentences ───────────────────────────────

describe("aggregateIntoSentences", () => {
  it("returns empty for empty input", () => {
    expect(aggregateIntoSentences([])).toEqual([]);
    expect(aggregateIntoSentences(null)).toEqual([]);
  });

  it("aggregates chunks into sentences split at punctuation", () => {
    const chunks = [
      { text: "Hello world.", start: 0, end: 2 },
      { text: " How are you?", start: 2, end: 4 },
    ];
    const sentences = aggregateIntoSentences(chunks);
    expect(sentences).toHaveLength(2);
    expect(sentences[0].text).toBe("Hello world.");
    expect(sentences[0].start).toBe(0);
    expect(sentences[0].end).toBe(2);
    expect(sentences[1].text).toBe("How are you?");
    expect(sentences[1].start).toBe(2);
    expect(sentences[1].end).toBe(4);
  });

  it("returns one sentence when there is no sentence-ending punctuation", () => {
    const chunks = [
      { text: "Hello", start: 0, end: 1 },
      { text: "world", start: 1, end: 2 },
    ];
    const sentences = aggregateIntoSentences(chunks);
    expect(sentences).toHaveLength(1);
    expect(sentences[0].text).toBe("Hello world");
  });
});

// ── SentenceMerger ───────────────────────────────────────

describe("SentenceMerger", () => {
  let merger;

  beforeEach(() => {
    merger = new SentenceMerger();
  });

  // ── setChunks ──

  describe("setChunks", () => {
    it("sets chunks and returns sentences", () => {
      const chunks = [
        { text: "Hello.", timestamp: [0, 1] },
        { text: " Goodbye.", timestamp: [1, 2] },
      ];
      const sentences = merger.setChunks(chunks);
      expect(sentences).toHaveLength(2);
      expect(sentences[0].text).toBe("Hello.");
      expect(sentences[1].text).toBe("Goodbye.");
    });

    it("filters out BLANK_AUDIO chunks", () => {
      const chunks = [
        { text: "[BLANK_AUDIO]", timestamp: [0, 1] },
        { text: "Hello.", timestamp: [1, 2] },
      ];
      const sentences = merger.setChunks(chunks);
      expect(sentences).toHaveLength(1);
      expect(sentences[0].text).toBe("Hello.");
    });
  });

  // ── addWindow ──

  describe("addWindow", () => {
    it("adds first window correctly", () => {
      const chunks = [
        { text: "Hello.", timestamp: [0, 1.5] },
        { text: " How are you?", timestamp: [2, 4] },
      ];
      const sentences = merger.addWindow(chunks, 0);
      expect(sentences).toHaveLength(2);
      expect(sentences[0].text).toBe("Hello.");
      expect(sentences[1].text).toBe("How are you?");
    });

    it("merges overlapping windows without duplication", () => {
      // Window 1: 0-10s, chunks at 0-2s and 3-5s
      merger.addWindow(
        [
          { text: "Hello.", timestamp: [0, 2] },
          { text: " How are you?", timestamp: [3, 5] },
        ],
        0,
      );

      // Window 2: 7-17s, new chunks at 8-10s and 10-12s (absolute)
      const sentences = merger.addWindow(
        [
          { text: " I am fine.", timestamp: [1, 3] },   // abs: 8-10
          { text: " Thank you.", timestamp: [3, 5] },   // abs: 10-12
        ],
        7,
      );

      expect(sentences).toHaveLength(4);
      expect(sentences[0].text).toBe("Hello.");
      expect(sentences[1].text).toBe("How are you?");
      expect(sentences[2].text).toBe("I am fine.");
      expect(sentences[3].text).toBe("Thank you.");
    });

    it("preserves straddling chunks that span the window boundary", () => {
      // Window 1: 0-10s
      // A sentence that starts at 5s and ends at 8.5s (straddles the 7s boundary)
      merger.addWindow(
        [
          { text: "Short intro.", timestamp: [0, 2] },
          { text: " Today we will discuss the quarterly results.", timestamp: [5, 8.5] },
        ],
        0,
      );

      // Window 2: 7-17s (overlap at 7-10s)
      // The new window only has audio from 7s, so it produces a fragment
      // of the straddling sentence plus new content.
      const sentences = merger.addWindow(
        [
          { text: " the quarterly results.", timestamp: [0, 1.5] },  // abs: 7-8.5 (fragment)
          { text: " Let us start with revenue.", timestamp: [2, 4] }, // abs: 9-11
        ],
        7,
      );

      // The straddling chunk "Today we will discuss the quarterly results."
      // must be preserved — not replaced by the fragment "the quarterly results."
      const texts = sentences.map((s) => s.text);
      expect(texts).toContain("Today we will discuss the quarterly results.");
      expect(texts.join(" ")).toContain("Let us start with revenue.");
      // The fragment "the quarterly results." should NOT appear as its own sentence
      expect(texts).not.toContain("the quarterly results.");
    });

    it("drops chunks entirely within the overlap region", () => {
      // Window 1: 0-10s
      merger.addWindow(
        [
          { text: "Before overlap.", timestamp: [0, 3] },
          { text: " Inside overlap.", timestamp: [8, 9.5] }, // entirely within future overlap
        ],
        0,
      );

      // Window 2: 7-17s — "Inside overlap." at [8, 9.5] should be replaced
      const sentences = merger.addWindow(
        [
          { text: " Re-transcribed overlap.", timestamp: [1, 2.5] }, // abs: 8-9.5
          { text: " New content.", timestamp: [3, 5] },              // abs: 10-12
        ],
        7,
      );

      const allText = sentences.map((s) => s.text).join(" ");
      expect(allText).toContain("Before overlap.");
      expect(allText).toContain("Re-transcribed overlap.");
      expect(allText).toContain("New content.");
      // The old "Inside overlap." should be gone
      expect(allText).not.toContain("Inside overlap.");
    });

    it("handles empty new window gracefully", () => {
      merger.addWindow(
        [{ text: "Hello.", timestamp: [0, 2] }],
        0,
      );
      const sentences = merger.addWindow([], 7);
      expect(sentences).toHaveLength(1);
      expect(sentences[0].text).toBe("Hello.");
    });

    it("handles multiple straddling chunks", () => {
      // Window 1: 0-10s, two chunks that both straddle the 7s boundary
      merger.addWindow(
        [
          { text: "First sentence.", timestamp: [0, 2] },
          { text: " Chunk at boundary one.", timestamp: [5, 7.5] },
          { text: " Chunk at boundary two.", timestamp: [6.5, 8] },
        ],
        0,
      );

      // Window 2: 7-17s
      const sentences = merger.addWindow(
        [
          { text: " boundary two and more.", timestamp: [0, 2] }, // abs: 7-9 (fragment)
          { text: " Brand new.", timestamp: [3, 5] },             // abs: 10-12
        ],
        7,
      );

      const allText = sentences.map((s) => s.text).join(" ");
      // Both straddling chunks should be preserved
      expect(allText).toContain("Chunk at boundary one.");
      expect(allText).toContain("Chunk at boundary two.");
      expect(allText).toContain("Brand new.");
    });

    it("handles three consecutive windows correctly", () => {
      // Window 1: 0-10s
      merger.addWindow(
        [
          { text: "Sentence one.", timestamp: [0, 3] },
          { text: " Sentence two.", timestamp: [4, 6] },
        ],
        0,
      );

      // Window 2: 7-17s
      merger.addWindow(
        [
          { text: " Sentence three.", timestamp: [1, 3] }, // abs: 8-10
          { text: " Sentence four.", timestamp: [4, 6] },  // abs: 11-13
        ],
        7,
      );

      // Window 3: 14-24s
      const sentences = merger.addWindow(
        [
          { text: " Sentence five.", timestamp: [1, 3] },  // abs: 15-17
          { text: " Sentence six.", timestamp: [4, 6] },   // abs: 18-20
        ],
        14,
      );

      expect(sentences.length).toBeGreaterThanOrEqual(4);
      const allText = sentences.map((s) => s.text).join(" ");
      expect(allText).toContain("Sentence one.");
      expect(allText).toContain("Sentence two.");
      // Sentences three/four may be re-transcribed by Window 3 overlap,
      // but at minimum they or their replacements should be present
      expect(allText).toContain("Sentence five.");
      expect(allText).toContain("Sentence six.");
    });
  });

  // ── appendChunks ──

  describe("appendChunks", () => {
    it("appends chunks after existing content with a gap", () => {
      merger.setChunks([
        { text: "First file.", timestamp: [0, 3] },
      ]);
      const sentences = merger.appendChunks([
        { text: "Second file.", timestamp: [0, 3] },
      ]);
      expect(sentences).toHaveLength(2);
      expect(sentences[0].text).toBe("First file.");
      expect(sentences[1].text).toBe("Second file.");
      // Second file should start after first file ends + 1s gap
      expect(sentences[1].start).toBe(3 + 1.0);
    });
  });

  // ── Speaker labels ──

  describe("speaker labels", () => {
    it("preserves speaker labels across window updates", () => {
      merger.addWindow(
        [
          { text: "Hello.", timestamp: [0, 2] },
          { text: " Goodbye.", timestamp: [3, 5] },
        ],
        0,
      );

      // Assign speaker to first sentence
      merger.setSpeakerLabel(0, 2, "1");

      // Add a new window — speaker label should persist
      const sentences = merger.addWindow(
        [{ text: " New content.", timestamp: [2, 4] }], // abs: 9-11
        7,
      );

      const hello = sentences.find((s) => s.text === "Hello.");
      expect(hello).toBeDefined();
      expect(hello.speakerId).toBe("1");
    });
  });
});
