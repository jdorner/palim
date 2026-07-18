/**
 * Tests for wiki markdown chunking (`chunkMarkdown`).
 */

import { describe, expect, test } from "bun:test";
import type { WikiDocument } from "./index";
import { chunkMarkdown } from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectChunks(actual: WikiDocument[], titleMap: Record<string, string>) {
  /** Assert that `actual` contains exactly one chunk per entry in `titleMap`, with matching content. */
  const byTitle = new Map<string, WikiDocument>();
  for (const c of actual) byTitle.set(c.title, c);

  for (const [title, expectedContent] of Object.entries(titleMap)) {
    expect(byTitle.has(title)).toBe(true);
    expect(byTitle.get(title)!.content).toContain(expectedContent);
    expect(byTitle.get(title)!.sectionDepth).toBeDefined();
  }
}

// ---------------------------------------------------------------------------
// chunkMarkdown
// ---------------------------------------------------------------------------

describe("chunkMarkdown", () => {
  test("splits file at same-level boundaries into separate chunks", () => {
    // ## followed by another ## creates a new chunk (siblings at same depth)
    // # followed by ## does NOT - ## is child of # in markdown hierarchy
    const input = "## Section A\n\nA content.\n\n## Section B\n\nB content.";
    const result = chunkMarkdown("test.md", input);

    expect(result).toHaveLength(2);
    expectChunks(result, {
      "Section A": "A content.",
      "Section B": "B content.",
    });
  });

  test("chunks ### sub-headings into their parent ## chunk", () => {
    // ### is a child of ## (deeper), so it stays absorbed in the ## chunk
    const input = "## Parent\n\nParent text.\n\n### Child 1\n\nChild 1 text.\n\n### Child 2\n\nChild 2 text.";
    const result = chunkMarkdown("test.md", input);

    expect(result).toHaveLength(1);
    // Parent chunk should contain all sub-headings as inline content
    const parentChunk = result[0]!;
    expect(parentChunk.title).toBe("Parent");
    expect(parentChunk.content).toContain("### Child 1");
    expect(parentChunk.content).toContain("Child 2 text.");
  });

  test("starts a new chunk when heading goes to same depth (sibling)", () => {
    // ## followed by ### (deeper) is absorbed
    // ### followed by ## (shallower) starts a NEW chunk
    const input = "## A\n\nA content.\n\n### A-sub\n\nSub content.\n\n## B\n\nB content.";
    const result = chunkMarkdown("test.md", input);

    expect(result).toHaveLength(2);
    // ## A absorbs its ### child, then ## B creates a new sibling chunk
    expectChunks(result, {
      A: "Sub content.",
      B: "B content.",
    });
  });

  test("all sub-headings of deeper levels are absorbed into their ancestor chunk", () => {
    // In markdown hierarchy, ## is a child of # (deeper), ### is child of ##, etc.
    // All get absorbed into the top-level # chunk
    const input = "# Root\n\nRoot.\n\n## L2\n\nL2.\n\n### L3\n\nL3.\n\n#### L4\n\nL4.\n\n##### L5\n\nL5.";
    const result = chunkMarkdown("test.md", input);

    // Everything stays in one chunk since all headings after # are deeper levels
    expect(result).toHaveLength(1);
    expectChunks(result, { Root: "L5." });
  });

  test("absorbs sub-headings of deeper levels into their ancestor chunk", () => {
    const input = "## Level 2\n\nL2 text.\n\n### Level 3\n\nL3 text.";
    const result = chunkMarkdown("test.md", input);

    expect(result).toHaveLength(1);
    // Both sub-headings of a deeper level stay inside the parent ##
    expectChunks(result, {
      "Level 2": "L3 text.",
    });
    expect(result[0]!.sectionDepth).toBe(2);
  });

  test("handles duplicate heading titles within same file", () => {
    // ## is a child of # (deeper), so it gets absorbed into the # chunk's content
    const input = "# Title\n\nFirst.\n\n## Title\n\nSecond section with same title.";
    const result = chunkMarkdown("test.md", input);

    // All content stays in one chunk (parent heading absorbs sub-headings)
    expect(result).toHaveLength(1);
  });

  test("duplicate headings at SAME level create separate chunks", () => {
    const input = "# First Title\n\nA.\n\n# Second Title\n\nB.";
    const result = chunkMarkdown("test.md", input);

    expect(result).toHaveLength(2);
    expectChunks(result, {
      "First Title": "A.",
      "Second Title": "B.",
    });
  });

  test("returns a single chunk for file with only body text (no headings)", () => {
    const input = "Just plain text without any markdown headings.";
    const result = chunkMarkdown("test.md", input);

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("");
    expect(result[0]!.content).toContain("plain text");
  });

  test("handles file with only heading, no body content", () => {
    const input = "# Single heading";
    const result = chunkMarkdown("test.md", input);

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("Single heading");
    // Content includes the heading line itself since there's no body text
    expect(result[0]!.content).toContain("# Single heading");
  });

  test("preserves special characters and unicode in titles", () => {
    const input = "# FAQ: What's the answer? (2024)\n\nAnswer is 42.";
    const result = chunkMarkdown("test.md", input);

    expect(result).toHaveLength(1);
    expectChunks(result, { "FAQ: What's the answer? (2024)": "42" });
  });

  test("handles mixed heading levels as siblings (equal depth)", () => {
    const input = "# First\n\nFirst content.\n\n# Second\n\nSecond content.";
    const result = chunkMarkdown("test.md", input);

    expect(result).toHaveLength(2);
    expectChunks(result, {
      First: "First content.",
      Second: "Second content.",
    });
  });

  test("handles empty string input", () => {
    const result = chunkMarkdown("test.md", "");
    expect(result).toHaveLength(0);
  });

  test("handles input with only blank lines", () => {
    const result = chunkMarkdown("test.md", "\n\n\n");
    expect(result).toHaveLength(0);
  });

  test("trims whitespace from heading titles", () => {
    const input = "#   Title with spaces   \n\nContent.";
    const result = chunkMarkdown("test.md", input);

    expect(result.length).toBeGreaterThanOrEqual(1);
    const titleChunk = result.find((c) => c.content.includes("Content."));
    if (titleChunk) {
      expect(titleChunk.title.trim()).toBe("Title with spaces");
    }
  });

  test("chunks file with multiple sub-headings at same level", () => {
    const input = "## Parent\n\nParent intro.\n\n### Child A\n\nA content.\n\n### Child B\n\nB content.";
    const result = chunkMarkdown("test.md", input);

    expect(result).toHaveLength(1);
    expectChunks(result, {
      Parent: "B content.",
    });
  });

  test("handles file with headings at every supported level", () => {
    // All sub-headings (##, ###) are absorbed into the first # chunk
    const input = "# H1\n\nH1 content.\n\n## H2\n\nH2 content.\n\n### H3\n\nH3 content.";
    const result = chunkMarkdown("test.md", input);

    expect(result).toHaveLength(1);
    expect(result[0]!.title).toBe("H1");
    expect(result[0]!.content).toContain("H3 content.");
  });

  test("handles file with empty heading text (e.g. '## ')", () => {
    const input = "## \n\nSome content after an empty heading.";
    // "## " doesn't match /^(#{1,6})\s+(.+)/ - treated as body text
    const result = chunkMarkdown("test.md", input);

    expectChunks(result, {
      "": "Some content after an empty heading.",
    });
  });

  test("filePath metadata is set correctly for each chunk", () => {
    const input = "# Title\n\nContent.";
    const result = chunkMarkdown("path/to/my-file.md", input);

    expect(result[0]!.filePath).toBe("path/to/my-file.md");
  });

  test("sectionDepth reflects the heading level of each chunk's top-level heading", () => {
    // ## is deeper than #, so it gets absorbed - only one chunk at depth 1
    const input = "# Level One\n\nOne.\n\n## Level Two\n\nTwo.";
    const result = chunkMarkdown("test.md", input);

    expect(result).toHaveLength(1);
    expect(result[0]!.sectionDepth).toBe(1);
    expect(result[0]!.content).toContain("Two.");
  });
});
