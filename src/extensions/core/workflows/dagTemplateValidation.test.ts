import { describe, expect, test } from "bun:test";
import { type OutputSchema, walkSchemaPath } from "@shared/workflows";
import fc from "fast-check";
import { type TemplateWarning, validateDagWorkflowTemplates } from "./dagTemplateValidation";
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

// ---------------------------------------------------------------------------
// Property-based tests (fast-check)
// ---------------------------------------------------------------------------

/** Minimum fast-check iterations per property. */
const NUM_RUNS = 100;

/**
 * A canonical JSON Schema object node with the given properties.
 */
function objSchema(properties: Record<string, OutputSchema>): OutputSchema {
  return { type: "object", properties };
}

/** A leaf schema node of the given primitive type. */
function leaf(type: string): OutputSchema {
  return { type };
}

/**
 * Arbitrary for a lowercase identifier suitable as a slug or property name.
 */
const identifierArb = fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/).filter((s) => s.length > 0 && /^[a-z]/.test(s));

/**
 * Recursively generates a canonical JSON Schema object tree plus the set of
 * fully-resolvable dot-paths within it (both object and leaf terminals).
 */
type SchemaWithPaths = { schema: OutputSchema; resolvablePaths: string[][] };

function schemaWithPathsArb(depth: number): fc.Arbitrary<SchemaWithPaths> {
  const leafArb: fc.Arbitrary<SchemaWithPaths> = fc
    .constantFrom("string", "number", "boolean")
    .map((t) => ({ schema: leaf(t), resolvablePaths: [[]] as string[][] }));

  if (depth <= 0) return leafArb;

  const objArb: fc.Arbitrary<SchemaWithPaths> = fc
    .uniqueArray(fc.tuple(identifierArb, fc.constant(null)), {
      minLength: 1,
      maxLength: 3,
      selector: (t) => t[0],
    })
    .chain((entries) =>
      fc.tuple(...entries.map(() => schemaWithPathsArb(depth - 1))).map((children) => {
        const properties: Record<string, OutputSchema> = {};
        const resolvablePaths: string[][] = [[]];
        entries.forEach(([key], i) => {
          const child = children[i]!;
          properties[key] = child.schema;
          for (const p of child.resolvablePaths) {
            resolvablePaths.push([key, ...p]);
          }
        });
        return { schema: objSchema(properties), resolvablePaths };
      }),
    );

  return fc.oneof({ weight: 1, arbitrary: leafArb }, { weight: 3, arbitrary: objArb });
}

/**
 * Predicate: a dot-path resolves within a schema iff walkSchemaPath resolves it.
 * We derive unresolvable paths by appending a segment that is not a child key.
 */

