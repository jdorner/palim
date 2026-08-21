/**
 * Tests for the workflow migration CLI.
 *
 * Validates conversion of linear workflows, if-node workflows,
 * case-node workflows, already-migrated detection, and edge generation.
 */

import { describe, expect, test } from "bun:test";
import { convertWorkflow, isAlreadyMigrated } from "./migrateWorkflows";

describe("convertWorkflow", () => {
  test("linear workflow: converts steps array to map and generates sequential edges", () => {
    const old = {
      name: "linear-wf",
      trigger: { type: "manual" as const },
      steps: [
        { slug: "a", type: "agent", prompt: "do A" },
        { slug: "b", type: "agent", prompt: "do B" },
        { slug: "c", type: "agent", prompt: "do C" },
      ],
    };

    const result = convertWorkflow(old);

    expect(result.name).toBe("linear-wf");
    expect(Object.keys(result.steps)).toEqual(["a", "b", "c"]);
    // Slugs removed from step values
    expect(result.steps.a).toEqual({ type: "agent", prompt: "do A" });
    expect(result.steps.b).toEqual({ type: "agent", prompt: "do B" });
    // Sequential edges
    expect(result.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
  });

  test("if-node: flattens branches and generates branch + convergence edges", () => {
    const old = {
      name: "if-wf",
      trigger: { type: "manual" as const },
      steps: [
        { slug: "check", type: "agent", prompt: "check something" },
        {
          slug: "decide",
          type: "if",
          condition: { ref: "{{steps.check.result}}", eq: "yes" },
          // biome-ignore lint/suspicious/noThenProperty:  "then" is the workflow branch keyword
          then: [{ slug: "yes-action", type: "agent", prompt: "do yes" }],
          else: [{ slug: "no-action", type: "agent", prompt: "do no" }],
        },
        { slug: "finish", type: "agent", prompt: "done" },
      ],
    };

    const result = convertWorkflow(old);

    // All steps flattened into map
    expect(Object.keys(result.steps).sort()).toEqual(["check", "decide", "finish", "no-action", "yes-action"]);
    // If node has no then/else in definition
    expect(result.steps.decide).toEqual({ type: "if", condition: { ref: "{{steps.check.result}}", eq: "yes" } });
    // Check edges
    expect(result.edges).toContainEqual({ from: "check", to: "decide" });
    expect(result.edges).toContainEqual({ from: "decide", to: "yes-action", branch: "then" });
    expect(result.edges).toContainEqual({ from: "decide", to: "no-action", branch: "else" });
    // Convergence edges
    expect(result.edges).toContainEqual({ from: "yes-action", to: "finish" });
    expect(result.edges).toContainEqual({ from: "no-action", to: "finish" });
  });

  test("if-node with multi-step branches", () => {
    const old = {
      name: "if-multi-wf",
      trigger: { type: "manual" as const },
      steps: [
        {
          slug: "decide",
          type: "if",
          condition: { ref: "{{trigger.payload}}", eq: "go" },
          // biome-ignore lint/suspicious/noThenProperty:  "then" is the workflow branch keyword
          then: [
            { slug: "t1", type: "agent", prompt: "then 1" },
            { slug: "t2", type: "agent", prompt: "then 2" },
          ],
          else: [{ slug: "e1", type: "agent", prompt: "else 1" }],
        },
        { slug: "end", type: "agent", prompt: "end" },
      ],
    };

    const result = convertWorkflow(old);

    // Sequential edges within then branch
    expect(result.edges).toContainEqual({ from: "t1", to: "t2" });
    // Convergence from last branch step to next main step
    expect(result.edges).toContainEqual({ from: "t2", to: "end" });
    expect(result.edges).toContainEqual({ from: "e1", to: "end" });
  });

  test("case-node: flattens paths and generates branch + convergence edges", () => {
    const old = {
      name: "case-wf",
      trigger: { type: "manual" as const },
      steps: [
        { slug: "classify", type: "agent", prompt: "classify" },
        {
          slug: "route",
          type: "case",
          match: "{{steps.classify.result}}",
          paths: {
            low: [{ slug: "handle-low", type: "agent", prompt: "low" }],
            high: [{ slug: "handle-high", type: "agent", prompt: "high" }],
          },
          default: [{ slug: "handle-default", type: "agent", prompt: "default" }],
        },
        { slug: "done", type: "agent", prompt: "done" },
      ],
    };

    const result = convertWorkflow(old);

    // All steps in map
    expect(Object.keys(result.steps).sort()).toEqual([
      "classify",
      "done",
      "handle-default",
      "handle-high",
      "handle-low",
      "route",
    ]);
    // Case node has paths as array, not object
    expect(result.steps.route).toEqual({
      type: "case",
      match: "{{steps.classify.result}}",
      paths: ["low", "high"],
      default: "default",
    });
    // Branch edges
    expect(result.edges).toContainEqual({ from: "route", to: "handle-low", branch: "low" });
    expect(result.edges).toContainEqual({ from: "route", to: "handle-high", branch: "high" });
    expect(result.edges).toContainEqual({ from: "route", to: "handle-default", branch: "default" });
    // Convergence edges
    expect(result.edges).toContainEqual({ from: "handle-low", to: "done" });
    expect(result.edges).toContainEqual({ from: "handle-high", to: "done" });
    expect(result.edges).toContainEqual({ from: "handle-default", to: "done" });
    // Sequential edge before case node
    expect(result.edges).toContainEqual({ from: "classify", to: "route" });
  });

  test("preserves description and enabled fields", () => {
    const old = {
      name: "full-wf",
      description: "A workflow with metadata",
      trigger: { type: "webhook" as const, ref: "my-hook" },
      enabled: false,
      steps: [{ slug: "a", type: "agent", prompt: "x" }],
    };

    const result = convertWorkflow(old);

    expect(result.description).toBe("A workflow with metadata");
    expect(result.enabled).toBe(false);
    expect(result.trigger).toEqual({ type: "webhook", ref: "my-hook" });
  });

  test("single-step workflow has no edges (but needs at least one for schema)", () => {
    // A single step with no successor has no edges — migration just produces the map
    const old = {
      name: "single-wf",
      trigger: { type: "manual" as const },
      steps: [{ slug: "only", type: "agent", prompt: "x" }],
    };

    const result = convertWorkflow(old);

    expect(Object.keys(result.steps)).toEqual(["only"]);
    expect(result.edges).toEqual([]);
  });
});

describe("isAlreadyMigrated", () => {
  test("returns true for DAG format (steps object + edges array)", () => {
    const dagFormat = {
      name: "test",
      steps: { a: { type: "agent", prompt: "x" } },
      edges: [{ from: "a", to: "b" }],
    };
    expect(isAlreadyMigrated(dagFormat)).toBe(true);
  });

  test("returns false for sequential format (steps array)", () => {
    const seqFormat = {
      name: "test",
      steps: [{ slug: "a", type: "agent", prompt: "x" }],
    };
    expect(isAlreadyMigrated(seqFormat)).toBe(false);
  });

  test("returns false when edges is missing", () => {
    const noEdges = {
      name: "test",
      steps: { a: { type: "agent" } },
    };
    expect(isAlreadyMigrated(noEdges)).toBe(false);
  });
});
