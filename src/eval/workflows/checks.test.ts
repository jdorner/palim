import { describe, expect, test } from "bun:test";
import {
  agentStepsMissingSchema,
  evaluateChecks,
  hasAgentInLoop,
  type RunFacts,
  undeclaredConfigFields,
} from "./checks";
import type { ScenarioExpectations } from "./scenarios";

/** Config schema of a step type with a nested closed object, as `imap-fetch` declares it. */
const IMAP_SCHEMA = {
  type: "object",
  properties: {
    account: { type: "string" },
    search: { type: "object", properties: { seen: { type: "boolean" } } },
    headers: { type: "object", patternProperties: { "^(.*)$": { type: "string" } } },
  },
};

const REGISTERED = new Map<string, unknown>([
  ["agent", undefined],
  ["iterator", undefined],
  ["aggregator", undefined],
  ["case", undefined],
  ["humanTask", undefined],
  ["imap-fetch", IMAP_SCHEMA],
  ["notify-ntfy", { type: "object", properties: { message: { type: "string" }, topic: { type: "string" } } }],
]);

/** The naive design: the whole list in one prompt, free text handed on. */
const FLAT = {
  name: "flat",
  draft: true,
  steps: {
    "fetch-mails": { type: "imap-fetch" },
    classify: { type: "agent", prompt: "Classify {{steps.fetch-mails.result.messages}}" },
    notify: { type: "notify-ntfy", message: "{{steps.classify.result}}" },
  },
  edges: [
    { from: "fetch-mails", to: "classify" },
    { from: "classify", to: "notify" },
  ],
};

/** The per-item design: an agent step with fixed fields inside an iterator body. */
const LOOP = {
  name: "loop",
  draft: true,
  steps: {
    "fetch-mails": { type: "imap-fetch" },
    "each-mail": { type: "iterator", items: "{{steps.fetch-mails.result.messages}}", as: "mail" },
    classify: { type: "agent", prompt: "Classify {{mail.subject}}", outputSchema: { label: "string" } },
    "each-mail-done": { type: "aggregator", iterator: "each-mail" },
    notify: { type: "notify-ntfy", message: "{{steps.each-mail-done.result.succeeded}}" },
  },
  edges: [
    { from: "fetch-mails", to: "each-mail" },
    { from: "each-mail", to: "classify", branch: "each" },
    { from: "classify", to: "each-mail-done" },
    { from: "each-mail-done", to: "notify" },
  ],
};

const facts = (definition: unknown, over: Partial<RunFacts> = {}): RunFacts => ({
  definition,
  validationErrors: [],
  warningCount: 0,
  stepTypes: REGISTERED,
  ...over,
});

const LOOP_EXPECTED: ScenarioExpectations = { loop: "required", stepTypes: ["imap-fetch"], structuredHandoff: true };
const NO_LOOP: ScenarioExpectations = { loop: "forbidden", structuredHandoff: false };

describe("hasAgentInLoop", () => {
  test("is true for an agent step inside an iterator body", () => {
    expect(hasAgentInLoop(LOOP)).toBe(true);
  });

  test("is false without an iterator", () => {
    expect(hasAgentInLoop(FLAT)).toBe(false);
  });

  test("is false when the only agent step is outside the body", () => {
    const outside = {
      steps: { ...LOOP.steps, classify: { type: "noop" }, report: { type: "agent", prompt: "Report" } },
      edges: [...LOOP.edges, { from: "notify", to: "report" }],
    };
    expect(hasAgentInLoop(outside)).toBe(false);
  });

  test("does not throw on a malformed definition", () => {
    expect(hasAgentInLoop({ steps: [], edges: "x" })).toBe(false);
    expect(hasAgentInLoop(null)).toBe(false);
  });
});

describe("agentStepsMissingSchema", () => {
  test("reports an agent step without outputSchema that another step references", () => {
    expect(agentStepsMissingSchema(FLAT)).toEqual(["classify"]);
  });

  test("accepts an agent step with outputSchema", () => {
    expect(agentStepsMissingSchema(LOOP)).toEqual([]);
  });

  test("ignores an agent step nobody references, and a slug that is only a prefix", () => {
    const def = {
      steps: {
        classify: { type: "agent", prompt: "x" },
        "classify-more": { type: "agent", prompt: "y", outputSchema: { a: "string" } },
        notify: { type: "notify-ntfy", message: "{{steps.classify-more.result.a}}" },
      },
    };
    expect(agentStepsMissingSchema(def)).toEqual([]);
  });

  test("sees bracket references and nested fields", () => {
    const def = {
      steps: {
        "sum-up": { type: "agent", prompt: "x" },
        store: { type: "datatable-insert", row: { text: '{{steps["sum-up"].result}}' } },
      },
    };
    expect(agentStepsMissingSchema(def)).toEqual(["sum-up"]);
  });
});

