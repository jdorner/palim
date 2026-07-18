/**
 * Tests for {@link parseSkillMd}.
 *
 * Covers basic frontmatter extraction, YAML edge cases that the
 * previous regex-based parser could not handle (colons in values,
 * quoted strings, non-string types, multi-line values), and various
 * malformed-input scenarios.
 */

import { describe, expect, test } from "bun:test";
import { parseSkillMd } from "./frontmatter";

// ---------------------------------------------------------------------------
// Basic parsing
// ---------------------------------------------------------------------------

describe("parseSkillMd", () => {
  describe("basic parsing", () => {
    test("extracts simple key-value frontmatter and body content", () => {
      const input = `---
name: my-skill
description: A simple skill
---
# Hello

Body content here.`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter.name).toBe("my-skill");
      expect(result.frontmatter.description).toBe("A simple skill");
      expect(result.content).toBe("# Hello\n\nBody content here.");
    });

    test("trims body content", () => {
      const input = `---
name: test
---

  Some content with leading whitespace

`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.content).toBe("Some content with leading whitespace");
    });

    test("returns empty content when body is blank", () => {
      const input = `---
name: test
---
`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter.name).toBe("test");
      expect(result.content).toBe("");
    });
  });

  // ---------------------------------------------------------------------------
  // YAML features (previously broken with regex parser)
  // ---------------------------------------------------------------------------

  describe("YAML features", () => {
    test("handles colons in values", () => {
      const input = `---
name: scheduler
description: "Run at 08:00 daily"
---
Body`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter.description).toBe("Run at 08:00 daily");
    });

    test("handles unquoted colons in values", () => {
      const input = `---
name: scheduler
schedule: "cron: 0 8 * * *"
---
Body`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter.schedule).toBe("cron: 0 8 * * *");
    });

    test("handles single-quoted strings", () => {
      const input = `---
name: 'my-skill'
description: 'A skill with "double quotes" inside'
---
Body`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter.name).toBe("my-skill");
      expect(result.frontmatter.description).toBe('A skill with "double quotes" inside');
    });

    test("handles double-quoted strings with escapes", () => {
      const input = `---
name: "escape-test"
description: "Line one\\nLine two"
---
Body`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter.description).toBe("Line one\nLine two");
    });

    test("preserves boolean values as booleans", () => {
      const input = `---
name: bool-test
enabled: true
disabled: false
---
Body`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter.enabled).toBe(true);
      expect(result.frontmatter.disabled).toBe(false);
    });

    test("preserves numeric values as numbers", () => {
      const input = `---
name: num-test
priority: 10
weight: 3.14
---
Body`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter.priority).toBe(10);
      expect(result.frontmatter.weight).toBe(3.14);
    });

    test("handles array values", () => {
      const input = `---
name: array-test
tags:
  - automation
  - scheduling
  - daily
---
Body`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter.tags).toEqual(["automation", "scheduling", "daily"]);
    });

    test("handles inline array values", () => {
      const input = `---
name: inline-array
tags: [alpha, beta, gamma]
---
Body`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter.tags).toEqual(["alpha", "beta", "gamma"]);
    });

    test("handles nested objects", () => {
      const input = `---
name: nested-test
config:
  timeout: 30
  retries: 3
---
Body`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter.config).toEqual({ timeout: 30, retries: 3 });
    });

    test("handles YAML block scalar (literal |)", () => {
      const input = `---
name: block-test
description: |
  This is a multi-line
  description value.
---
Body`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter.description).toBe("This is a multi-line\ndescription value.\n");
    });

    test("handles YAML folded scalar (>)", () => {
      const input = `---
name: folded-test
description: >
  This is a long description
  that should be folded into
  a single line.
---
Body`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter.description).toBe(
        "This is a long description that should be folded into a single line.\n",
      );
    });

    test("handles null values", () => {
      const input = `---
name: null-test
optional_field: null
another: ~
---
Body`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter.optional_field).toBeNull();
      expect(result.frontmatter.another).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Real-world skill format
  // ---------------------------------------------------------------------------

  describe("real-world skill format", () => {
    test("parses a typical SKILL.md file", () => {
      const input = `---
name: plan-first
description: Structured planning workflow for any coding task. Use at the start of every new feature, bug fix, refactor, or implementation request.
---

# Plan-First Workflow

## Rules

- NEVER write code before a plan is approved.
- NEVER assume missing information.`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter.name).toBe("plan-first");
      expect(result.frontmatter.description).toContain("Structured planning workflow");
      expect(result.content).toContain("# Plan-First Workflow");
      expect(result.content).toContain("NEVER write code");
    });

    test("parses skill with extra frontmatter fields", () => {
      const input = `---
name: task-list
description: Manages the task list
version: 2
tags: [tasks, management]
---
# Task List Skill`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter.name).toBe("task-list");
      expect(result.frontmatter.version).toBe(2);
      expect(result.frontmatter.tags).toEqual(["tasks", "management"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Invalid / edge-case inputs
  // ---------------------------------------------------------------------------

  describe("invalid and edge-case inputs", () => {
    test("returns error for content without frontmatter fences", () => {
      const result = parseSkillMd("# Just a heading\n\nSome content.");
      expect(result.error).toBe(true);
      expect(result.errorMessage).toContain("No frontmatter fences");
    });

    test("returns error for empty string", () => {
      const result = parseSkillMd("");
      expect(result.error).toBe(true);
    });

    test("returns error for single fence only", () => {
      const result = parseSkillMd("---\nname: test\n");
      expect(result.error).toBe(true);
    });

    test("returns error when opening fence is not at start of file", () => {
      const input = `Some preamble
---
name: test
---
Body`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(true);
    });

    test("returns empty frontmatter for empty YAML block", () => {
      const input = `---

---
Body`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter).toEqual({});
      expect(result.content).toBe("Body");
    });

    test("returns error for invalid YAML", () => {
      const input = `---
: : : broken yaml [[[
  - not: {valid
---
Body`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(true);
      expect(result.errorMessage).toBeDefined();
      expect(result.content).toBe("Body");
    });

    test("returns empty frontmatter when YAML parses to a scalar", () => {
      const input = `---
just a plain string
---
Body`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter).toEqual({});
    });

    test("returns empty frontmatter when YAML parses to an array", () => {
      const input = `---
- item1
- item2
---
Body`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter).toEqual({});
    });

    test("handles body containing --- separators without confusion", () => {
      const input = `---
name: test
---
# Heading

Some content.

---

More content after a horizontal rule.`;

      const result = parseSkillMd(input);
      expect(result.error).toBe(false);
      expect(result.frontmatter.name).toBe("test");
      expect(result.content).toContain("---");
      expect(result.content).toContain("More content after a horizontal rule.");
    });
  });
});
