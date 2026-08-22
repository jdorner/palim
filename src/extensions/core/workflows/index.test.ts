/**
 * Tests for the workflows extension utility functions (DAG model).
 */

import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@ext/types";
import { buildStepJobIdMap, validateWorkflowDependencies } from "./index";
import type { DagWorkflowDefinition } from "./schemas";

// ---------------------------------------------------------------------------
// validateWorkflowDependencies (DAG model)
// ---------------------------------------------------------------------------

describe("validateWorkflowDependencies", () => {
  /** Builds a minimal mock ExtensionContext exposing tool and skill name sets. */
  function mockCtx(extensionTools: string[], skills: string[]): ExtensionContext {
    return {
      tools: { names: () => extensionTools },
      skills: { names: () => skills },
    } as unknown as ExtensionContext;
  }

  test("returns valid when workflow has no tools or skills", () => {
    const wf: DagWorkflowDefinition = {
      name: "simple",
      trigger: { type: "manual" },
      steps: { "step-one": { type: "agent", prompt: "Hello" } },
      edges: [],
    };

    const result = validateWorkflowDependencies(wf, mockCtx([], []));
    expect(result.valid).toBe(true);
    expect(result.missingTools).toEqual([]);
    expect(result.missingSkills).toEqual([]);
  });

  test("returns valid when all tools and skills are available", () => {
    const wf: DagWorkflowDefinition = {
      name: "all-available",
      trigger: { type: "manual" },
      steps: {
        "step-one": { type: "agent", prompt: "Go", tools: ["exec", "send_telegram_message"], skills: ["wiki"] },
      },
      edges: [],
    };

    const result = validateWorkflowDependencies(wf, mockCtx(["send_telegram_message"], ["wiki"]));
    expect(result.valid).toBe(true);
    expect(result.missingTools).toEqual([]);
    expect(result.missingSkills).toEqual([]);
  });

  test("recognizes sandbox tools as available", () => {
    const wf: DagWorkflowDefinition = {
      name: "sandbox-tools",
      trigger: { type: "manual" },
      steps: {
        "step-one": {
          type: "agent",
          prompt: "Go",
          tools: ["exec", "read_file", "write_file", "list_files", "edit", "create_directory"],
        },
      },
      edges: [],
    };

    const result = validateWorkflowDependencies(wf, mockCtx([], []));
    expect(result.valid).toBe(true);
    expect(result.missingTools).toEqual([]);
  });

  test("reports missing tools across steps", () => {
    const wf: DagWorkflowDefinition = {
      name: "missing-tools",
      trigger: { type: "manual" },
      steps: {
        "step-one": { type: "agent", prompt: "Go", tools: ["exec", "nonexistent_tool"] },
        "step-two": { type: "agent", prompt: "Go", tools: ["another_missing"] },
      },
      edges: [{ from: "step-one", to: "step-two" }],
    };

    const result = validateWorkflowDependencies(wf, mockCtx([], []));
    expect(result.valid).toBe(false);
    expect(result.missingTools).toEqual(["another_missing", "nonexistent_tool"]);
    expect(result.missingSkills).toEqual([]);
  });

  test("reports missing skills", () => {
    const wf: DagWorkflowDefinition = {
      name: "missing-skills",
      trigger: { type: "manual" },
      steps: { "step-one": { type: "agent", prompt: "Go", skills: ["wiki", "nonexistent_skill"] } },
      edges: [],
    };

    const result = validateWorkflowDependencies(wf, mockCtx([], ["wiki"]));
    expect(result.valid).toBe(false);
    expect(result.missingTools).toEqual([]);
    expect(result.missingSkills).toEqual(["nonexistent_skill"]);
  });

  test("reports both missing tools and skills", () => {
    const wf: DagWorkflowDefinition = {
      name: "both-missing",
      trigger: { type: "manual" },
      steps: { "step-one": { type: "agent", prompt: "Go", tools: ["bad_tool"], skills: ["bad_skill"] } },
      edges: [],
    };

    const result = validateWorkflowDependencies(wf, mockCtx([], []));
    expect(result.valid).toBe(false);
    expect(result.missingTools).toEqual(["bad_tool"]);
    expect(result.missingSkills).toEqual(["bad_skill"]);
  });

  test("deduplicates missing items across steps", () => {
    const wf: DagWorkflowDefinition = {
      name: "duplicates",
      trigger: { type: "manual" },
      steps: {
        "step-one": { type: "agent", prompt: "Go", tools: ["missing_tool"], skills: ["missing_skill"] },
        "step-two": { type: "agent", prompt: "Go", tools: ["missing_tool"], skills: ["missing_skill"] },
      },
      edges: [{ from: "step-one", to: "step-two" }],
    };

    const result = validateWorkflowDependencies(wf, mockCtx([], []));
    expect(result.missingTools).toEqual(["missing_tool"]);
    expect(result.missingSkills).toEqual(["missing_skill"]);
  });

  test("ignores non-agent steps", () => {
    const wf: DagWorkflowDefinition = {
      name: "emit-only",
      trigger: { type: "manual" },
      steps: { notify: { type: "emit", event: "done" } },
      edges: [],
    };

    const result = validateWorkflowDependencies(wf, mockCtx([], []));
    expect(result.valid).toBe(true);
  });

  test("returns sorted results", () => {
    const wf: DagWorkflowDefinition = {
      name: "sorted",
      trigger: { type: "manual" },
      steps: {
        "step-one": { type: "agent", prompt: "Go", tools: ["z_tool", "a_tool"], skills: ["z_skill", "a_skill"] },
      },
      edges: [],
    };

    const result = validateWorkflowDependencies(wf, mockCtx([], []));
    expect(result.missingTools).toEqual(["a_tool", "z_tool"]);
    expect(result.missingSkills).toEqual(["a_skill", "z_skill"]);
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
