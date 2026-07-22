import { describe, expect, test } from "bun:test";
import { validateSlug, validateStepSlugsUnique, validateWorkflowDraft, type WorkflowDraft } from "./workflowValidation";

describe("workflowValidation", () => {
  describe("validateSlug", () => {
    describe("accepts valid slugs", () => {
      test("simple slug", () => {
        expect(validateSlug("my-workflow")).toEqual({ valid: true });
      });

      test("short slug", () => {
        expect(validateSlug("a1")).toEqual({ valid: true });
      });

      test("slug with digits and hyphens", () => {
        expect(validateSlug("test-123")).toEqual({ valid: true });
      });

      test("single letter", () => {
        expect(validateSlug("a")).toEqual({ valid: true });
      });

      test("all lowercase letters", () => {
        expect(validateSlug("abcdefghijklmnopqrstuvwxyz")).toEqual({ valid: true });
      });

      test("64 characters (max length)", () => {
        const slug = `a${"b".repeat(63)}`;
        expect(validateSlug(slug)).toEqual({ valid: true });
      });
    });

    describe("rejects invalid patterns", () => {
      test("uppercase letters", () => {
        const result = validateSlug("MyWorkflow");
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      });

      test("leading digit", () => {
        const result = validateSlug("1workflow");
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      });

      test("special characters (underscore)", () => {
        const result = validateSlug("my_workflow");
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      });

      test("special characters (dot)", () => {
        const result = validateSlug("my.workflow");
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      });

      test("spaces", () => {
        const result = validateSlug("my workflow");
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      });

      test("leading hyphen", () => {
        const result = validateSlug("-workflow");
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      });
    });

    describe("rejects empty strings", () => {
      test("empty string", () => {
        const result = validateSlug("");
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      });
    });

    describe("rejects strings > 64 characters", () => {
      test("65 characters", () => {
        const slug = `a${"b".repeat(64)}`;
        expect(slug.length).toBe(65);
        const result = validateSlug(slug);
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      });

      test("100 characters", () => {
        const slug = `a${"b".repeat(99)}`;
        const result = validateSlug(slug);
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      });
    });
  });

  describe("validateStepSlugsUnique", () => {
    test("accepts unique slugs", () => {
      expect(validateStepSlugsUnique(["step-a", "step-b", "step-c"])).toEqual({ valid: true });
    });

    test("accepts empty array", () => {
      expect(validateStepSlugsUnique([])).toEqual({ valid: true });
    });

    test("accepts single slug", () => {
      expect(validateStepSlugsUnique(["only-one"])).toEqual({ valid: true });
    });

    test("detects duplicate slugs", () => {
      const result = validateStepSlugsUnique(["step-a", "step-b", "step-a"]);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("step-a");
    });

    test("detects first duplicate in list", () => {
      const result = validateStepSlugsUnique(["x", "y", "y", "z", "z"]);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("y");
    });
  });

  describe("validateWorkflowDraft", () => {
    const validDraft: WorkflowDraft = {
      name: "my-workflow",
      description: "A test workflow",
      trigger: { type: "manual", ref: "" },
      enabled: true,
      steps: [{ slug: "step-one", type: "agent", prompt: "Do something" }],
    };

    test("valid draft returns empty error map", () => {
      const errors = validateWorkflowDraft(validDraft);
      expect(errors.size).toBe(0);
    });

    test("catches missing name", () => {
      const draft: WorkflowDraft = { ...validDraft, name: "" };
      const errors = validateWorkflowDraft(draft);
      expect(errors.has("name")).toBe(true);
    });

    test("catches invalid name pattern", () => {
      const draft: WorkflowDraft = { ...validDraft, name: "Invalid-Name" };
      const errors = validateWorkflowDraft(draft);
      expect(errors.has("name")).toBe(true);
    });

    test("catches invalid trigger type", () => {
      const draft: WorkflowDraft = { ...validDraft, trigger: { type: "invalid", ref: "" } };
      const errors = validateWorkflowDraft(draft);
      expect(errors.has("trigger.type")).toBe(true);
    });

    test("catches empty steps array", () => {
      const draft: WorkflowDraft = { ...validDraft, steps: [] };
      const errors = validateWorkflowDraft(draft);
      expect(errors.has("steps")).toBe(true);
    });

    test("catches invalid step slug", () => {
      const draft: WorkflowDraft = {
        ...validDraft,
        steps: [{ slug: "Invalid", type: "agent" }],
      };
      const errors = validateWorkflowDraft(draft);
      expect(errors.has("steps[0].slug")).toBe(true);
    });

    test("catches duplicate step slugs", () => {
      const draft: WorkflowDraft = {
        ...validDraft,
        steps: [
          { slug: "step-a", type: "agent" },
          { slug: "step-a", type: "agent" },
        ],
      };
      const errors = validateWorkflowDraft(draft);
      expect(errors.has("steps.slugs")).toBe(true);
    });

    test("catches description exceeding 256 characters", () => {
      const draft: WorkflowDraft = { ...validDraft, description: "x".repeat(257) };
      const errors = validateWorkflowDraft(draft);
      expect(errors.has("description")).toBe(true);
    });

    test("catches trigger ref present on manual trigger type", () => {
      const draft: WorkflowDraft = {
        name: "my-workflow",
        description: "",
        trigger: { type: "manual", ref: "some-ref" },
        enabled: true,
        steps: [{ slug: "step-one", type: "agent", prompt: "Do something" }],
      };
      const errors = validateWorkflowDraft(draft);
      expect(errors.has("trigger.ref")).toBe(true);
      expect(errors.get("trigger.ref")).toContain("Manual triggers");
    });

    test("allows empty ref on manual trigger type", () => {
      const draft: WorkflowDraft = {
        name: "my-workflow",
        description: "",
        trigger: { type: "manual", ref: "" },
        enabled: true,
        steps: [{ slug: "step-one", type: "agent", prompt: "Do something" }],
      };
      const errors = validateWorkflowDraft(draft);
      expect(errors.has("trigger.ref")).toBe(false);
    });

    test("allows ref on non-manual trigger types", () => {
      const draft: WorkflowDraft = {
        name: "my-workflow",
        description: "",
        trigger: { type: "schedule", ref: "*/5 * * * *" },
        enabled: true,
        steps: [{ slug: "step-one", type: "agent", prompt: "Do something" }],
      };
      const errors = validateWorkflowDraft(draft);
      expect(errors.has("trigger.ref")).toBe(false);
    });
  });

  describe("Property 4: Slug validation correctness", () => {
    /**
     * Validates: Requirements 9.1, 9.2, 9.7
     *
     * For any string s, the slug validation function shall return valid if and only if
     * s matches the regex ^[a-z][a-z0-9-]*$ AND s.length <= 64 AND s.length > 0.
     */
    const SLUG_REGEX = /^[a-z][a-z0-9-]*$/;
    const MAX_LENGTH = 64;

    function referenceIsValid(s: string): boolean {
      return s.length > 0 && s.length <= MAX_LENGTH && SLUG_REGEX.test(s);
    }

    function randomString(length: number): string {
      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.! @#";
      let result = "";
      for (let i = 0; i < length; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
      }
      return result;
    }

    test("slug validation matches reference implementation for 200 random strings", () => {
      for (let i = 0; i < 200; i++) {
        const length = Math.floor(Math.random() * 80); // 0 to 79 chars
        const s = randomString(length);
        const result = validateSlug(s);
        const expected = referenceIsValid(s);

        if (result.valid !== expected) {
          throw new Error(
            `Mismatch for string "${s}" (length ${s.length}): validateSlug returned ${result.valid}, reference returned ${expected}`,
          );
        }
      }
    });

    test("slug validation correct for boundary cases", () => {
      // Edge cases: empty, single valid char, exactly 64, exactly 65
      const cases = [
        "", // empty
        "a", // single valid
        "A", // single invalid (uppercase)
        "1", // single invalid (digit)
        "-", // single invalid (hyphen)
        "a".repeat(64), // max length valid
        "a".repeat(65), // over max length
        "a-b-c", // valid with hyphens
        "abc123", // valid with digits
      ];

      for (const s of cases) {
        const result = validateSlug(s);
        const expected = referenceIsValid(s);
        expect(result.valid).toBe(expected);
      }
    });
  });
});

