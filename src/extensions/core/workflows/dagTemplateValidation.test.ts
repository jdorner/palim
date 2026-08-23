import { describe, expect, test } from "bun:test";
import { validateDagWorkflowTemplates } from "./dagTemplateValidation";
import type { DagWorkflowDefinition } from "./schemas";

/**
 * Builds a minimal valid DAG workflow definition for template-validation tests.
 * Callers supply the steps map and edges; trigger/name/enabled are stubbed.
 */
function wf(steps: DagWorkflowDefinition["steps"], edges: DagWorkflowDefinition["edges"]): DagWorkflowDefinition {
  return {
    name: "test-wf",
    trigger: { type: "manual" },
    enabled: true,
    steps,
    edges,
  } as DagWorkflowDefinition;
}

describe("validateDagWorkflowTemplates", () => {
  describe("branch reachability (dominator) checks", () => {
    test("flags a join node referencing a step on a conditional branch", async () => {
      // create-motd -> detect -> check(if)
      //   then -> assemble
      //   else -> translate -> assemble
      // assemble references translate.result, but translate only runs on the
      // else path, so at a then-path run its result is absent.
      const def = wf(
        {
          "create-motd": { type: "agent", prompt: "make motd" },
          detect: { type: "agent", prompt: "{{steps.create-motd.result}}" },
          check: { type: "if", condition: { ref: "{{steps.detect.result}}", eq: "German" } },
          translate: { type: "agent", prompt: "{{steps.create-motd.result}}" },
          assemble: { type: "agent", prompt: "{{steps.translate.result}}" },
        },
        [
          { from: "create-motd", to: "detect" },
          { from: "detect", to: "check" },
          { from: "check", to: "assemble", branch: "then" },
          { from: "check", to: "translate", branch: "else" },
          { from: "translate", to: "assemble" },
        ],
      );

      const warnings = await validateDagWorkflowTemplates(def);
      const match = warnings.find((w) => w.stepSlug === "assemble" && w.message.includes("translate"));
      expect(match).not.toBeUndefined();
      expect(match!.message).toContain("conditional branch that may be skipped");
    });

    test("does not flag a reference to a step that dominates the join", async () => {
      // assemble also references create-motd, which runs on every path.
      const def = wf(
        {
          "create-motd": { type: "agent", prompt: "make motd" },
          check: { type: "if", condition: { ref: "{{steps.create-motd.result}}", eq: "x" } },
          translate: { type: "agent", prompt: "t" },
          assemble: { type: "agent", prompt: "{{steps.create-motd.result}}" },
        },
        [
          { from: "create-motd", to: "check" },
          { from: "check", to: "assemble", branch: "then" },
          { from: "check", to: "translate", branch: "else" },
          { from: "translate", to: "assemble" },
        ],
      );

      const warnings = await validateDagWorkflowTemplates(def);
      const badRefs = warnings.filter((w) => w.stepSlug === "assemble");
      expect(badRefs).toEqual([]);
    });

    test("a step on the same branch may reference an earlier step on that branch", async () => {
      // translate references create-motd (a dominator); the step immediately
      // after translate on the same branch may reference translate.
      const def = wf(
        {
          "create-motd": { type: "agent", prompt: "make motd" },
          check: { type: "if", condition: { ref: "{{steps.create-motd.result}}", eq: "x" } },
          translate: { type: "agent", prompt: "{{steps.create-motd.result}}" },
          "post-translate": { type: "agent", prompt: "{{steps.translate.result}}" },
        },
        [
          { from: "create-motd", to: "check" },
          { from: "check", to: "translate", branch: "else" },
          { from: "translate", to: "post-translate" },
        ],
      );

      const warnings = await validateDagWorkflowTemplates(def);
      // translate dominates post-translate (only path into post-translate goes
      // through translate), so no reachability warning.
      const badRefs = warnings.filter((w) => w.stepSlug === "post-translate");
      expect(badRefs).toEqual([]);
    });

    test("still flags a reference to a non-ancestor step", async () => {
      const def = wf(
        {
          a: { type: "agent", prompt: "a" },
          b: { type: "agent", prompt: "{{steps.c.result}}" },
          c: { type: "agent", prompt: "c" },
        },
        [
          { from: "a", to: "b" },
          { from: "a", to: "c" },
        ],
      );

      const warnings = await validateDagWorkflowTemplates(def);
      const match = warnings.find((w) => w.stepSlug === "b" && w.message.includes("c"));
      expect(match).not.toBeUndefined();
      expect(match!.message).toContain("is not an ancestor");
    });
  });

  describe("linear workflows", () => {
    test("no warnings when every reference is to a linear ancestor", async () => {
      const def = wf(
        {
          a: { type: "agent", prompt: "a" },
          b: { type: "agent", prompt: "{{steps.a.result}}" },
          c: { type: "agent", prompt: "{{steps.b.result}} {{steps.a.result}}" },
        },
        [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
        ],
      );

      const warnings = await validateDagWorkflowTemplates(def);
      expect(warnings).toEqual([]);
    });
  });
});
