import { describe, expect, test } from "bun:test";
import { analyzeWorkflowGraph, edgeId, type TopologyEdge, type TopologyStep } from "./workflowTopology";

const agent = (slug: string): TopologyStep => ({ slug, type: "agent" });
const e = (from: string, to: string, branch?: string): TopologyEdge => (branch ? { from, to, branch } : { from, to });
const sorted = (set: Iterable<string>) => [...set].sort();

/** a -> if(then: b, else: c) -> join */
const diamond = analyzeWorkflowGraph(
  [agent("a"), { slug: "check", type: "if" }, agent("b"), agent("c"), agent("join")],
  [e("a", "check"), e("check", "b", "then"), e("check", "c", "else"), e("b", "join"), e("c", "join")],
);

/** start -> loop(each: fetch -> parse) -> collect -> done, with a side exit fetch -> notify */
const loop = analyzeWorkflowGraph(
  [
    agent("start"),
    { slug: "loop", type: "iterator" },
    agent("fetch"),
    agent("parse"),
    agent("notify"),
    { slug: "collect", type: "aggregator", iterator: "loop" },
    agent("done"),
  ],
  [
    e("start", "loop"),
    e("loop", "fetch", "each"),
    e("fetch", "parse"),
    e("fetch", "notify"),
    e("parse", "collect"),
    e("collect", "done"),
  ],
);

describe("edgeId", () => {
  test.each([
    ["a", "b", undefined, "a:b"],
    ["a", "b", "then", "a:b:then"],
  ])("%s -> %s (%s)", (from, to, branch, id) => {
    expect(edgeId(from, to, branch)).toBe(id);
  });
});

describe("structure", () => {
  test("roots, terminals and adjacency", () => {
    expect(diamond.roots).toEqual(["a"]);
    expect(diamond.terminals).toEqual(["join"]);
    expect(diamond.incoming("join").map((x) => x.from)).toEqual(["b", "c"]);
    expect(diamond.outgoing("check").map((x) => x.branch)).toEqual(["then", "else"]);
    expect(diamond.outgoing("unknown")).toEqual([]);
  });

  test("multiple roots and terminals keep input order", () => {
    const g = analyzeWorkflowGraph([agent("x"), agent("y"), agent("z")], [e("x", "z"), e("y", "z")]);
    expect(g.roots).toEqual(["x", "y"]);
    expect(g.terminals).toEqual(["z"]);
  });

  test("accepts a slug-keyed step record", () => {
    const g = analyzeWorkflowGraph(
      { l: { type: "iterator" }, b: { type: "agent" }, agg: { type: "aggregator", iterator: "l" } as { type: string } },
      [e("l", "b", "each"), e("b", "agg")],
    );
    expect(g.typeOf("agg")).toBe("aggregator");
    expect(g.aggregatorOf("l")).toBe("agg");
  });
});

describe("ancestors and dominators", () => {
  test.each([
    // [step, ancestors, dominators]
    ["a", [], ["a"]],
    ["b", ["a", "check"], ["a", "b", "check"]],
    ["join", ["a", "b", "c", "check"], ["a", "check", "join"]],
  ])("%s", (slug, ancestors, dominators) => {
    expect(sorted(diamond.ancestors(slug))).toEqual(ancestors);
    expect(sorted(diamond.dominators(slug))).toEqual(dominators);
  });

  test.each([
    ["a", "join", true],
    ["check", "join", true],
    ["b", "join", false], // on a skippable branch
    ["join", "a", false], // runs later
    ["join", "join", false], // not before itself
  ])("runsBefore(%s, %s) = %s", (ref, slug, expected) => {
    expect(diamond.runsBefore(ref, slug)).toBe(expected);
  });

  test("a rootless cycle has no preceding steps, although every step dominates it", () => {
    const g = analyzeWorkflowGraph([agent("p"), agent("q"), agent("r")], [e("p", "q"), e("q", "p")]);
    expect(g.dominators("p").has("r")).toBe(true);
    expect(g.runsBefore("r", "p")).toBe(false);
    expect(g.runsBefore("q", "p")).toBe(true);
  });

  test("no edges: every step is a root and nothing runs before another", () => {
    const g = analyzeWorkflowGraph([agent("a"), agent("b")], []);
    expect(g.roots).toEqual(["a", "b"]);
    expect(g.runsBefore("a", "b")).toBe(false);
  });
});