describe("agentStepsMissingSchema through an aggregator", () => {
  const withoutSchema = {
    ...LOOP,
    steps: { ...LOOP.steps, classify: { type: "agent", prompt: "Classify {{mail.subject}}" } },
  };

  test("reports an agent step that ends a loop body whose aggregator is referenced", () => {
    expect(agentStepsMissingSchema(withoutSchema)).toEqual(["classify"]);
  });

  test("ignores it when nobody reads the aggregator", () => {
    const unread = {
      ...withoutSchema,
      steps: { ...withoutSchema.steps, notify: { type: "notify-ntfy", message: "Done" } },
    };
    expect(agentStepsMissingSchema(unread)).toEqual([]);
  });

  test("ignores an agent step in the body that the aggregator does not collect", () => {
    const midBody = {
      steps: { ...withoutSchema.steps, store: { type: "noop" } },
      edges: [
        { from: "fetch-mails", to: "each-mail" },
        { from: "each-mail", to: "classify", branch: "each" },
        { from: "classify", to: "store" },
        { from: "store", to: "each-mail-done" },
        { from: "each-mail-done", to: "notify" },
      ],
    };
    expect(agentStepsMissingSchema(midBody)).toEqual([]);
  });
});

describe("undeclaredConfigFields", () => {
  const withSearch = (search: unknown, extra: Record<string, unknown> = {}) => ({
    steps: { fetch: { type: "imap-fetch", account: "gmail", search, outputSchema: { x: "string" }, ...extra } },
  });

  test("reports a nested field the schema does not declare", () => {
    expect(undeclaredConfigFields(withSearch({ unseen: true }), REGISTERED)).toEqual(["fetch.search.unseen"]);
  });

  test("reports a top-level field and accepts declared ones", () => {
    expect(undeclaredConfigFields(withSearch({ seen: false }), REGISTERED)).toEqual([]);
    expect(undeclaredConfigFields(withSearch({ seen: false }, { folder: "INBOX" }), REGISTERED)).toEqual([
      "fetch.folder",
    ]);
  });

  test("leaves open objects and step types without a schema alone", () => {
    expect(undeclaredConfigFields(withSearch({}, { headers: { "X-Any": "1" } }), REGISTERED)).toEqual([]);
    expect(undeclaredConfigFields({ steps: { a: { type: "agent", anything: 1 } } }, REGISTERED)).toEqual([]);
    expect(undeclaredConfigFields({ steps: { a: { type: "unknown", anything: 1 } } }, REGISTERED)).toEqual([]);
  });
});

describe("evaluateChecks", () => {
  test("fails draft when the workflow is not a draft", () => {
    expect(evaluateChecks(facts({ ...LOOP, draft: false }), LOOP_EXPECTED).draft).toBe(false);
    expect(evaluateChecks(facts({ ...LOOP, draft: undefined }), LOOP_EXPECTED).draft).toBe(false);
  });

  test("fails config for an undeclared field although the server found the definition valid", () => {
    const def = { ...LOOP, steps: { ...LOOP.steps, "fetch-mails": { type: "imap-fetch", search: { unseen: true } } } };
    const result = evaluateChecks(facts(def), LOOP_EXPECTED);
    expect(result.valid).toBe(true);
    expect(result.config).toBe(false);
  });

  test("passes everything for the loop design when a loop is expected", () => {
    expect(evaluateChecks(facts(LOOP), LOOP_EXPECTED)).toEqual({
      file: true,
      valid: true,
      draft: true,
      loop: true,
      steps: true,
      schema: true,
      config: true,
      warnings: true,
      types: true,
    });
  });

  test("fails loop and schema for the flat design when a loop is expected", () => {
    const result = evaluateChecks(facts(FLAT), LOOP_EXPECTED);
    expect(result.loop).toBe(false);
    expect(result.schema).toBe(false);
  });

  test("passes the flat design when no loop is expected, and skips checks that do not apply", () => {
    const result = evaluateChecks(facts(FLAT), NO_LOOP);
    expect(result.loop).toBe(true);
    expect(result.schema).toBeNull();
    expect(result.steps).toBeNull();
  });

  test("fails loop when an iterator exists but none is expected", () => {
    expect(evaluateChecks(facts(LOOP), NO_LOOP).loop).toBe(false);
  });

  test("fails valid and warnings on validation errors, even with zero warnings", () => {
    const result = evaluateChecks(facts(LOOP, { validationErrors: ["bad"], warningCount: null }), LOOP_EXPECTED);
    expect(result.valid).toBe(false);
    expect(result.warnings).toBe(false);
  });

  test("fails warnings when the analyzer reports any", () => {
    expect(evaluateChecks(facts(LOOP, { warningCount: 2 }), LOOP_EXPECTED).warnings).toBe(false);
  });

  test("fails types for an unregistered step type and steps for a missing one", () => {
    const def = { steps: { tag: { type: "gmail-label" } }, edges: [] };
    const result = evaluateChecks(facts(def), LOOP_EXPECTED);
    expect(result.types).toBe(false);
    expect(result.steps).toBe(false);
  });

  test("fails every applicable check when no file was written", () => {
    const none = facts(null, { validationErrors: null, warningCount: null });
    expect(evaluateChecks(none, LOOP_EXPECTED)).toEqual({
      file: false,
      valid: false,
      draft: false,
      loop: false,
      steps: false,
      schema: false,
      config: false,
      warnings: false,
      types: false,
    });
    expect(evaluateChecks(none, NO_LOOP).schema).toBeNull();
  });
});