describe("serializeStep", () => {
  const { serializeStep } = require("./workflowValidation");

  test("agent step includes only agent-valid fields", () => {
    const step = {
      slug: "my-step",
      type: "agent" as const,
      prompt: "Do something",
      tools: ["read_file"],
      skills: ["wiki"],
      url: "http://example.com",
      method: "POST",
      body: '{"key": "value"}',
    };
    const result = serializeStep(step);
    expect(result).toEqual({
      slug: "my-step",
      type: "agent",
      prompt: "Do something",
      tools: ["read_file"],
      skills: ["wiki"],
    });
    expect(result).not.toHaveProperty("url");
    expect(result).not.toHaveProperty("method");
    expect(result).not.toHaveProperty("body");
  });

  test("webhook step includes only webhook-valid fields", () => {
    const step = {
      slug: "hook-step",
      type: "webhook" as const,
      url: "http://example.com/hook",
      method: "POST",
      body: '{"data": true}',
      prompt: "This should be stripped",
      tools: ["read_file"],
      skills: ["wiki"],
    };
    const result = serializeStep(step);
    expect(result).toEqual({
      slug: "hook-step",
      type: "webhook",
      url: "http://example.com/hook",
      method: "POST",
      body: '{"data": true}',
    });
    expect(result).not.toHaveProperty("prompt");
    expect(result).not.toHaveProperty("tools");
    expect(result).not.toHaveProperty("skills");
  });

  test("agent step omits tools when empty array", () => {
    const step = {
      slug: "agent-step",
      type: "agent" as const,
      prompt: "Hello",
      tools: [],
      skills: [],
    };
    const result = serializeStep(step);
    expect(result).toEqual({
      slug: "agent-step",
      type: "agent",
      prompt: "Hello",
    });
    expect(result).not.toHaveProperty("tools");
    expect(result).not.toHaveProperty("skills");
  });

  test("agent step includes tools only when non-empty", () => {
    const step = {
      slug: "agent-step",
      type: "agent" as const,
      prompt: "Hello",
      tools: ["tool-a"],
      skills: [],
    };
    const result = serializeStep(step);
    expect(result).toEqual({
      slug: "agent-step",
      type: "agent",
      prompt: "Hello",
      tools: ["tool-a"],
    });
    expect(result).not.toHaveProperty("skills");
  });

  test("webhook step omits method and body when falsy", () => {
    const step = {
      slug: "hook-step",
      type: "webhook" as const,
      url: "http://example.com",
      method: "",
      body: "",
    };
    const result = serializeStep(step);
    expect(result).toEqual({
      slug: "hook-step",
      type: "webhook",
      url: "http://example.com",
    });
    expect(result).not.toHaveProperty("method");
    expect(result).not.toHaveProperty("body");
  });

  test("custom step type merges slug + type + config", () => {
    const step = {
      slug: "generate-report",
      type: "excel",
      config: {
        mode: "create",
        path: "data/reports",
        filename: "report.xlsx",
        sheets: [{ name: "Sales", columns: [{ header: "Product", key: "product" }] }],
      },
    };
    const result = serializeStep(step);
    expect(result).toEqual({
      slug: "generate-report",
      type: "excel",
      mode: "create",
      path: "data/reports",
      filename: "report.xlsx",
      sheets: [{ name: "Sales", columns: [{ header: "Product", key: "product" }] }],
    });
  });

  test("custom step type with no config outputs slug and type only", () => {
    const step = {
      slug: "empty-custom",
      type: "custom-type",
    };
    const result = serializeStep(step);
    expect(result).toEqual({
      slug: "empty-custom",
      type: "custom-type",
    });
  });
});