describe("execution order", () => {
  test("topological with input order among ready steps", () => {
    const g = analyzeWorkflowGraph([agent("late"), agent("root"), agent("mid")], [e("root", "mid"), e("mid", "late")]);
    expect(g.executionOrder()).toEqual(["root", "mid", "late"]);
  });

  test("cycle members come last in input order", () => {
    const g = analyzeWorkflowGraph([agent("p"), agent("q"), agent("s")], [e("p", "q"), e("q", "p")]);
    expect(g.executionOrder()).toEqual(["s", "p", "q"]);
  });
});

describe("iterator body", () => {
  test("body excludes a side exit that never reaches the aggregator", () => {
    const body = loop.iteratorBody("loop")!;
    expect(body.aggregator).toBe("collect");
    expect(sorted(body.steps)).toEqual(["fetch", "parse"]);
    expect(body.terminals).toEqual(["parse"]);
    expect(body.edges.map((x) => edgeId(x.from, x.to, x.branch)).sort()).toEqual([
      "fetch:parse",
      "loop:fetch:each",
      "parse:collect",
    ]);
  });

  test.each([
    ["fetch", "loop"],
    ["parse", "loop"],
    ["notify", undefined],
    ["collect", undefined],
    ["start", undefined],
    ["done", undefined],
  ])("enclosingIterator(%s) = %s", (slug, iterator) => {
    expect(loop.enclosingIterator(slug)).toBe(iterator);
  });

  test("an iterator without aggregator has no body", () => {
    const g = analyzeWorkflowGraph([{ slug: "l", type: "iterator" }, agent("b")], [e("l", "b", "each")]);
    expect(g.iteratorBody("l")).toBeNull();
    expect(g.enclosingIterator("b")).toBeUndefined();
  });

  test("non-each edges do not start a body", () => {
    const g = analyzeWorkflowGraph(
      [{ slug: "l", type: "iterator" }, agent("b"), { slug: "agg", type: "aggregator", iterator: "l" }],
      [e("l", "b"), e("b", "agg")],
    );
    expect(g.iteratorBody("l")!.steps.size).toBe(0);
  });

  test("terminals of a fan-out body", () => {
    const g = analyzeWorkflowGraph(
      [{ slug: "l", type: "iterator" }, agent("x"), agent("y"), { slug: "agg", type: "aggregator", iterator: "l" }],
      [e("l", "x", "each"), e("l", "y", "each"), e("x", "agg"), e("y", "agg")],
    );
    expect(sorted(g.iteratorBody("l")!.terminals)).toEqual(["x", "y"]);
  });
});

describe("dead steps", () => {
  const sort = analyzeWorkflowGraph(
    [{ slug: "sort", type: "case" }, agent("a"), agent("a2"), agent("b"), agent("c"), agent("join")],
    [e("sort", "a", "x"), e("sort", "b", "y"), e("sort", "c", "z"), e("a", "a2"), e("a2", "join"), e("b", "join")],
  );

  test.each([
    [{}, []],
    [{ sort: "y" }, ["a", "a2", "c"]], // join stays alive through b
    [{ sort: "x" }, ["b", "c"]],
    [{ sort: "none" }, ["a", "a2", "b", "c", "join"]],
  ])("chosen %o", (chosen, dead) => {
    expect(sorted(sort.deadSteps(chosen))).toEqual(dead);
  });

  test("inherited object keys are not chosen branches", () => {
    expect(sort.deadSteps(Object.create({ sort: "y" })).size).toBe(0);
  });
});

describe("half-built drafts", () => {
  test("duplicate slugs keep the first step; edges to unknown steps are ignored", () => {
    const g = analyzeWorkflowGraph(
      [{ slug: "a", type: "agent" }, { slug: "a", type: "if" }, agent("b"), { slug: "" }],
      [e("a", "b"), e("b", "ghost"), e("ghost", "a")],
    );
    expect(g.slugs).toEqual(["a", "b", ""]);
    expect(g.typeOf("a")).toBe("agent");
    expect(g.edges).toEqual([e("a", "b")]);
    expect(g.terminals).toEqual(["b", ""]);
  });

  test("non-string types are unknown", () => {
    const g = analyzeWorkflowGraph([{ slug: "a", type: 3 }], []);
    expect(g.typeOf("a")).toBeUndefined();
  });
});
