/**
 * Tests for the workflows extension utility functions (DAG model).
 */

import { describe, expect, test } from "bun:test";
import type { ExtensionContext, StepTypeHandler } from "@ext/types";
import { Type } from "@sinclair/typebox";
import type { DagWorkflowDefinition } from "./schemas";
import { buildStepJobIdMap } from "./stepJobs";
import { getTriggerRefWarnings, type TriggerRefLookup } from "./triggerRefs";
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

  test("flags an invalid humanTask step instead of letting the generic schema accept it", () => {
    const warnings = getDependencyWarnings(
      wf({ type: "humanTask", title: "Approve", assignees: {}, onTimeout: "later" }),
      mockCtx(true),
    );
    expect(warnings.some((w) => w.stepSlug === "review" && w.message.includes("humanTask"))).toBe(true);
  });

  test("reports a missing field once", () => {
    const warnings = getDependencyWarnings(wf({ type: "humanTask", assignees: { users: ["a"] } }), mockCtx(true));
    expect(warnings.filter((w) => w.field === "title")).toHaveLength(1);
  });

  test("warns when human tasks are disabled", () => {
    const warnings = getDependencyWarnings(
      wf({ type: "humanTask", title: "Approve", assignees: { users: ["a"] } }),
      mockCtx(false),
    );
    expect(warnings.some((w) => w.message.includes("disabled"))).toBe(true);
  });
});
