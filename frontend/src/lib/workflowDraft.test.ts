import { describe, expect, test } from "bun:test";
import {
  branchFromHandle,
  errorsAfterStepRemoval,
  graphEdgesToDraftEdges,
  nextStepId,
  parseSaveErrorDetails,
  reconcileConnectivityErrors,
  stepTemplate,
  toStepDraft,
  withConfigDefaults,
} from "./workflowDraft";
import { disconnectedStepError, type WorkflowDraft } from "./workflowValidation";

describe("nextStepId", () => {
  test("mints unique ids", () => {
    expect(nextStepId()).not.toBe(nextStepId());
  });
});

describe("toStepDraft", () => {
  test("keeps the synthetic id and copies agent fields", () => {
    const tools = ["a"];
    const draft = toStepDraft({ id: "node-x", slug: "s", type: "agent", prompt: "p", tools });
    expect(draft).toEqual({ id: "node-x", slug: "s", type: "agent", prompt: "p", tools: ["a"], skills: undefined });
    expect(draft.tools).not.toBe(tools);
  });

  test("mints an id when missing", () => {
    expect(toStepDraft({ slug: "s", type: "agent" }).id).toMatch(/^node-\d+$/);
  });

  test("preserves if condition and branch labels", () => {
    // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword, not a thenable
    const branchLabels = { then: "Y" };
    const draft = toStepDraft({ id: "n", slug: "s", type: "if", condition: { ref: "x" }, branchLabels });
    expect(draft).toEqual({ id: "n", slug: "s", type: "if", condition: { ref: "x" }, branchLabels });
    expect(draft.branchLabels).not.toBe(branchLabels);
  });

  test("preserves case match, paths and default", () => {
    const draft = toStepDraft({ id: "n", slug: "s", type: "case", match: "m", paths: ["a"], default: "a" });
    expect(draft).toEqual({ id: "n", slug: "s", type: "case", match: "m", paths: ["a"], default: "a" });
  });

  test("collects custom step fields into config, including input/output", () => {
    const draft = toStepDraft({ id: "n", slug: "s", type: "chunk", input: "i", output: "o" });
    expect(draft).toEqual({ id: "n", slug: "s", type: "chunk", config: { input: "i", output: "o" } });
  });

  test("leaves config undefined for custom steps without fields", () => {
    expect(toStepDraft({ id: "n", slug: "s", type: "noop" }).config).toBeUndefined();
  });
});

describe("stepTemplate", () => {
  test("returns built-in templates with an empty slug", () => {
    const step = stepTemplate("iterator", []);
    expect(step).toMatchObject({ slug: "", type: "iterator", items: "", as: "item" });
    expect(step.id).toMatch(/^node-\d+$/);
  });

  test("seeds custom config from the schema", () => {
    const schema = { type: "object", properties: { url: { type: "string", default: "x" } } };
    expect(stepTemplate("http", [{ type: "http", configSchema: schema }]).config).toEqual({ url: "x" });
  });

  test("leaves unknown custom types without config", () => {
    expect(stepTemplate("mystery", []).config).toBeUndefined();
  });
});

describe("withConfigDefaults", () => {
  const custom = [{ type: "http", configSchema: { type: "object", properties: { url: { type: "string" } } } }];

  test("seeds custom steps that lack a config", () => {
    const [step] = withConfigDefaults([{ id: "n", slug: "s", type: "http" }], custom);
    expect(step!.config).toBeDefined();
  });

  test("leaves built-in steps and existing configs alone", () => {
    const agent = { id: "a", slug: "a", type: "agent" };
    const configured = { id: "b", slug: "b", type: "http", config: { url: "u" } };
    const result = withConfigDefaults([agent, configured], custom);
    expect(result[0]).toBe(agent);
    expect(result[1]).toBe(configured);
  });
});

describe("branchFromHandle", () => {
  test("extracts if branches", () => {
    expect(branchFromHandle("n1", "n1-then")).toBe("then");
    expect(branchFromHandle("n1", "n1-else")).toBe("else");
  });

  test("extracts case paths and default", () => {
    expect(branchFromHandle("n1", "n1-path-big")).toBe("big");
    expect(branchFromHandle("n1", "n1-default")).toBe("default");
  });

  test("returns undefined for missing or foreign handles", () => {
    expect(branchFromHandle("n1", null)).toBeUndefined();
    expect(branchFromHandle("n1", "n2-then")).toBeUndefined();
  });
});

describe("graphEdgesToDraftEdges", () => {
  test("drops synthetic nodes and decodes branches", () => {
    const edges = graphEdgesToDraftEdges(
      [
        { source: "__trigger__", target: "a" },
        { source: "a", target: "b", sourceHandle: "a-then" },
        { source: "b", target: "c" },
        { source: "c", target: "__add__" },
      ],
      new Set(["a", "b", "c"]),
    );
    expect(edges).toEqual([
      { from: "a", to: "b", branch: "then" },
      { from: "b", to: "c" },
    ]);
  });
});

describe("reconcileConnectivityErrors", () => {
  const draft = (edges: WorkflowDraft["edges"]): WorkflowDraft => ({
    name: "w",
    description: "",
    trigger: { type: "manual", ref: "" },
    enabled: true,
    steps: [
      { id: "a", slug: "a", type: "agent" },
      { id: "b", slug: "b", type: "agent" },
      { id: "c", slug: "c", type: "agent" },
    ],
    edges,
  });

  test("adds the error for orphaned steps and clears it once connected", () => {
    const orphaned = reconcileConnectivityErrors(draft([{ from: "a", to: "b" }]), new Map());
    expect(orphaned.get("steps[2].slug")).toBe(disconnectedStepError("c"));

    const connected = reconcileConnectivityErrors(
      draft([
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ]),
      orphaned,
    );
    expect(connected.has("steps[2].slug")).toBe(false);
  });

  test("never clobbers a slug-format error", () => {
    const errors = new Map([["steps[2].slug", "Invalid slug"]]);
    const result = reconcileConnectivityErrors(draft([{ from: "a", to: "b" }]), errors);
    expect(result.get("steps[2].slug")).toBe("Invalid slug");
  });
});

describe("errorsAfterStepRemoval", () => {
  test("drops step-indexed errors and keeps the rest", () => {
    const errors = new Map([
      ["steps[0].prompt", "x"],
      ["trigger.ref", "y"],
    ]);
    const result = errorsAfterStepRemoval(errors, [], "gone");
    expect([...result.keys()]).toEqual(["trigger.ref"]);
  });

  test("warns when another step's prompt references the removed slug", () => {
    const remaining = [{ id: "b", slug: "b", type: "agent", prompt: "use {{steps.gone.result}}" }];
    expect(errorsAfterStepRemoval(new Map(), remaining, "gone").get("steps.removeWarning")).toBe(
      'Step "gone" is referenced in: b',
    );
  });

  test("clears a stale remove warning when nothing references the slug", () => {
    const errors = new Map([["steps.removeWarning", "old"]]);
    expect(errorsAfterStepRemoval(errors, [], "gone").has("steps.removeWarning")).toBe(false);
  });
});

describe("parseSaveErrorDetails", () => {
  test("splits, trims and drops empty entries", () => {
    expect(parseSaveErrorDetails("edge x; edge y ;  ; z")).toEqual(["edge x", "edge y", "z"]);
  });

  test("returns an empty list for missing details", () => {
    expect(parseSaveErrorDetails(undefined)).toEqual([]);
  });
});
