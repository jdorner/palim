/**
 * Tests for the run kernel: state in, patch and effects out. No database,
 * queue or broadcast recorder - every graph rule is checked on plain data.
 */

import { describe, expect, test } from "bun:test";
import { edgeId } from "@shared/workflowTopology";
import type { DagRunStatus, EdgeState, StepStatus } from "./runKernel";
import {
  advance,
  classifyIncomingEdges,
  type IterationState,
  isActiveRunStatus,
  type RunEffect,
  type RunEvent,
  type RunState,
} from "./runKernel";
import type { DagWorkflowDefinition, Edge } from "./schemas";

type Steps = DagWorkflowDefinition["steps"];

const agent = { type: "agent", prompt: "x" } as Steps[string];

function wf(steps: Steps, edges: Edge[]): DagWorkflowDefinition {
  return { name: "wf", trigger: { type: "manual" }, steps, edges };
}

/** A run of `def` with every step pending and every edge pending, then the given overrides. */
function runOf(
  def: DagWorkflowDefinition,
  overrides: {
    status?: DagRunStatus;
    steps?: Record<string, StepStatus>;
    edges?: Record<string, EdgeState>;
    results?: Record<string, unknown>;
  } = {},
): RunState {
  return {
    id: "run",
    workflowName: def.name,
    status: overrides.status ?? "running",
    stepStatuses: { ...Object.fromEntries(Object.keys(def.steps).map((s) => [s, "pending"])), ...overrides.steps },
    edgeStates: {
      ...Object.fromEntries(def.edges.map((e) => [edgeId(e.from, e.to, e.branch), "pending"])),
      ...overrides.edges,
    },
    stepResults: overrides.results ?? {},
  };
}

const work = (effects: RunEffect[]) =>
  effects.filter((e) => e.type === "dispatch" || e.type === "evaluate" || e.type === "register");
const broadcasts = (effects: RunEffect[]) =>
  effects.flatMap((e) =>
    e.type === "broadcast" ? [e.event.type + ("stepSlug" in e.event ? `:${e.event.stepSlug}` : "")] : [],
  );

/** Applies events in sequence, feeding each patch into the next state. */
function replay(def: DagWorkflowDefinition, run: RunState, events: RunEvent[]) {
  let state = run;
  const effects: RunEffect[] = [];
  for (const event of events) {
    const { patch, effects: next } = advance(state, def, event);
    state = {
      ...state,
      status: patch.status ?? state.status,
      stepStatuses: { ...state.stepStatuses, ...patch.stepStatuses },
      edgeStates: { ...state.edgeStates, ...patch.edgeStates },
      stepResults: { ...state.stepResults, ...patch.stepResults },
    };
    effects.push(...next);
  }
  return { state, effects };
}

describe("join barrier", () => {
  const def = wf({ a: agent, b: agent, c: agent }, [
    { from: "a", to: "c" },
    { from: "b", to: "c" },
  ]);

  test("fan-in waits for every incoming edge", () => {
    const { patch, effects } = advance(runOf(def, { steps: { a: "running", b: "running" } }), def, {
      type: "stepCompleted",
      slug: "a",
      result: "A",
    });
    expect(patch.stepStatuses).toEqual({ a: "completed" });
    expect(patch.edgeStates).toEqual({ "a:c": "satisfied" });
    expect(patch.stepResults).toEqual({ a: "A" });
    expect(work(effects)).toEqual([]);
  });

  test("the last edge releases the join", () => {
    const run = runOf(def, { steps: { a: "completed", b: "running" }, edges: { "a:c": "satisfied" } });
    const { patch, effects } = advance(run, def, { type: "stepCompleted", slug: "b", result: "B" });
    expect(patch.stepStatuses).toEqual({ b: "completed", c: "running" });
    expect(work(effects)).toEqual([{ type: "dispatch", slug: "c" }]);
  });

  test("a join fed by one dead and one satisfied edge is ready", () => {
    const run = runOf(def, { steps: { a: "dead", b: "running" }, edges: { "a:c": "dead" } });
    const { effects } = advance(run, def, { type: "stepCompleted", slug: "b", result: "B" });
    expect(work(effects)).toEqual([{ type: "dispatch", slug: "c" }]);
  });
});

