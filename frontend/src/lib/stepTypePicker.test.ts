import { describe, expect, test } from "bun:test";
import { buildPickerSections, filterPickerSections, movePickerIndex, type PickerStepType } from "./stepTypePicker";

const builtins: PickerStepType[] = [
  { type: "agent", label: "Agent", description: "Runs an LLM agent.", category: "execution" },
  { type: "if", label: "If / Condition", category: "control-flow" },
  { type: "case", label: "Case / Switch", category: "control-flow" },
  { type: "humanTask", label: "Human Task", category: "control-flow" },
  { type: "emit", label: "Emit Signal", category: "control-flow" },
];

const custom: PickerStepType[] = [
  { type: "http-request", label: "HTTP Request", description: "Sends an HTTP request." },
  { type: "chunk", label: "Chunk", category: "action" },
  { type: "for-each", label: "For Each", category: "control-flow" },
  { type: "emit", label: "Emit Signal (ext)", category: "control-flow" },
];

const types = (sections: ReturnType<typeof buildPickerSections>) => sections.map((s) => s.items.map((i) => i.type));

describe("buildPickerSections", () => {
  test("orders built-ins first, sorts by label, and drops custom types shadowing a built-in", () => {
    const sections = buildPickerSections(builtins, custom, { includeControlFlow: true, hitlEnabled: true });
    expect(sections.map((s) => s.id)).toEqual(["steps", "control-flow"]);
    expect(types(sections)).toEqual([
      ["agent", "chunk", "http-request"],
      ["case", "emit", "humanTask", "if", "for-each"],
    ]);
  });

  test("hides humanTask without HITL", () => {
    const sections = buildPickerSections(builtins, custom, { includeControlFlow: true, hitlEnabled: false });
    expect(types(sections)[1]).not.toContain("humanTask");
  });

  test("omits the control-flow section when excluded", () => {
    const sections = buildPickerSections(builtins, custom, { includeControlFlow: false, hitlEnabled: true });
    expect(sections.map((s) => s.id)).toEqual(["steps"]);
  });
});

describe("filterPickerSections", () => {
  const sections = buildPickerSections(builtins, custom, { includeControlFlow: true, hitlEnabled: true });

  test("returns all sections for a blank query", () => {
    expect(filterPickerSections(sections, "  ")).toEqual(sections);
  });

  test("matches label, description, and type case-insensitively", () => {
    expect(types(filterPickerSections(sections, "http"))).toEqual([["http-request"]]);
    expect(types(filterPickerSections(sections, "LLM"))).toEqual([["agent"]]);
    expect(types(filterPickerSections(sections, "for-each"))).toEqual([["for-each"]]);
  });

  test("drops sections without matches", () => {
    expect(filterPickerSections(sections, "condition").map((s) => s.id)).toEqual(["control-flow"]);
    expect(filterPickerSections(sections, "zzz")).toEqual([]);
  });
});

describe("movePickerIndex", () => {
  test("wraps around at both ends", () => {
    expect(movePickerIndex(2, 1, 3)).toBe(0);
    expect(movePickerIndex(0, -1, 3)).toBe(2);
    expect(movePickerIndex(1, 1, 3)).toBe(2);
  });

  test("starts at the matching end when nothing is active", () => {
    expect(movePickerIndex(-1, 1, 3)).toBe(0);
    expect(movePickerIndex(-1, -1, 3)).toBe(2);
  });

  test("returns -1 for an empty list", () => {
    expect(movePickerIndex(0, 1, 0)).toBe(-1);
  });
});
