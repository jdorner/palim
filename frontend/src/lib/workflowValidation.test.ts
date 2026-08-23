import { describe, expect, test } from "bun:test";
import {
  computeOrphanedStepIndices,
  disconnectedStepError,
  normalizeIfBranchLabels,
  type StepTypeSchema,
  serializeStep,
  serializeWorkflowDraft,
  validateSlug,
  validateStepConfig,
  validateStepSlugsUnique,
  validateWorkflowDraft,
  type WorkflowDraft,
} from "./workflowValidation";

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
      edges: [],
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
        edges: [],
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
        edges: [],
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
        edges: [],
      };
      const errors = validateWorkflowDraft(draft);
      expect(errors.has("trigger.ref")).toBe(false);
    });

    test("accepts valid edges between existing steps", () => {
      const draft: WorkflowDraft = {
        ...validDraft,
        steps: [
          { slug: "a", type: "agent", prompt: "x" },
          { slug: "b", type: "agent", prompt: "y" },
        ],
        edges: [{ from: "a", to: "b" }],
      };
      const errors = validateWorkflowDraft(draft);
      expect(errors.size).toBe(0);
    });

    test("catches edge referencing an unknown step", () => {
      const draft: WorkflowDraft = {
        ...validDraft,
        steps: [{ slug: "a", type: "agent", prompt: "x" }],
        edges: [{ from: "a", to: "nonexistent" }],
      };
      const errors = validateWorkflowDraft(draft);
      expect(errors.has("edges[0].to")).toBe(true);
    });

    test("catches an orphaned step with no incoming or outgoing edges", () => {
      const draft: WorkflowDraft = {
        ...validDraft,
        steps: [
          { slug: "a", type: "agent", prompt: "x" },
          { slug: "b", type: "agent", prompt: "y" },
          { slug: "orphan", type: "agent", prompt: "z" },
        ],
        edges: [{ from: "a", to: "b" }],
      };
      const errors = validateWorkflowDraft(draft);
      expect(errors.has("steps[2].slug")).toBe(true);
      expect(errors.get("steps[2].slug")).toContain("not connected");
    });

    test("does not flag a connected step (incoming edge only)", () => {
      const draft: WorkflowDraft = {
        ...validDraft,
        steps: [
          { slug: "a", type: "agent", prompt: "x" },
          { slug: "b", type: "agent", prompt: "y" },
        ],
        edges: [{ from: "a", to: "b" }],
      };
      const errors = validateWorkflowDraft(draft);
      expect(errors.has("steps[0].slug")).toBe(false);
      expect(errors.has("steps[1].slug")).toBe(false);
    });

    test("does not flag orphan check for a single-step workflow with no edges", () => {
      const draft: WorkflowDraft = {
        ...validDraft,
        steps: [{ slug: "only", type: "agent", prompt: "x" }],
        edges: [],
      };
      const errors = validateWorkflowDraft(draft);
      expect(errors.has("steps[0].slug")).toBe(false);
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

  test("agent step includes only agent-valid fields (no slug in value)", () => {
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
      type: "agent",
      prompt: "Do something",
      tools: ["read_file"],
      skills: ["wiki"],
    });
    // slug is the map key in the DAG format, not a field in the value
    expect(result).not.toHaveProperty("slug");
    expect(result).not.toHaveProperty("url");
    expect(result).not.toHaveProperty("method");
    expect(result).not.toHaveProperty("body");
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
      type: "agent",
      prompt: "Hello",
      tools: ["tool-a"],
    });
    expect(result).not.toHaveProperty("skills");
  });

  test("if step serializes condition only (branches are edges)", () => {
    const step = {
      slug: "decide",
      type: "if" as const,
      condition: { ref: "{{steps.x.result}}", eq: "yes" },
    };
    const result = serializeStep(step);
    expect(result).toEqual({
      type: "if",
      condition: { ref: "{{steps.x.result}}", eq: "yes" },
    });
    expect(result).not.toHaveProperty("then");
    expect(result).not.toHaveProperty("else");
  });

  test("case step serializes match + paths (string keys) + default", () => {
    const step = {
      slug: "route",
      type: "case" as const,
      match: "{{steps.x.result}}",
      paths: ["low", "high"],
      default: "low",
    };
    const result = serializeStep(step);
    expect(result).toEqual({
      type: "case",
      match: "{{steps.x.result}}",
      paths: ["low", "high"],
      default: "low",
    });
  });

  test("custom step type merges type + config (no slug)", () => {
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
      type: "excel",
      mode: "create",
      path: "data/reports",
      filename: "report.xlsx",
      sheets: [{ name: "Sales", columns: [{ header: "Product", key: "product" }] }],
    });
    expect(result).not.toHaveProperty("slug");
  });

  test("custom step type with no config outputs type only", () => {
    const step = {
      slug: "empty-custom",
      type: "custom-type",
    };
    const result = serializeStep(step);
    expect(result).toEqual({
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
      edges: [],
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
      edges: [],
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
      edges: [],
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
      edges: [],
    };
    const result = serializeWorkflowDraft(draft) as { trigger: { type: string; ref?: string } };
    expect(result.trigger.ref).toBe("*/5 * * * *");
  });

  test("serializes steps as a map keyed by slug + edges array", () => {
    const draft = {
      name: "test-wf",
      description: "",
      trigger: { type: "manual", ref: "" },
      enabled: false,
      steps: [
        { slug: "agent-step", type: "agent", prompt: "Hello", config: { junk: true } },
        { slug: "req-step", type: "http-request", config: { url: "http://real.com", method: "POST" } },
      ],
      edges: [{ from: "agent-step", to: "req-step" }],
    };
    const result = serializeWorkflowDraft(draft) as {
      steps: Record<string, Record<string, unknown>>;
      edges: Array<{ from: string; to: string }>;
    };
    // steps is a map keyed by slug
    expect(Object.keys(result.steps).sort()).toEqual(["agent-step", "req-step"]);
    // Agent step value has no slug/config, keeps prompt
    expect(result.steps["agent-step"]).not.toHaveProperty("slug");
    expect(result.steps["agent-step"]).not.toHaveProperty("config");
    expect(result.steps["agent-step"]).toHaveProperty("prompt");
    // Custom step spreads config into the output value
    expect(result.steps["req-step"]).toHaveProperty("url");
    expect(result.steps["req-step"]).toHaveProperty("method");
    expect(result.steps["req-step"]).not.toHaveProperty("config");
    // edges preserved
    expect(result.edges).toEqual([{ from: "agent-step", to: "req-step" }]);
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
});

describe("validateStepConfig", () => {
  const schema = {
    type: "object",
    properties: {
      url: { type: "string", title: "URL", minLength: 1 },
      method: { type: "string", title: "Method" },
      timeout: { type: "number", title: "Timeout", minimum: 1000, maximum: 300000 },
      body: { type: "string", title: "Body", maxLength: 50 },
    },
    required: ["url"],
  };

  test("returns no errors for valid config", () => {
    const errors = validateStepConfig({ url: "http://example.com", method: "POST" }, schema);
    expect(errors).toEqual([]);
  });

  test("catches missing required field", () => {
    const errors = validateStepConfig({ method: "GET" }, schema);
    expect(errors.length).toBe(1);
    expect(errors[0][0]).toBe("url");
    expect(errors[0][1]).toContain("required");
  });

  test("catches empty required string field", () => {
    const errors = validateStepConfig({ url: "" }, schema);
    expect(errors.length).toBe(1);
    expect(errors[0][0]).toBe("url");
    expect(errors[0][1]).toContain("required");
  });

  test("catches minLength violation", () => {
    // url has minLength: 1, but "required" check fires first for empty strings.
    // Use a non-required field or test url with a 1-char value (passes minLength).
    // Let's add a scenario where a non-required field has minLength > 1.
    const strictSchema = {
      type: "object",
      properties: {
        name: { type: "string", title: "Name", minLength: 3 },
      },
      required: [],
    };
    const errors = validateStepConfig({ name: "ab" }, strictSchema);
    expect(errors.length).toBe(1);
    expect(errors[0][0]).toBe("name");
    expect(errors[0][1]).toContain("at least 3");
  });

  test("catches maxLength violation", () => {
    const errors = validateStepConfig({ url: "http://x.com", body: "x".repeat(51) }, schema);
    expect(errors.length).toBe(1);
    expect(errors[0][0]).toBe("body");
    expect(errors[0][1]).toContain("must not exceed 50");
  });

  test("catches minimum violation on number", () => {
    const errors = validateStepConfig({ url: "http://x.com", timeout: 500 }, schema);
    expect(errors.length).toBe(1);
    expect(errors[0][0]).toBe("timeout");
    expect(errors[0][1]).toContain("at least 1000");
  });

  test("catches maximum violation on number", () => {
    const errors = validateStepConfig({ url: "http://x.com", timeout: 999999 }, schema);
    expect(errors.length).toBe(1);
    expect(errors[0][0]).toBe("timeout");
    expect(errors[0][1]).toContain("must not exceed 300000");
  });

  test("skips validation for absent optional fields", () => {
    const errors = validateStepConfig({ url: "http://x.com" }, schema);
    expect(errors).toEqual([]);
  });
});

describe("validateWorkflowDraft with step type schemas", () => {
  const stepTypeSchemas: StepTypeSchema[] = [
    {
      type: "http-request",
      configSchema: {
        type: "object",
        properties: {
          url: { type: "string", title: "URL", minLength: 1 },
          method: { type: "string", title: "Method" },
        },
        required: ["url"],
      },
    },
  ];

  test("catches missing required config field on custom step", () => {
    const draft: WorkflowDraft = {
      name: "test-wf",
      description: "",
      trigger: { type: "manual", ref: "" },
      enabled: true,
      steps: [{ slug: "req-step", type: "http-request", config: { method: "GET" } }],
      edges: [],
    };
    const errors = validateWorkflowDraft(draft, stepTypeSchemas);
    expect(errors.has("steps[0].config.url")).toBe(true);
    expect(errors.get("steps[0].config.url")).toContain("required");
  });

  test("passes when required config fields are present", () => {
    const draft: WorkflowDraft = {
      name: "test-wf",
      description: "",
      trigger: { type: "manual", ref: "" },
      enabled: true,
      steps: [{ slug: "req-step", type: "http-request", config: { url: "http://example.com" } }],
      edges: [],
    };
    const errors = validateWorkflowDraft(draft, stepTypeSchemas);
    expect(errors.has("steps[0].config.url")).toBe(false);
  });

  test("skips config validation when no schema available for step type", () => {
    const draft: WorkflowDraft = {
      name: "test-wf",
      description: "",
      trigger: { type: "manual", ref: "" },
      enabled: true,
      steps: [{ slug: "unknown-step", type: "unknown-type", config: {} }],
      edges: [],
    };
    const errors = validateWorkflowDraft(draft, stepTypeSchemas);
    // No config errors since there's no schema for "unknown-type"
    const configErrors = [...errors.keys()].filter((k) => k.includes("config"));
    expect(configErrors.length).toBe(0);
  });

  test("skips config validation when no stepTypeSchemas provided", () => {
    const draft: WorkflowDraft = {
      name: "test-wf",
      description: "",
      trigger: { type: "manual", ref: "" },
      enabled: true,
      steps: [{ slug: "req-step", type: "http-request", config: {} }],
      edges: [],
    };
    const errors = validateWorkflowDraft(draft);
    const configErrors = [...errors.keys()].filter((k) => k.includes("config"));
    expect(configErrors.length).toBe(0);
  });
});

describe("id-based edges (draft edges reference synthetic step ids)", () => {
  const draft = (edges: Array<{ from: string; to: string; branch?: string }>): WorkflowDraft => ({
    name: "wf",
    description: "",
    trigger: { type: "manual", ref: "" },
    enabled: true,
    steps: [
      { id: "node-1", slug: "extract", type: "agent", prompt: "x" },
      { id: "node-2", slug: "parse", type: "agent", prompt: "y" },
    ],
    edges,
  });

  describe("serializeWorkflowDraft translates id edges back to slugs", () => {
    test("id-based edges become slug-based in the persisted output", () => {
      const result = serializeWorkflowDraft(draft([{ from: "node-1", to: "node-2" }])) as {
        edges: Array<{ from: string; to: string; branch?: string }>;
      };
      expect(result.edges).toEqual([{ from: "extract", to: "parse" }]);
    });

    test("connections survive after slugs are edited (edges keyed by stable id)", () => {
      // Simulate the user renaming both steps: only the slugs change, the ids
      // and the id-based edge stay put. Serialization must reflect the NEW slugs.
      const d = draft([{ from: "node-1", to: "node-2" }]);
      d.steps[0]!.slug = "extract-image-text";
      d.steps[1]!.slug = "parse-data";
      const result = serializeWorkflowDraft(d) as { edges: Array<{ from: string; to: string }> };
      expect(result.edges).toEqual([{ from: "extract-image-text", to: "parse-data" }]);
    });

    test("preserves the branch label when translating", () => {
      const result = serializeWorkflowDraft(draft([{ from: "node-1", to: "node-2", branch: "then" }])) as {
        edges: Array<{ from: string; to: string; branch?: string }>;
      };
      expect(result.edges).toEqual([{ from: "extract", to: "parse", branch: "then" }]);
    });

    test("drops edges whose endpoints no longer resolve to a step", () => {
      const result = serializeWorkflowDraft(draft([{ from: "node-1", to: "ghost" }])) as {
        edges: Array<{ from: string; to: string }>;
      };
      expect(result.edges).toEqual([]);
    });
  });

  describe("validateWorkflowDraft resolves edges by id", () => {
    test("accepts id-based edges between existing steps", () => {
      const errors = validateWorkflowDraft(draft([{ from: "node-1", to: "node-2" }]));
      expect(errors.size).toBe(0);
    });

    test("does not flag connected steps as orphaned even with empty slugs", () => {
      // Both steps have their slug cleared but remain connected by id -- the
      // orphan check must key on id, not slug.
      const d = draft([{ from: "node-1", to: "node-2" }]);
      d.steps[0]!.slug = "";
      d.steps[1]!.slug = "";
      const errors = validateWorkflowDraft(d);
      // Slug errors will fire (empty slug is invalid), but NOT the "not
      // connected" orphan error.
      expect(errors.get("steps[0].slug")).not.toContain("not connected");
      expect(errors.get("steps[1].slug")).not.toContain("not connected");
    });

    test("flags an id-based edge referencing an unknown step", () => {
      const errors = validateWorkflowDraft(draft([{ from: "node-1", to: "ghost" }]));
      expect(errors.has("edges[0].to")).toBe(true);
    });
  });
});

describe("computeOrphanedStepIndices", () => {
  const draft = (
    steps: Array<{ id: string; slug: string }>,
    edges: Array<{ from: string; to: string; branch?: string }>,
  ): WorkflowDraft => ({
    name: "wf",
    description: "",
    trigger: { type: "manual", ref: "" },
    enabled: true,
    steps: steps.map((s) => ({ id: s.id, slug: s.slug, type: "agent", prompt: "x" })),
    edges,
  });

  test("returns empty for a single-step workflow with no edges", () => {
    expect(computeOrphanedStepIndices(draft([{ id: "node-1", slug: "a" }], []))).toEqual([]);
  });

  test("flags a step touched by no edge", () => {
    const d = draft(
      [
        { id: "node-1", slug: "a" },
        { id: "node-2", slug: "b" },
        { id: "node-3", slug: "c" },
      ],
      [{ from: "node-1", to: "node-2" }],
    );
    expect(computeOrphanedStepIndices(d)).toEqual([2]);
  });

  test("no orphans once every step is connected as source or target", () => {
    const d = draft(
      [
        { id: "node-1", slug: "a" },
        { id: "node-2", slug: "b" },
        { id: "node-3", slug: "c" },
      ],
      [
        { from: "node-1", to: "node-2" },
        { from: "node-2", to: "node-3" },
      ],
    );
    expect(computeOrphanedStepIndices(d)).toEqual([]);
  });

  test("drawing an edge to a previously orphaned step clears it", () => {
    const steps = [
      { id: "node-6", slug: "step-6" },
      { id: "node-7", slug: "step-7" },
    ];
    // Before: step-7 is disconnected.
    expect(computeOrphanedStepIndices(draft(steps, []))).toEqual([0, 1]);
    // After: an edge from step-6 to step-7 connects both.
    expect(computeOrphanedStepIndices(draft(steps, [{ from: "node-6", to: "node-7" }]))).toEqual([]);
  });
});

describe("disconnectedStepError", () => {
  test("embeds the slug and ends with the connectivity phrase", () => {
    const msg = disconnectedStepError("step-7");
    expect(msg).toContain("step-7");
    expect(msg.endsWith("is not connected to any other step")).toBe(true);
  });
});

describe("if branch labels", () => {
  describe("normalizeIfBranchLabels", () => {
    test("returns undefined when both labels are empty or missing", () => {
      expect(normalizeIfBranchLabels(undefined)).toBeUndefined();
      expect(normalizeIfBranchLabels({})).toBeUndefined();
      // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword, not a thenable
      expect(normalizeIfBranchLabels({ then: "", else: "  " })).toBeUndefined();
    });

    test("trims and keeps only non-empty labels", () => {
      // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword, not a thenable
      expect(normalizeIfBranchLabels({ then: " yes ", else: "" })).toEqual({ then: "yes" });
      // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword, not a thenable
      expect(normalizeIfBranchLabels({ then: "yes", else: "no" })).toEqual({ then: "yes", else: "no" });
      expect(normalizeIfBranchLabels({ else: "no" })).toEqual({ else: "no" });
    });
  });

  describe("serializeStep for if", () => {
    test("omits branchLabels when unset", () => {
      const out = serializeStep({ id: "n1", slug: "check", type: "if", condition: { ref: "{{x}}" } });
      expect(out).toEqual({ type: "if", condition: { ref: "{{x}}" } });
      expect("branchLabels" in out).toBe(false);
    });

    test("persists only non-empty trimmed branch labels", () => {
      const out = serializeStep({
        id: "n1",
        slug: "check",
        type: "if",
        condition: { ref: "{{x}}" },
        // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword, not a thenable
        branchLabels: { then: " approved ", else: "" },
      });
      // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword, not a thenable
      expect(out.branchLabels).toEqual({ then: "approved" });
    });
  });
});