describe("branches", () => {
  // check -> then: t1 -> t2 -> join ; else: e1 -> join
  const def = wf(
    {
      check: { type: "if", condition: { ref: "{{trigger.payload}}", equals: "yes" } } as Steps[string],
      t1: agent,
      t2: agent,
      e1: agent,
      join: agent,
    },
    [
      { from: "check", to: "t1", branch: "then" },
      { from: "check", to: "e1", branch: "else" },
      { from: "t1", to: "t2" },
      { from: "t2", to: "join" },
      { from: "e1", to: "join" },
    ],
  );

  test("the taken branch runs, the other dies, the join waits for the live one", () => {
    const { patch, effects } = advance(runOf(def, { steps: { check: "running" } }), def, {
      type: "ifEvaluated",
      slug: "check",
      condition: false,
      value: "no",
    });
    expect(patch.stepResults.check).toEqual({ condition: false, chosenBranch: "else", value: "no" });
    expect(patch.stepStatuses).toEqual({ check: "completed", t1: "dead", t2: "dead", e1: "running" });
    expect(patch.edgeStates).toEqual({
      "check:t1:then": "dead",
      "check:e1:else": "satisfied",
      "t1:t2": "dead",
      "t2:join": "dead",
    });
    expect(work(effects)).toEqual([{ type: "dispatch", slug: "e1" }]);
    expect(broadcasts(effects)).toEqual([
      "workflow_step_completed:check",
      "workflow_step_dead:t1",
      "workflow_step_dead:t2",
    ]);
  });

  test("a branch without edges ends the run with dead terminals", () => {
    const small = wf({ check: { type: "if", condition: { ref: "x", equals: "y" } } as Steps[string], t: agent }, [
      { from: "check", to: "t", branch: "then" },
    ]);
    const { patch, effects } = advance(runOf(small, { steps: { check: "running" } }), small, {
      type: "ifEvaluated",
      slug: "check",
      condition: false,
      value: null,
    });
    expect(patch.status).toBe("completed");
    expect(broadcasts(effects).at(-1)).toBe("workflow_completed");
  });

  describe("case", () => {
    const caseDef = (extra: Partial<{ default: string }> = {}, edges: Edge[] = []) =>
      wf(
        {
          route: { type: "case", match: "{{x}}", paths: ["a", "b"], ...extra } as Steps[string],
          a: agent,
          b: agent,
          other: agent,
        },
        [{ from: "route", to: "a", branch: "a" }, { from: "route", to: "b", branch: "b" }, ...edges],
      );

    test.each([
      ["matching path", caseDef(), "b", "b", false],
      [
        "named default",
        caseDef({ default: "other" }, [{ from: "route", to: "other", branch: "other" }]),
        "zzz",
        "other",
        true,
      ],
      ["literal default edge", caseDef({}, [{ from: "route", to: "other", branch: "default" }]), "zzz", "other", true],
    ])("%s", (_name, def, value, target, fallback) => {
      const { patch, effects } = advance(runOf(def, { steps: { route: "running" } }), def, {
        type: "caseEvaluated",
        slug: "route",
        value,
      });
      expect((patch.stepResults.route as { fallback: boolean }).fallback).toBe(fallback);
      expect(work(effects)).toEqual([{ type: "dispatch", slug: target }]);
    });

    test("no match and no default fails the run and sweeps open steps", () => {
      const def = caseDef();
      const { patch, effects } = advance(runOf(def, { steps: { route: "running" } }), def, {
        type: "caseEvaluated",
        slug: "route",
        value: "zzz",
      });
      expect(patch.status).toBe("failed");
      expect(patch.failureReason).toContain('no path matched "zzz"');
      expect(patch.stepStatuses).toEqual({ route: "failed", a: "dead", b: "dead", other: "dead" });
      expect(broadcasts(effects)[0]).toBe("workflow_failed");
    });
  });
});