describe("serializeWorkflowDraft", () => {
  const { serializeWorkflowDraft } = require("./workflowValidation");

  test("omits empty description", () => {
    const draft = {
      name: "my-workflow",
      description: "",
      trigger: { type: "manual", ref: "" },
      enabled: true,
      steps: [{ slug: "step-one", type: "agent", prompt: "Do it" }],
    };
    const result = serializeWorkflowDraft(draft);
    expect(result).not.toHaveProperty("description");
    expect(result.name).toBe("my-workflow");
    expect(result.enabled).toBe(true);
  });

  test("includes non-empty description", () => {
    const draft = {
      name: "my-workflow",
      description: "A useful workflow",
      trigger: { type: "manual", ref: "" },
      enabled: true,
      steps: [{ slug: "step-one", type: "agent", prompt: "Do it" }],
    };
    const result = serializeWorkflowDraft(draft);
    expect(result.description).toBe("A useful workflow");
  });

  test("omits empty trigger ref", () => {
    const draft = {
      name: "my-workflow",
      description: "",
      trigger: { type: "schedule", ref: "" },
      enabled: true,
      steps: [{ slug: "step-one", type: "agent", prompt: "Do it" }],
    };
    const result = serializeWorkflowDraft(draft) as { trigger: { type: string; ref?: string } };
    expect(result.trigger.type).toBe("schedule");
    expect(result.trigger).not.toHaveProperty("ref");
  });

  test("includes non-empty trigger ref", () => {
    const draft = {
      name: "my-workflow",
      description: "",
      trigger: { type: "schedule", ref: "*/5 * * * *" },
      enabled: true,
      steps: [{ slug: "step-one", type: "agent", prompt: "Do it" }],
    };
    const result = serializeWorkflowDraft(draft) as { trigger: { type: string; ref?: string } };
    expect(result.trigger.ref).toBe("*/5 * * * *");
  });

  test("serializes steps using serializeStep (strips extra fields)", () => {
    const draft = {
      name: "test-wf",
      description: "",
      trigger: { type: "manual", ref: "" },
      enabled: false,
      steps: [
        { slug: "agent-step", type: "agent", prompt: "Hello", url: "http://junk.com", method: "GET" },
        { slug: "hook-step", type: "webhook", url: "http://real.com", prompt: "Junk", tools: ["x"] },
      ],
    };
    const result = serializeWorkflowDraft(draft) as { steps: Record<string, unknown>[] };
    // Agent step should not have url or method
    expect(result.steps[0]).not.toHaveProperty("url");
    expect(result.steps[0]).not.toHaveProperty("method");
    // Webhook step should not have prompt or tools
    expect(result.steps[1]).not.toHaveProperty("prompt");
    expect(result.steps[1]).not.toHaveProperty("tools");
  });

  test("omits ref when trigger type is manual even if ref is set", () => {
    const draft = {
      name: "my-workflow",
      description: "",
      trigger: { type: "manual", ref: "stale-value" },
      enabled: true,
      steps: [{ slug: "step-one", type: "agent", prompt: "Do it" }],
    };
    const result = serializeWorkflowDraft(draft) as { trigger: { type: string; ref?: string } };
    expect(result.trigger.type).toBe("manual");
    expect(result.trigger).not.toHaveProperty("ref");
  });
});

