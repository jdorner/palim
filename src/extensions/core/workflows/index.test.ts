/**
 * Tests for the workflows extension utility functions (DAG model).
 */

import { describe, expect, test } from "bun:test";
import type { ExtensionContext, StepTypeHandler, TriggerTypeDefinition } from "@ext/types";
import { Type } from "@sinclair/typebox";
import { getDraftTargetWarnings, resolveDispatchTarget, workflowsForTrigger } from "./autoStart";
import type { DagWorkflowDefinition } from "./schemas";
import { buildStepJobIdMap } from "./stepJobs";
import { fetchExtensionTriggerRefs, getTriggerRefWarnings, type TriggerRefLookup, triggerRefMode } from "./triggerRefs";
import { getDependencyWarnings } from "./workflowAnalysis";

// ---------------------------------------------------------------------------
// getDependencyWarnings - agent tools and skills
// ---------------------------------------------------------------------------

describe("getDependencyWarnings (agent tools and skills)", () => {
  /** Builds a minimal mock ExtensionContext exposing tool and skill name sets. */
  function mockCtx(extensionTools: string[], skills: string[]): ExtensionContext {
    return {
      tools: { names: () => extensionTools },
      skills: { names: () => skills },
      stepTypes: { get: () => undefined },
    } as unknown as ExtensionContext;
  }

  /** Builds a manual-trigger workflow from a steps map. */
  function wf(steps: DagWorkflowDefinition["steps"]): DagWorkflowDefinition {
    return { name: "wf", trigger: { type: "manual" }, steps, edges: [] };
  }

  test("no warnings when the agent step uses no tools or skills", () => {
    expect(getDependencyWarnings(wf({ a: { type: "agent", prompt: "Hello" } }), mockCtx([], []))).toEqual([]);
  });

  test("no warnings when all tools and skills are available", () => {
    const def = wf({ a: { type: "agent", prompt: "Go", tools: ["exec", "send_telegram_message"], skills: ["wiki"] } });
    expect(getDependencyWarnings(def, mockCtx(["send_telegram_message"], ["wiki"]))).toEqual([]);
  });

  test("recognizes sandbox tools as available", () => {
    const def = wf({
      a: {
        type: "agent",
        prompt: "Go",
        tools: ["exec", "read_file", "write_file", "list_files", "edit", "create_directory"],
      },
    });
    expect(getDependencyWarnings(def, mockCtx([], []))).toEqual([]);
  });

  test("warns per step about missing tools and skills", () => {
    const def = wf({
      a: { type: "agent", prompt: "Go", tools: ["exec", "missing_tool"], skills: ["wiki", "missing_skill"] },
      b: { type: "agent", prompt: "Go", tools: ["missing_tool"] },
    });
    expect(getDependencyWarnings(def, mockCtx([], ["wiki"])).map((w) => [w.stepSlug, w.field, w.message])).toEqual([
      ["a", "tools", 'Tool "missing_tool" is not available (not registered or extension disabled)'],
      ["a", "skills", 'Skill "missing_skill" is not available (not found or extension disabled)'],
      ["b", "tools", 'Tool "missing_tool" is not available (not registered or extension disabled)'],
    ]);
  });

  test("ignores tools and skills checks for built-in non-agent steps", () => {
    expect(getDependencyWarnings(wf({ notify: { type: "emit", event: "done" } }), mockCtx([], []))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildStepJobIdMap
// ---------------------------------------------------------------------------

describe("buildStepJobIdMap", () => {
  test("maps each step slug to its real job ID", () => {
    const map = buildStepJobIdMap([
      { stepSlug: "fetch", id: "job-1" },
      { stepSlug: "process", id: "job-2" },
    ]);
    expect(map.get("fetch")).toBe("job-1");
    expect(map.get("process")).toBe("job-2");
  });

  test("does not map the run ID onto steps (regression: logs 404)", () => {
    // Steps must resolve to their own job ID, never the run ID. Previously the
    // run detail endpoint stamped every step's jobId with the run ID, so the
    // UI requested /api/jobs/<runId>/logs and got a 404.
    const map = buildStepJobIdMap([{ stepSlug: "fetch", id: "job-1" }]);
    expect(map.get("fetch")).toBe("job-1");
    expect(map.get("fetch")).not.toBe("run-123");
  });

  test("omits steps that produced no job (control-flow, dead branches)", () => {
    const map = buildStepJobIdMap([{ stepSlug: "fetch", id: "job-1" }]);
    expect(map.has("decide")).toBe(false);
    expect(map.get("decide")).toBeUndefined();
  });

  test("returns an empty map when there are no jobs", () => {
    expect(buildStepJobIdMap([]).size).toBe(0);
  });

  test("keeps the last job ID when a slug has multiple jobs (retries)", () => {
    const map = buildStepJobIdMap([
      { stepSlug: "fetch", id: "job-old" },
      { stepSlug: "fetch", id: "job-new" },
    ]);
    expect(map.get("fetch")).toBe("job-new");
  });
});

// ---------------------------------------------------------------------------
// getDependencyWarnings - custom step-type config validation
// ---------------------------------------------------------------------------

describe("getDependencyWarnings (custom step-type config)", () => {
  /** A handler whose config schema requires `command` to be a string. */
  const commandHandler: StepTypeHandler = {
    schema: Type.Object({ command: Type.String({ minLength: 1 }) }),
    label: "Sandbox Command",
    execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };

  /** Builds a mock context exposing tools, skills, and a step-type registry. */
  function mockCtx(handlers: Record<string, StepTypeHandler>): ExtensionContext {
    return {
      tools: { names: () => [] },
      skills: { names: () => [] },
      stepTypes: { get: (type: string) => handlers[type] },
    } as unknown as ExtensionContext;
  }

  test("flags a registered custom step whose config violates the handler schema", () => {
    // `command` given as an array; the handler requires a string. This is the
    // exact class of bug that previously only failed at run time because the
    // generic DAG step schema accepts any config for custom types.
    const wf: DagWorkflowDefinition = {
      name: "bad-config",
      trigger: { type: "manual" },
      steps: { convert: { type: "sandbox-exec", command: ["a", "b"] } as never },
      edges: [],
    };

    const warnings = getDependencyWarnings(wf, mockCtx({ "sandbox-exec": commandHandler }));
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]!.stepSlug).toBe("convert");
    expect(warnings.some((w) => w.message.includes("sandbox-exec"))).toBe(true);
    expect(warnings.some((w) => w.message.toLowerCase().includes("command"))).toBe(true);
  });

  test("passes a registered custom step with valid config", () => {
    const wf: DagWorkflowDefinition = {
      name: "good-config",
      trigger: { type: "manual" },
      steps: { convert: { type: "sandbox-exec", command: "echo hi" } as never },
      edges: [],
    };

    const warnings = getDependencyWarnings(wf, mockCtx({ "sandbox-exec": commandHandler }));
    expect(warnings).toEqual([]);
  });

  test("flags an unavailable custom step type without attempting config validation", () => {
    const wf: DagWorkflowDefinition = {
      name: "missing-type",
      trigger: { type: "manual" },
      steps: { convert: { type: "sandbox-exec", command: ["a"] } as never },
      edges: [],
    };

    // No handler registered for the type.
    const warnings = getDependencyWarnings(wf, mockCtx({}));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.field).toBe("type");
    expect(warnings[0]!.message).toContain("disabled");
  });

  describe("validateConfig", () => {
    /** A handler that rejects `token` combined with `mode: "anonymous"`. */
    const seen: Record<string, unknown>[] = [];
    const modeHandler: StepTypeHandler = {
      schema: Type.Object({ mode: Type.Optional(Type.String()), token: Type.Optional(Type.String()) }),
      label: "Mode",
      validateConfig: (config) => {
        seen.push(config);
        return config.mode === "anonymous" && config.token
          ? [{ field: "token", message: "token is ignored in anonymous mode" }]
          : [];
      },
      execute: async () => ({}),
    };

    /** Builds a one-step workflow of the `mode` type. */
    function wf(step: Record<string, unknown>): DagWorkflowDefinition {
      return { name: "wf", trigger: { type: "manual" }, steps: { s: { type: "mode", ...step } as never }, edges: [] };
    }

    test("reports the handler's issues with the step and field", () => {
      const warnings = getDependencyWarnings(wf({ mode: "anonymous", token: "x" }), mockCtx({ mode: modeHandler }));
      expect(warnings.map((w) => [w.stepSlug, w.field, w.message])).toEqual([
        ["s", "token", 'Invalid "mode" step config: token is ignored in anonymous mode'],
      ]);
    });

    test("passes only the config fields and accepts a consistent config", () => {
      seen.length = 0;
      expect(
        getDependencyWarnings(wf({ mode: "anonymous", outputSchema: {} }), mockCtx({ mode: modeHandler })),
      ).toEqual([]);
      expect(seen).toEqual([{ mode: "anonymous" }]);
    });

    test("is skipped when the config already fails the schema", () => {
      seen.length = 0;
      const warnings = getDependencyWarnings(wf({ mode: 1, token: "x" }), mockCtx({ mode: modeHandler }));
      expect(warnings.map((w) => w.field)).toEqual(["mode"]);
      expect(seen).toEqual([]);
    });

    test("ignores a check that throws", () => {
      const throwing: StepTypeHandler = {
        ...modeHandler,
        validateConfig: () => {
          throw new Error("bug");
        },
      };
      expect(getDependencyWarnings(wf({ mode: "x" }), mockCtx({ mode: throwing }))).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// getTriggerRefWarnings
// ---------------------------------------------------------------------------

describe("getTriggerRefWarnings", () => {
  const refs: TriggerRefLookup = { webhook: ["incoming"], schedule: ["nightly"], filewatcher: null };

  /** Builds a minimal workflow with the given trigger. */
  function wf(trigger: DagWorkflowDefinition["trigger"]): DagWorkflowDefinition {
    return { name: "wf", trigger, steps: { a: { type: "agent", prompt: "Hi" } }, edges: [] };
  }

  test("returns no warnings for a manual trigger", () => {
    expect(getTriggerRefWarnings(wf({ type: "manual" }), refs)).toEqual([]);
  });

  test("returns no warnings when the ref exists", () => {
    expect(getTriggerRefWarnings(wf({ type: "webhook", ref: "incoming" }), refs)).toEqual([]);
    expect(getTriggerRefWarnings(wf({ type: "schedule", ref: "nightly" }), refs)).toEqual([]);
  });

  test("warns on the trigger node when the ref does not exist", () => {
    expect(getTriggerRefWarnings(wf({ type: "webhook", ref: "deleted" }), refs)).toEqual([
      { stepSlug: "__trigger__", field: "ref", message: 'Webhook "deleted" does not exist' },
    ]);
  });

  test("warns when a non-manual trigger has no ref", () => {
    expect(getTriggerRefWarnings(wf({ type: "schedule" }), refs)).toEqual([
      { stepSlug: "__trigger__", field: "ref", message: "Schedule trigger has no ref" },
    ]);
  });

  test("does not report refs whose lookup failed", () => {
    expect(getTriggerRefWarnings(wf({ type: "filewatcher", ref: "anything" }), refs)).toEqual([]);
  });

  test("checks a portal trigger's run-as binding instead of a ref", () => {
    const portal = wf({ type: "portal", portal: { title: "Receipts" } });
    expect(getTriggerRefWarnings(portal, refs)).toEqual([]);
    expect(getTriggerRefWarnings(portal, refs, () => ({ username: "joe", usable: true }))).toEqual([]);
    expect(getTriggerRefWarnings(portal, refs, () => null)).toEqual([
      {
        stepSlug: "__trigger__",
        field: "runAs",
        message: "Portal trigger has no run-as account: save the workflow in the editor to bind it",
      },
    ]);
    expect(getTriggerRefWarnings(portal, refs, () => ({ username: "joe", usable: false }))[0]?.message).toBe(
      'Run-as account "joe" is disabled or not an operator account',
    );
  });

  describe("extension trigger types", () => {
    const feeds: TriggerTypeDefinition = { label: "Feed item", refs: () => ["news"] };
    const updates: TriggerTypeDefinition = { label: "Extension update" };
    const lookup = (type: string) => ({ "feed-item": feeds, "extension-update": updates })[type];
    const extRefs: TriggerRefLookup = { ...refs, "feed-item": ["news"] };

    test("warns when no active extension registers the type", () => {
      expect(getTriggerRefWarnings(wf({ type: "gone-away" }), extRefs, undefined, lookup)).toEqual([
        {
          stepSlug: "__trigger__",
          field: "type",
          message: 'Trigger type "gone-away" is not registered by any active extension: the workflow does not start',
        },
      ]);
    });

    test("skips the registration check without a lookup", () => {
      expect(getTriggerRefWarnings(wf({ type: "gone-away" }), extRefs)).toEqual([]);
    });

    test("a type without refs needs no ref", () => {
      expect(getTriggerRefWarnings(wf({ type: "extension-update" }), extRefs, undefined, lookup)).toEqual([]);
    });

    test("a type with refs checks the ref against its list", () => {
      expect(getTriggerRefWarnings(wf({ type: "feed-item", ref: "news" }), extRefs, undefined, lookup)).toEqual([]);
      expect(getTriggerRefWarnings(wf({ type: "feed-item", ref: "old" }), extRefs, undefined, lookup)).toEqual([
        { stepSlug: "__trigger__", field: "ref", message: 'Feed item "old" does not exist' },
      ]);
      expect(getTriggerRefWarnings(wf({ type: "feed-item" }), extRefs, undefined, lookup)).toEqual([
        { stepSlug: "__trigger__", field: "ref", message: "Feed item trigger has no ref" },
      ]);
    });

    test("does not check a ref whose list is unknown", () => {
      expect(getTriggerRefWarnings(wf({ type: "feed-item", ref: "old" }), refs, undefined, lookup)).toEqual([]);
    });
  });
});

describe("triggerRefMode", () => {
  const lookup = (type: string): TriggerTypeDefinition | undefined =>
    type === "with-refs" ? { label: "A", refs: () => [] } : type === "no-refs" ? { label: "B" } : undefined;

  test("classifies built-in and extension trigger types", () => {
    expect(triggerRefMode("webhook", lookup)).toBe("required");
    expect(triggerRefMode("schedule", lookup)).toBe("required");
    expect(triggerRefMode("filewatcher", lookup)).toBe("required");
    expect(triggerRefMode("manual", lookup)).toBe("none");
    expect(triggerRefMode("portal", lookup)).toBe("none");
    expect(triggerRefMode("with-refs", lookup)).toBe("required");
    expect(triggerRefMode("no-refs", lookup)).toBe("none");
    expect(triggerRefMode("unknown", lookup)).toBe("unknown");
  });
});

describe("fetchExtensionTriggerRefs", () => {
  test("lists the sorted refs of types that declare them; a failing list is unknown", async () => {
    const defs: Record<string, TriggerTypeDefinition> = {
      sorted: { label: "S", refs: async () => ["b", "a"] },
      broken: {
        label: "X",
        refs: () => {
          throw new Error("down");
        },
      },
      plain: { label: "P" },
    };
    const registry = {
      get: (type: string) => defs[type],
      list: () =>
        Object.entries(defs).map(([type, d]) => ({
          type,
          label: d.label,
          extensionName: "ext",
          hasRefs: typeof d.refs === "function",
        })),
    };
    expect(await fetchExtensionTriggerRefs(registry)).toEqual({ sorted: ["a", "b"], broken: null });
  });
});

describe("getDependencyWarnings (humanTask)", () => {
  function mockCtx(withHitl: boolean): ExtensionContext {
    return {
      tools: { names: () => [] },
      skills: { names: () => [] },
      stepTypes: { get: () => undefined },
      internal: withHitl ? { hitl: {} } : {},
    } as unknown as ExtensionContext;
  }

  function wf(review: Record<string, unknown>): DagWorkflowDefinition {
    return { name: "ht", trigger: { type: "manual" }, steps: { review: review as never }, edges: [] };
  }

  test("a valid humanTask step has no warnings", () => {
    const warnings = getDependencyWarnings(
      wf({ type: "humanTask", title: "Approve", assignees: { roles: ["accounting"] } }),
      mockCtx(true),
    );
    expect(warnings).toEqual([]);
  });

  test("warns when human tasks are disabled", () => {
    const warnings = getDependencyWarnings(
      wf({ type: "humanTask", title: "Approve", assignees: { users: ["a"] } }),
      mockCtx(false),
    );
    expect(warnings.some((w) => w.message.includes("disabled"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Automatic starts: event triggers and dispatch from other workflows
// ---------------------------------------------------------------------------

describe("automatic starts skip drafts and disabled workflows", () => {
  /** Builds a webhook-triggered workflow with the given flags. */
  function hooked(name: string, extra: Partial<DagWorkflowDefinition> = {}): DagWorkflowDefinition {
    return {
      name,
      trigger: { type: "webhook", ref: "hook" },
      steps: { a: { type: "agent", prompt: "Go" } },
      edges: [],
      ...extra,
    };
  }

  const live = hooked("live");
  const explicitlyLive = hooked("explicit", { enabled: true, draft: false });
  const draft = hooked("draft", { draft: true });
  const disabled = hooked("off", { enabled: false });
  const other = { ...hooked("other"), trigger: { type: "webhook" as const, ref: "elsewhere" } };

  test("an event trigger starts only the live workflows with a matching ref", () => {
    const started = workflowsForTrigger([live, explicitlyLive, draft, disabled, other], "webhook", "hook");
    expect(started.map((w) => w.name)).toEqual(["live", "explicit"]);
  });

  test("an event of another trigger type starts nothing", () => {
    expect(workflowsForTrigger([live], "schedule", "hook")).toEqual([]);
  });

  test("a trigger type without refs starts every live workflow of the type", () => {
    const ext = (name: string, extra: Partial<DagWorkflowDefinition> = {}) => ({
      ...hooked(name, extra),
      trigger: { type: "extension-update" },
    });
    const started = workflowsForTrigger(
      [ext("a"), ext("b"), ext("c", { draft: true }), live],
      "extension-update",
      undefined,
    );
    expect(started.map((w) => w.name)).toEqual(["a", "b"]);
  });

  test("dispatch from another workflow returns a live workflow", () => {
    expect(resolveDispatchTarget(live, "live")).toBe(live);
  });

  test("dispatch refuses a draft", () => {
    expect(() => resolveDispatchTarget(draft, "draft")).toThrow("Workflow is a draft: draft");
  });

  test("a start-workflow step that targets a draft is warned about", () => {
    const caller: DagWorkflowDefinition = {
      name: "caller",
      trigger: { type: "manual" },
      steps: {
        "to-draft": { type: "start-workflow", workflowName: "draft" },
        "to-live": { type: "start-workflow", workflowName: "live" },
        "to-missing": { type: "start-workflow", workflowName: "nope" },
        templated: { type: "start-workflow", workflowName: "{{trigger.payload.name}}" },
        other: { type: "agent", prompt: "draft" },
      },
      edges: [],
    };
    const loaded = new Map([live, draft].map((w) => [w.name, w]));
    expect(getDraftTargetWarnings(caller, (n) => loaded.get(n))).toEqual([
      {
        stepSlug: "to-draft",
        field: "workflowName",
        message: 'Workflow "draft" is a draft: this step fails until it is activated',
      },
    ]);
  });

  test("dispatch refuses a disabled workflow and a missing one", () => {
    expect(() => resolveDispatchTarget(disabled, "off")).toThrow("Workflow is disabled: off");
    expect(() => resolveDispatchTarget(undefined, "nope")).toThrow("Workflow not found: nope");
    expect(() =>
      resolveDispatchTarget(undefined, "broken", {
        file: "broken.json5",
        name: "broken",
        error: "/edges: Expected array",
      }),
    ).toThrow('Workflow "broken" is not loaded because broken.json5 is invalid: /edges: Expected array');
  });
});