describe("iterator and aggregator", () => {
  // loop -each-> fetch -> parse -> collect -> after
  const def = wf(
    {
      loop: { type: "iterator", items: "{{trigger.payload}}", as: "url" } as Steps[string],
      fetch: agent,
      parse: agent,
      collect: { type: "aggregator", iterator: "loop" } as Steps[string],
      after: agent,
    },
    [
      { from: "loop", to: "fetch", branch: "each" },
      { from: "fetch", to: "parse" },
      { from: "parse", to: "collect" },
      { from: "collect", to: "after" },
    ],
  );

  test("runs the body once per item, collecting each body step's result", () => {
    const { state, effects } = replay(def, runOf(def, { steps: { loop: "running" } }), [
      { type: "iteratorEvaluated", slug: "loop", items: ["u1", "u2"] },
      { type: "stepCompleted", slug: "fetch", result: "f1" },
      { type: "stepCompleted", slug: "parse", result: "p1" },
      { type: "stepCompleted", slug: "fetch", result: "f2" },
      { type: "stepCompleted", slug: "parse", result: "p2" },
    ]);
    expect(work(effects)).toEqual([
      { type: "dispatch", slug: "fetch" },
      { type: "dispatch", slug: "parse" },
      { type: "dispatch", slug: "fetch" },
      { type: "dispatch", slug: "parse" },
      { type: "dispatch", slug: "after" },
    ]);
    expect((state.stepResults.loop as IterationState).cursor).toBe(2);
    expect(state.stepResults.collect).toEqual({
      results: [
        { fetch: "f1", parse: "p1" },
        { fetch: "f2", parse: "p2" },
      ],
      totalItems: 2,
      succeeded: 2,
      failed: 0,
    });
    expect(state.stepStatuses.collect).toBe("completed");
  });

  test("between passes the body, its edges and the aggregator are reset", () => {
    const run = runOf(def, {
      steps: { loop: "completed", fetch: "completed", parse: "running" },
      edges: { "loop:fetch:each": "satisfied", "fetch:parse": "satisfied" },
      results: { loop: { items: [1, 2], cursor: 0, iterationResults: [], as: "url" } satisfies IterationState },
    });
    const { patch, effects } = advance(run, def, { type: "stepCompleted", slug: "parse", result: "p1" });
    expect(patch.stepStatuses).toEqual({ parse: "pending", collect: "pending", fetch: "running" });
    expect(patch.edgeStates).toEqual({
      "loop:fetch:each": "satisfied",
      "fetch:parse": "pending",
      "parse:collect": "pending",
    });
    expect(work(effects)).toEqual([{ type: "dispatch", slug: "fetch" }]);
  });

  test("an empty array completes the aggregator without running the body", () => {
    const { patch, effects } = advance(runOf(def, { steps: { loop: "running" } }), def, {
      type: "iteratorEvaluated",
      slug: "loop",
      items: [],
    });
    expect(patch.stepStatuses).toEqual({ loop: "completed", collect: "completed", after: "running" });
    expect(patch.stepResults.collect).toEqual({ results: [], totalItems: 0, succeeded: 0, failed: 0 });
    expect(work(effects)).toEqual([{ type: "dispatch", slug: "after" }]);
  });

  test("each pass records every body step that ran, and only those", () => {
    // loop -each-> classify -> route -case-> a | b | c -> collect
    const branched = wf(
      {
        loop: { type: "iterator", items: "{{trigger.payload}}", as: "mail" } as Steps[string],
        classify: agent,
        route: { type: "case", match: "{{x}}", paths: ["a", "b"], default: "c" } as Steps[string],
        a: agent,
        b: agent,
        c: agent,
        collect: { type: "aggregator", iterator: "loop" } as Steps[string],
      },
      [
        { from: "loop", to: "classify", branch: "each" },
        { from: "classify", to: "route" },
        { from: "route", to: "a", branch: "a" },
        { from: "route", to: "b", branch: "b" },
        { from: "route", to: "c", branch: "c" },
        { from: "a", to: "collect" },
        { from: "b", to: "collect" },
        { from: "c", to: "collect" },
      ],
    );
    const pass = (n: number, value: string): RunEvent[] => [
      { type: "stepCompleted", slug: "classify", result: { category: value, n } },
      { type: "caseEvaluated", slug: "route", value },
      { type: "stepCompleted", slug: value === "a" || value === "b" ? value : "c", result: `${value}${n}` },
    ];
    const { state } = replay(branched, runOf(branched, { steps: { loop: "running" } }), [
      { type: "iteratorEvaluated", slug: "loop", items: [1, 2, 3] },
      ...pass(1, "a"),
      ...pass(2, "b"),
      ...pass(3, "zzz"),
    ]);
    const results = (state.stepResults.collect as { results: Record<string, unknown>[] }).results;
    expect(results.map((r) => Object.keys(r).sort())).toEqual([
      ["a", "classify", "route"],
      ["b", "classify", "route"],
      ["c", "classify", "route"],
    ]);
    expect(results.map((r) => r.classify)).toEqual([
      { category: "a", n: 1 },
      { category: "b", n: 2 },
      { category: "zzz", n: 3 },
    ]);
    expect(results.map((r) => r.a ?? r.b ?? r.c)).toEqual(["a1", "b2", "zzz3"]);
    expect(state.stepStatuses.collect).toBe("completed");
  });

  test("a missing iteration state fails the run and drops work started in the same transition", () => {
    // a completes: b is dispatched first, then the aggregator finds no iterator state.
    const broken = wf(
      {
        a: agent,
        b: agent,
        loop: { type: "iterator", items: "[]" } as Steps[string],
        collect: { type: "aggregator", iterator: "loop" } as Steps[string],
      },
      [
        { from: "a", to: "b" },
        { from: "a", to: "collect" },
        { from: "loop", to: "collect", branch: "each" },
      ],
    );
    const run = runOf(broken, {
      steps: { a: "running", loop: "completed" },
      edges: { "loop:collect:each": "satisfied" },
    });
    const { patch, effects } = advance(run, broken, { type: "stepCompleted", slug: "a", result: 1 });
    expect(patch.status).toBe("failed");
    expect(patch.stepStatuses.collect).toBe("failed");
    expect(patch.stepStatuses.b).toBe("dead");
    expect(work(effects)).toEqual([]);
  });
});