describe("validateWorkflowDraft - type-specific validation", () => {
  const { validateWorkflowDraft } = require("./workflowValidation");

  test("catches missing prompt on agent steps", () => {
    const draft = {
      name: "my-workflow",
      description: "",
      trigger: { type: "manual", ref: "" },
      enabled: true,
      steps: [{ slug: "step-one", type: "agent", prompt: "" }],
    };
    const errors = validateWorkflowDraft(draft);
    expect(errors.has("steps[0].prompt")).toBe(true);
    expect(errors.get("steps[0].prompt")).toContain("Prompt is required");
  });

  test("catches missing prompt (undefined) on agent steps", () => {
    const draft = {
      name: "my-workflow",
      description: "",
      trigger: { type: "manual", ref: "" },
      enabled: true,
      steps: [{ slug: "step-one", type: "agent" }],
    };
    const errors = validateWorkflowDraft(draft);
    expect(errors.has("steps[0].prompt")).toBe(true);
  });

  test("catches whitespace-only prompt on agent steps", () => {
    const draft = {
      name: "my-workflow",
      description: "",
      trigger: { type: "manual", ref: "" },
      enabled: true,
      steps: [{ slug: "step-one", type: "agent", prompt: "   " }],
    };
    const errors = validateWorkflowDraft(draft);
    expect(errors.has("steps[0].prompt")).toBe(true);
  });

  test("catches missing url on webhook steps", () => {
    const draft = {
      name: "my-workflow",
      description: "",
      trigger: { type: "manual", ref: "" },
      enabled: true,
      steps: [{ slug: "step-one", type: "webhook", url: "" }],
    };
    const errors = validateWorkflowDraft(draft);
    expect(errors.has("steps[0].url")).toBe(true);
    expect(errors.get("steps[0].url")).toContain("URL is required");
  });

  test("catches missing url (undefined) on webhook steps", () => {
    const draft = {
      name: "my-workflow",
      description: "",
      trigger: { type: "manual", ref: "" },
      enabled: true,
      steps: [{ slug: "step-one", type: "webhook" }],
    };
    const errors = validateWorkflowDraft(draft);
    expect(errors.has("steps[0].url")).toBe(true);
  });

  test("no prompt error for agent step with valid prompt", () => {
    const draft = {
      name: "my-workflow",
      description: "",
      trigger: { type: "manual", ref: "" },
      enabled: true,
      steps: [{ slug: "step-one", type: "agent", prompt: "Do something" }],
    };
    const errors = validateWorkflowDraft(draft);
    expect(errors.has("steps[0].prompt")).toBe(false);
  });

  test("no url error for webhook step with valid url", () => {
    const draft = {
      name: "my-workflow",
      description: "",
      trigger: { type: "manual", ref: "" },
      enabled: true,
      steps: [{ slug: "step-one", type: "webhook", url: "http://example.com" }],
    };
    const errors = validateWorkflowDraft(draft);
    expect(errors.has("steps[0].url")).toBe(false);
  });
});