describe("validateDagWorkflowTemplates (properties)", () => {
  // -------------------------------------------------------------------------
  // Property 3: New validation and compilation are non-fatal
  // -------------------------------------------------------------------------
  test("Feature: workflow-schema-dataflow, Property 3: New validation and compilation are non-fatal", async () => {
    // Arbitrary, possibly-malformed workflow definitions with arbitrary
    // template expressions. The validator must always resolve to an array and
    // never throw/reject, regardless of unknown paths, malformed schemas, or
    // odd expressions.
    const exprArb = fc.oneof(
      fc.constant("{{steps.a.result.status.deep.path}}"),
      fc.constant("{{steps.unknown.result}}"),
      fc.constant("{{trigger.payload.a.b.c}}"),
      fc.constant("{{env.SOME_VAR}}"),
      fc.constant("{{secret.KEY}}"),
      fc.constant("{{bogus.prefix.here}}"),
      fc.constant("{{}}"),
      fc.constant("{{steps}}"),
      fc.string(),
    );

    const malformedSchemaArb: fc.Arbitrary<OutputSchema> = fc.oneof(
      fc.constant({ type: "object", properties: "not-an-object" } as unknown as OutputSchema),
      fc.constant({} as OutputSchema),
      fc.constant({ type: "string" } as OutputSchema),
      fc.constant(objSchema({ status: leaf("number") })),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.array(exprArb, { minLength: 1, maxLength: 5 }),
        malformedSchemaArb,
        fc.boolean(),
        async (exprs, schema, provideResolvers) => {
          const prompt = exprs.join(" ");
          const def = wf(
            {
              a: { type: "agent", prompt: "seed" },
              b: { type: "agent", prompt },
            },
            [{ from: "a", to: "b" }],
          );

          const options = provideResolvers
            ? {
                resolveStepOutputSchema: () => schema,
                resolveTriggerOutputSchema: () => schema,
              }
            : {};

          const result = await validateDagWorkflowTemplates(def, options);
          expect(Array.isArray(result)).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // Property 10: Path-existence diagnostic soundness
  // -------------------------------------------------------------------------
  describe("Property 10: Path-existence diagnostic soundness", () => {
    /**
     * Builds a linear a -> b workflow where b references
     * `{{steps.a.result.<path>}}`. Making a an ancestor AND dominator of b
     * guarantees the path-existence check is reached (ancestor/dominator checks
     * pass first).
     */
    function linearRefWorkflow(dotPath: string[]): DagWorkflowDefinition {
      const expr = `{{steps.a.result.${dotPath.join(".")}}}`;
      return wf(
        {
          a: { type: "agent", prompt: "seed" },
          b: { type: "agent", prompt: expr },
        },
        [{ from: "a", to: "b" }],
      );
    }

    test("Feature: workflow-schema-dataflow, Property 10: resolvable dot-path yields no path-existence warning", async () => {
      await fc.assert(
        fc.asyncProperty(schemaWithPathsArb(3), async ({ schema, resolvablePaths }) => {
          // Only paths with at least one segment reach the path-existence check
          // (parts.length > 3 requires a non-empty dot-path).
          const nonEmpty = resolvablePaths.filter((p) => p.length > 0);
          fc.pre(nonEmpty.length > 0);
          const dotPath = nonEmpty[0]!;
          const def = linearRefWorkflow(dotPath);
          const warnings = await validateDagWorkflowTemplates(def, {
            resolveStepOutputSchema: () => schema,
          });
          const pathWarnings = warnings.filter((w) => w.message.includes("unknown result path"));
          expect(pathWarnings).toEqual([]);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    test("Feature: workflow-schema-dataflow, Property 10: unresolvable dot-path yields exactly one warning identifying slug, field and path", async () => {
      await fc.assert(
        fc.asyncProperty(schemaWithPathsArb(3), identifierArb, async ({ schema, resolvablePaths }, badSegment) => {
          // Append a segment guaranteed not to exist as a child on some
          // resolvable base path, producing an unresolvable dot-path.
          const base = resolvablePaths[0]!; // may be [] (root)
          const walked = walkSchemaPath(schema, base);
          fc.pre(!walked.children.includes(badSegment));
          const dotPath = [...base, badSegment];
          const def = linearRefWorkflow(dotPath);
          const warnings = await validateDagWorkflowTemplates(def, {
            resolveStepOutputSchema: () => schema,
          });
          const pathWarnings = warnings.filter((w) => w.message.includes("unknown result path"));
          expect(pathWarnings.length).toBe(1);
          const w = pathWarnings[0]!;
          expect(w.stepSlug).toBe("b");
          expect(w.field).toBe("prompt");
          expect(w.message).toContain(dotPath.join("."));
          expect(w.message).toContain('step "a"');
        }),
        { numRuns: NUM_RUNS },
      );
    });

    test("Feature: workflow-schema-dataflow, Property 10: null/undefined schema yields no path-existence warning", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(identifierArb, { minLength: 1, maxLength: 4 }),
          fc.boolean(),
          async (dotPath, useUndefined) => {
            const def = linearRefWorkflow(dotPath);
            const warnings = await validateDagWorkflowTemplates(def, {
              resolveStepOutputSchema: () => (useUndefined ? (undefined as unknown as null) : null),
            });
            const pathWarnings = warnings.filter((w) => w.message.includes("unknown result path"));
            expect(pathWarnings).toEqual([]);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    test("Feature: workflow-schema-dataflow, Property 10: present-but-malformed schema is not suppressed", async () => {
      // A malformed schema (properties is not an object) has no known children,
      // so a deeper path is reported unknown - malformed is NOT treated as
      // absent. Contrast with null (no warning, checked above).
      const malformedArb: fc.Arbitrary<OutputSchema> = fc.oneof(
        fc.constant({ type: "object", properties: "not-an-object" } as unknown as OutputSchema),
        fc.constant({ type: "object", properties: 42 } as unknown as OutputSchema),
        fc.constant({ type: "string" } as OutputSchema),
      );
      await fc.assert(
        fc.asyncProperty(
          malformedArb,
          fc.array(identifierArb, { minLength: 1, maxLength: 3 }),
          async (schema, dotPath) => {
            const def = linearRefWorkflow(dotPath);
            const warnings = await validateDagWorkflowTemplates(def, {
              resolveStepOutputSchema: () => schema,
            });
            const pathWarnings = warnings.filter((w) => w.message.includes("unknown result path"));
            expect(pathWarnings.length).toBe(1);
            expect(pathWarnings[0]!.message).toContain(dotPath.join("."));
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  // -------------------------------------------------------------------------
  // Property 11: Schema-independent warnings are preserved
  // -------------------------------------------------------------------------
  test("Feature: workflow-schema-dataflow, Property 11: schema-independent warnings identical with and without schemas", async () => {
    // A workflow mixing schema-independent issues (unknown prefix, non-ancestor
    // reference, incomplete expression, invalid accessor, env allowlist, secret)
    // with a resolvable-schema-dependent path reference. Running with null
    // resolvers vs. real-schema resolvers must yield identical schema-independent
    // warnings; only path-existence warnings may differ.
    const exprArb = fc.oneof(
      fc.constant("{{bogus.prefix}}"), // unknown prefix
      fc.constant("{{steps.zzz.result}}"), // unknown slug
      fc.constant("{{steps.c.result}}"), // non-ancestor (c is a sibling)
      fc.constant("{{steps}}"), // incomplete steps
      fc.constant("{{steps.a.bogus}}"), // invalid accessor
      fc.constant("{{env.NOT_ALLOWED_VAR}}"), // env allowlist
      fc.constant("{{trigger.foo}}"), // invalid trigger
    );

    /** A non-malformed schema so path checks resolve differently between runs. */
    const schema = objSchema({ status: leaf("number") });

    await fc.assert(
      fc.asyncProperty(fc.array(exprArb, { minLength: 1, maxLength: 6 }), async (exprs) => {
        // b references a real path on a (ancestor+dominator) so path checks fire
        // when a schema is present; plus the schema-independent exprs above.
        const prompt = `{{steps.a.result.status}} {{steps.a.result.missing}} ${exprs.join(" ")}`;
        const def = wf(
          {
            a: { type: "agent", prompt: "seed" },
            b: { type: "agent", prompt },
            c: { type: "agent", prompt: "sibling" },
          },
          [
            { from: "a", to: "b" },
            { from: "a", to: "c" },
          ],
        );

        const isPathWarning = (w: TemplateWarning) =>
          w.message.includes("unknown result path") || w.message.includes("unknown payload path");
        const key = (w: TemplateWarning) => `${w.stepSlug}\u0000${w.field}\u0000${w.message}`;

        const withoutSchemas = await validateDagWorkflowTemplates(def, {
          resolveStepOutputSchema: () => null,
          resolveTriggerOutputSchema: () => null,
        });
        const withSchemas = await validateDagWorkflowTemplates(def, {
          resolveStepOutputSchema: () => schema,
          resolveTriggerOutputSchema: () => schema,
        });

        const independentA = withoutSchemas
          .filter((w) => !isPathWarning(w))
          .map(key)
          .sort();
        const independentB = withSchemas
          .filter((w) => !isPathWarning(w))
          .map(key)
          .sort();
        expect(independentA).toEqual(independentB);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // -------------------------------------------------------------------------
  // Property 13: Condition fields are diagnosed like any other field
  // -------------------------------------------------------------------------
  test("Feature: workflow-schema-dataflow, Property 13: condition fields diagnosed identically modulo field name", async () => {
    // For the same unresolvable expression referencing an ancestor+dominator
    // step, the path-existence warning for an `if` node's condition.ref and a
    // `case` node's match must equal that of a normal agent-step field, differing
    // only in the reported `field`.
    await fc.assert(
      fc.asyncProperty(fc.array(identifierArb, { minLength: 2, maxLength: 4 }), async (dotPath) => {
        // Schema only declares `status`; any multi-segment path is unresolvable.
        const schema = objSchema({ status: leaf("number") });
        const expr = `{{steps.a.result.${dotPath.join(".")}}}`;
        const resolver = () => schema;

        // Normal field: agent prompt on b (a -> b).
        const normalDef = wf(
          {
            a: { type: "agent", prompt: "seed" },
            b: { type: "agent", prompt: expr },
          },
          [{ from: "a", to: "b" }],
        );
        // if node condition.ref on b.
        const ifDef = wf(
          {
            a: { type: "agent", prompt: "seed" },
            b: { type: "if", condition: { ref: expr, eq: "x" } },
          },
          [{ from: "a", to: "b" }],
        );
        // case node match on b.
        const caseDef = wf(
          {
            a: { type: "agent", prompt: "seed" },
            b: { type: "case", match: expr },
          },
          [{ from: "a", to: "b" }],
        );

        const pathOf = (ws: TemplateWarning[]) => ws.filter((w) => w.message.includes("unknown result path"));

        const normal = pathOf(await validateDagWorkflowTemplates(normalDef, { resolveStepOutputSchema: resolver }));
        const ifw = pathOf(await validateDagWorkflowTemplates(ifDef, { resolveStepOutputSchema: resolver }));
        const casew = pathOf(await validateDagWorkflowTemplates(caseDef, { resolveStepOutputSchema: resolver }));

        expect(normal.length).toBe(1);
        expect(ifw.length).toBe(1);
        expect(casew.length).toBe(1);

        // Same slug and message; only the field name differs.
        expect(normal[0]!.stepSlug).toBe("b");
        expect(normal[0]!.field).toBe("prompt");
        expect(ifw[0]!.field).toBe("condition.ref");
        expect(casew[0]!.field).toBe("match");

        expect(ifw[0]!.message).toBe(normal[0]!.message);
        expect(casew[0]!.message).toBe(normal[0]!.message);
        expect(ifw[0]!.stepSlug).toBe(normal[0]!.stepSlug);
        expect(casew[0]!.stepSlug).toBe(normal[0]!.stepSlug);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