describe("inline nodes", () => {
  const def = wf(
    {
      wait: { type: "waitFor", event: "approve" } as Steps[string],
      decide: { type: "if", condition: { ref: "x", equals: "y" } } as Steps[string],
      next: agent,
    },
    [
      { from: "wait", to: "next" },
      { from: "decide", to: "next", branch: "then" },
    ],
  );

  test("starting a run activates every root: waits are registered, control flow evaluated", () => {
    const { patch, effects } = advance(runOf(def), def, { type: "runStarted" });
    expect(patch.stepStatuses).toEqual({ wait: "running", decide: "running" });
    expect(work(effects)).toEqual([
      { type: "register", slug: "wait" },
      { type: "evaluate", slug: "decide" },
    ]);
  });

  test("a registered wait pauses the step and the run", () => {
    const { patch, effects } = advance(runOf(def, { steps: { wait: "running" } }), def, {
      type: "waitRegistered",
      slug: "wait",
      event: "approve",
      inputSchema: null,
    });
    expect(patch).toMatchObject({ status: "waiting-signal", stepStatuses: { wait: "waiting-signal" } });
    expect(broadcasts(effects)).toEqual(["workflow_step_waiting:wait"]);
  });

  test("a wait registered after its step was swept changes nothing", () => {
    const run = runOf(def, { steps: { wait: "dead" } });
    const { patch } = advance(run, def, { type: "waitRegistered", slug: "wait", event: "approve", inputSchema: null });
    expect(patch).toEqual({ stepStatuses: {}, edgeStates: {}, stepResults: {} });
  });

  test.each([
    [true, "waiting-signal"],
    [false, "running"],
  ])("a signal with other waits pending=%s leaves the run %s", (otherSignalsPending, status) => {
    const run = runOf(def, { status: "waiting-signal", steps: { wait: "waiting-signal", decide: "running" } });
    const { patch } = advance(run, def, {
      type: "signalReceived",
      slug: "wait",
      payload: { ok: 1 },
      otherSignalsPending,
    });
    expect(patch.status).toBe(status as DagRunStatus);
    expect(patch.stepResults).toEqual({ wait: { ok: 1 } });
  });
});

