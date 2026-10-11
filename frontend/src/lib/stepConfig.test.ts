import { describe, expect, test } from "bun:test";
import {
  applyCfValues,
  cfStepConfig,
  revalidateCfStep,
  revalidateCustomConfig,
  stepFieldErrors,
  stripEmptyOptionals,
  withoutError,
} from "./stepConfig";
import type { StepDraft } from "./workflowValidation";

/** JSON Schema with one required string `event` and an optional integer `timeout` >= 1000. */
const waitSchema = {
  type: "object",
  required: ["event"],
  properties: { event: { type: "string", minLength: 1 }, timeout: { type: "integer", minimum: 1000 } },
};

describe("cfStepConfig", () => {
  test("drops slug, type, and id", () => {
    expect(cfStepConfig({ id: "n1", slug: "w", type: "waitFor", event: "go", timeout: 5000 })).toEqual({
      event: "go",
      timeout: 5000,
    });
  });
});

describe("stripEmptyOptionals", () => {
  test("drops empty strings, null, undefined, 0, and empty arrays/objects", () => {
    expect(
      stripEmptyOptionals({ a: "", b: null, c: undefined, d: 0, e: [], f: {}, g: "x", h: 1, i: [1], j: { k: 1 } }),
    ).toEqual({ g: "x", h: 1, i: [1], j: { k: 1 } });
  });

  test("keeps false", () => {
    expect(stripEmptyOptionals({ flag: false })).toEqual({ flag: false });
  });
});

describe("applyCfValues", () => {
  test("replaces config fields, keeps identity, and skips empty optionals", () => {
    const step: StepDraft = { id: "n1", slug: "w", type: "waitFor", event: "old", correlate: "x" };
    applyCfValues(step, { event: "new", timeout: 0 });
    expect(step).toEqual({ id: "n1", slug: "w", type: "waitFor", event: "new" });
  });
});

describe("stepFieldErrors", () => {
  const errors = new Map([
    ["steps[1].event", "e"],
    ["steps[1].config.url", "u"],
    ["steps[1].config.headers.x", "h"],
    ["steps[2].event", "other step"],
  ]);

  test("flat scope returns top-level fields only", () => {
    expect([...stepFieldErrors(errors, 1, "flat")]).toEqual([["event", "e"]]);
  });

  test("config scope returns nested config paths", () => {
    expect([...stepFieldErrors(errors, 1, "config")]).toEqual([
      ["url", "u"],
      ["headers.x", "h"],
    ]);
  });
});

describe("withoutError", () => {
  test("returns the same map when the key is absent", () => {
    const errors = new Map([["a", "x"]]);
    expect(withoutError(errors, "b")).toBe(errors);
  });

  test("returns a copy without the key", () => {
    const errors = new Map([
      ["a", "x"],
      ["b", "y"],
    ]);
    const next = withoutError(errors, "a");
    expect([...next]).toEqual([["b", "y"]]);
    expect(errors.has("a")).toBe(true);
  });
});

describe("revalidateCfStep", () => {
  test("replaces the step's built-in field errors and leaves other steps alone", () => {
    const errors = new Map([
      ["steps[0].event", "stale"],
      ["steps[0].condition", "stale"],
      ["steps[0].slug", "kept"],
      ["steps[1].event", "other step"],
    ]);
    const next = revalidateCfStep(errors, 0, { event: "go", timeout: 0 }, waitSchema);
    expect(next.get("steps[0].event")).toBeUndefined();
    expect(next.get("steps[0].condition")).toBeUndefined();
    expect(next.get("steps[0].timeout")).toBeUndefined();
    expect(next.get("steps[0].slug")).toBe("kept");
    expect(next.get("steps[1].event")).toBe("other step");
  });

  test("reports invalid effective values", () => {
    const next = revalidateCfStep(new Map(), 0, { event: "go", timeout: 10 }, waitSchema);
    expect(next.has("steps[0].timeout")).toBe(true);
  });
});

describe("revalidateCustomConfig", () => {
  const schema = { type: "object", required: ["url"], properties: { url: { type: "string", minLength: 1 } } };

  test("replaces the step's config errors", () => {
    const errors = new Map([
      ["steps[0].config.stale", "x"],
      ["steps[0].prompt", "kept"],
    ]);
    const next = revalidateCustomConfig(errors, 0, {}, schema);
    expect(next.has("steps[0].config.stale")).toBe(false);
    expect(next.has("steps[0].config.url")).toBe(true);
    expect(next.get("steps[0].prompt")).toBe("kept");
  });

  test("only clears errors when the type has no schema", () => {
    const next = revalidateCustomConfig(new Map([["steps[0].config.a", "x"]]), 0, {}, undefined);
    expect(next.size).toBe(0);
  });
});
