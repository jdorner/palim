import { describe, expect, test } from "bun:test";
import { describeControlFlowStep } from "./controlFlowEvaluation";

describe("describeControlFlowStep", () => {
  test("describes an if node with its comparison", () => {
    const stepDef = { type: "if", condition: { ref: "{{trigger.payload.n}}", gt: 5 } };
    expect(describeControlFlowStep(stepDef, { condition: true, chosenBranch: "then", value: "7" })).toEqual({
      expression: "{{trigger.payload.n}}",
      value: "7",
      branch: "then",
      operator: "gt",
      operand: 5,
    });
  });

  test("reports an unresolved if value as null", () => {
    const stepDef = { type: "if", condition: { ref: "{{steps.x.result}}", exists: true } };
    const evaluation = describeControlFlowStep(stepDef, { condition: false, chosenBranch: "else", value: null });
    expect(evaluation?.value).toBeNull();
    expect(evaluation?.branch).toBe("else");
  });

  test("describes a case node and its fallback", () => {
    const stepDef = { type: "case", match: "{{trigger.payload.kind}}", paths: ["a", "b"], default: "b" };
    expect(describeControlFlowStep(stepDef, { matched: "b", value: "zzz", fallback: true })).toEqual({
      expression: "{{trigger.payload.kind}}",
      value: "zzz",
      branch: "b",
      fallback: true,
    });
  });

  test("tolerates results persisted before the value was recorded", () => {
    const stepDef = { type: "case", match: "{{x}}", paths: ["a"] };
    expect(describeControlFlowStep(stepDef, { matched: "a" })).toEqual({ expression: "{{x}}", branch: "a" });
  });

  test("ignores other step types and missing results", () => {
    expect(describeControlFlowStep({ type: "agent" }, { matched: "a" })).toBeUndefined();
    expect(describeControlFlowStep({ type: "case" }, undefined)).toBeUndefined();
    expect(describeControlFlowStep(undefined, { matched: "a" })).toBeUndefined();
  });
});