describe("run guards", () => {
  const def = wf({ a: agent, b: agent }, [{ from: "a", to: "b" }]);

  test.each(["completed", "failed"] as const)("events on a %s run change nothing", (status) => {
    const { patch, effects } = advance(runOf(def, { status }), def, { type: "stepCompleted", slug: "a", result: 1 });
    expect(patch).toEqual({ stepStatuses: {}, edgeStates: {}, stepResults: {} });
    expect(effects.map((e) => e.type)).toEqual(["log"]);
  });

  test("a run whose definition is gone fails", () => {
    const { patch } = advance(runOf(def, { steps: { a: "running" } }), undefined, {
      type: "stepCompleted",
      slug: "a",
      result: 1,
    });
    expect(patch.status).toBe("failed");
    expect(patch.failureReason).toBe('Workflow definition "wf" no longer available');
  });

  test("a failed step sweeps pending, running and waiting steps", () => {
    const three = wf({ a: agent, b: agent, w: { type: "waitFor", event: "e" } as Steps[string], done: agent }, [
      { from: "a", to: "done" },
      { from: "b", to: "done" },
      { from: "w", to: "done" },
    ]);
    const run = runOf(three, { steps: { a: "running", b: "running", w: "waiting-signal" } });
    const { patch, effects } = advance(run, three, { type: "stepFailed", slug: "a", reason: "boom" });
    expect(patch).toMatchObject({ status: "failed", failureReason: "boom" });
    expect(patch.stepStatuses).toEqual({ a: "failed", b: "dead", w: "dead", done: "dead" });
    expect(broadcasts(effects)).toEqual([
      "workflow_failed",
      "workflow_step_dead:b",
      "workflow_step_dead:w",
      "workflow_step_dead:done",
    ]);
  });

  test("the run completes when the last terminal completes", () => {
    const run = runOf(def, { steps: { a: "completed", b: "running" }, edges: { "a:b": "satisfied" } });
    const { patch, effects } = advance(run, def, { type: "stepCompleted", slug: "b", result: 2 });
    expect(patch.status).toBe("completed");
    expect(broadcasts(effects)).toEqual(["workflow_completed"]);
  });
});

describe("classifyIncomingEdges", () => {
  test("is ready when all incoming edges are satisfied", () => {
    const states = { "a:c": "satisfied", "b:c": "satisfied" } as const;
    expect(classifyIncomingEdges(states, ["a:c", "b:c"])).toBe("ready");
  });

  test("is ready when satisfied and dead edges are mixed", () => {
    const states = { "approve:combine": "satisfied", "reject:combine": "dead" } as const;
    expect(classifyIncomingEdges(states, ["approve:combine", "reject:combine"])).toBe("ready");
  });

  test("is waiting while any incoming edge is pending", () => {
    const states = { "a:c": "satisfied", "b:c": "pending" } as const;
    expect(classifyIncomingEdges(states, ["a:c", "b:c"])).toBe("waiting");
  });

  test("is waiting when an incoming edge has no recorded state", () => {
    const states = { "a:c": "dead" } as const;
    expect(classifyIncomingEdges(states, ["a:c", "b:c"])).toBe("waiting");
  });

  test("is dead when all incoming edges are dead", () => {
    const states = { "x:z": "dead", "y:z": "dead" } as const;
    expect(classifyIncomingEdges(states, ["x:z", "y:z"])).toBe("dead");
  });

  test("is dead for an empty edge list", () => {
    expect(classifyIncomingEdges({}, [])).toBe("dead");
  });
});

describe("isActiveRunStatus", () => {
  test("running is active", () => {
    expect(isActiveRunStatus("running")).toBe(true);
  });

  test("waiting-signal is active", () => {
    expect(isActiveRunStatus("waiting-signal")).toBe(true);
  });

  test("completed is not active", () => {
    expect(isActiveRunStatus("completed")).toBe(false);
  });

  test("failed is not active", () => {
    expect(isActiveRunStatus("failed")).toBe(false);
  });
});
