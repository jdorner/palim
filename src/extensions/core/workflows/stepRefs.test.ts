import { describe, expect, test } from "bun:test";
import { findHyphenatedStepRefs, quoteHyphenatedStepRefs } from "./stepRefs";
import { resolveTemplates } from "./template";

const slugs = ["fetch-mails", "step-1", "step-13", "plain"];

describe("quoteHyphenatedStepRefs", () => {
  test.each([
    ["trim(steps.step-13.result.var1)", 'trim(steps["step-13"].result.var1)'],
    ["trim(steps.step-1.result)", 'trim(steps["step-1"].result)'],
    ["after(steps.fetch-mails.result.subject, '-')", "after(steps[\"fetch-mails\"].result.subject, '-')"],
    ["trim(steps.plain.result)", "trim(steps.plain.result)"],
    ["trim(steps.unknown-step.result)", "trim(steps.unknown-step.result)"],
    ["trim('steps.step-13.result')", "trim('steps.step-13.result')"],
    ["trim(mysteps.step-13)", "trim(mysteps.step-13)"],
  ])("%s", (input, expected) => {
    expect(quoteHyphenatedStepRefs(input, slugs)).toBe(expected);
  });

  test("prefers the longest known slug", () => {
    expect(quoteHyphenatedStepRefs("trim(steps.a-b-c.result)", ["a-b", "a-b-c"])).toBe('trim(steps["a-b-c"].result)');
  });
});

describe("findHyphenatedStepRefs", () => {
  test("reports the trailing dot-path span", () => {
    const expr = "trim(steps.step-13.result.var1)";
    const [ref] = findHyphenatedStepRefs(expr, slugs);
    expect(ref!.slug).toBe("step-13");
    expect(expr.slice(ref!.start, ref!.pathEnd)).toBe("steps.step-13.result.var1");
  });
});

describe("resolveTemplates with hyphenated slugs in function calls", () => {
  test("resolves the referenced step result", async () => {
    const { resolved, warnings } = await resolveTemplates("{{trim(steps.step-13.result.var1)}}", {
      triggerPayload: null,
      stepResults: { "step-13": { var1: "  x " } },
    });
    expect(warnings).toEqual([]);
    expect(resolved).toBe("x");
  });
});
