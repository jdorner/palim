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
  // New validation and compilation are non-fatal
  // -------------------------------------------------------------------------
  test("New validation and compilation are non-fatal", async () => {
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
  // Path-existence diagnostic soundness
  // -------------------------------------------------------------------------
  describe("Path-existence diagnostic soundness", () => {
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

    test("resolvable dot-path yields no path-existence warning", async () => {
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

    test("unresolvable dot-path yields exactly one warning identifying slug, field and path", async () => {
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

    test("null/undefined schema yields no path-existence warning", async () => {
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

    test("present-but-malformed schema is not suppressed", async () => {
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
  // Schema-independent warnings are preserved
  // -------------------------------------------------------------------------
  test("schema-independent warnings identical with and without schemas", async () => {
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
  // Condition fields are diagnosed like any other field
  // -------------------------------------------------------------------------
  test("condition fields diagnosed identically modulo field name", async () => {
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

// ---------------------------------------------------------------------------
// Function-call expression syntax
// ---------------------------------------------------------------------------

describe("validateDagWorkflowTemplates - function-call syntax", () => {
  /**
   * Builds an iterator -> body -> aggregator DAG (mirroring the scan-app shape)
   * with the given body-step field value, so the iterator alias `image` is a
   * valid prefix inside the body.
   */
  function iteratorWf(bodyFieldValue: string): DagWorkflowDefinition {
    return wf(
      {
        images: { type: "iterator", items: "{{trigger.payload}}", as: "image" },
        convert: { type: "http-request", url: "http://x", method: "POST", body: bodyFieldValue },
        collect: { type: "aggregator", iterator: "images" },
      },
      [
        { from: "images", to: "convert", branch: "each" },
        { from: "convert", to: "collect" },
      ],
    );
  }

  test("does not flag a function call over a valid iterator-alias path", async () => {
    const def = iteratorWf('{"data": "{{ stripDataUri(image.dataUrl) }}"}');
    const warnings = await validateDagWorkflowTemplates(def);
    expect(warnings.filter((w) => w.message.includes("Unknown expression prefix"))).toEqual([]);
    expect(warnings.filter((w) => w.message.includes("Unknown function"))).toEqual([]);
  });

  test("does not flag nested function calls", async () => {
    const def = iteratorWf('{"data": "{{ jsonEscape(stripDataUri(image.dataUrl)) }}"}');
    const warnings = await validateDagWorkflowTemplates(def);
    expect(warnings).toEqual([]);
  });

  test("flags an unknown function name", async () => {
    const def = iteratorWf('{"data": "{{ bogusFn(image.dataUrl) }}"}');
    const warnings = await validateDagWorkflowTemplates(def);
    const fnWarn = warnings.find((w) => w.message.includes("Unknown function"));
    expect(fnWarn).not.toBeUndefined();
    expect(fnWarn!.message).toContain("bogusFn");
  });

  test("still flags an unknown namespace in a function argument", async () => {
    const def = iteratorWf('{"data": "{{ stripDataUri(bogus.field) }}"}');
    const warnings = await validateDagWorkflowTemplates(def);
    const prefixWarn = warnings.find((w) => w.message.includes("Unknown expression prefix"));
    expect(prefixWarn).not.toBeUndefined();
  });

  test("still flags a genuinely unknown plain-path prefix", async () => {
    const def = wf(
      {
        a: { type: "agent", prompt: "seed" },
        b: { type: "agent", prompt: "{{totally.unknown}}" },
      },
      [{ from: "a", to: "b" }],
    );
    const warnings = await validateDagWorkflowTemplates(def);
    expect(warnings.find((w) => w.message.includes("Unknown expression prefix"))).not.toBeUndefined();
  });

  test("flags forbidden key references", async () => {
    const def = iteratorWf('{"data": "{{ constructor.constructor(1)() }}"}');
    const warnings = await validateDagWorkflowTemplates(def);
    expect(warnings.find((w) => w.message.includes("Forbidden key"))).not.toBeUndefined();
  });

  test("scan-app workflow body produces no template warnings (task 6.2/7.1)", async () => {
    // Mirrors the actual test-scan-app.json5 converter body after the fix.
    const def = iteratorWf('{"data": "{{ jsonEscape(stripDataUri(image.dataUrl)) }}"}');
    const warnings = await validateDagWorkflowTemplates(def);
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Variable-reference validation (var namespace)
// ---------------------------------------------------------------------------

/**
 * Builds a fake variable store backed by a set of known keys.
 * Mirrors the `{ has(key): boolean }` shape of `TemplateValidationOptions.variableStore`.
 */
function fakeVariableStore(keys: Iterable<string>): { has(key: string): boolean } {
  const set = new Set(keys);
  return { has: (k: string) => set.has(k) };
}

/** Wraps a variable key into a `{{var.KEY}}` template expression. */
function varExpr(key: string): string {
  return `{{var.${key}}}`;
}

/** Filters warnings down to those about a missing variable. */
function missingVarWarnings(warnings: TemplateWarning[]): TemplateWarning[] {
  return warnings.filter((w) => w.message.includes("not found"));
}

/** Filters warnings down to those about a malformed var expression. */
function malformedVarWarnings(warnings: TemplateWarning[]): TemplateWarning[] {
  return warnings.filter((w) => w.message.includes('expected "var.<KEY>"'));
}

describe("validateDagWorkflowTemplates (var undefined-reference properties)", () => {
  // Feature: global-variables, Property 8: Validator emits exactly one warning
  // per undefined reference.
  // Validates: Requirements 6.2, 6.3, 6.6
  //
  // For any workflow definition and any variable store, the validator emits
  // exactly one warning (carrying step slug, field, and the missing key) for
  // each distinct {{var.KEY}} reference whose key is absent from the store, and
  // no warning for references whose key exists.

  /** Valid variable key generator (UPPER_SNAKE_CASE, 1-64 chars). */
  const keyArb = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,10}$/).filter((s) => /^[A-Z][A-Z0-9_]{0,63}$/.test(s));

  test("Property 8: one warning per distinct absent key, none for present keys", async () => {
    await fc.assert(
      fc.asyncProperty(
        // A set of distinct referenced keys, and for each a flag: is it in the store?
        fc.uniqueArray(keyArb, { minLength: 1, maxLength: 8 }),
        fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }),
        async (keys, presentFlags) => {
          const present: string[] = [];
          const absent: string[] = [];
          keys.forEach((key, i) => {
            if (presentFlags[i] ?? false) present.push(key);
            else absent.push(key);
          });

          // A prompt embedding one reference per distinct key (each appears once).
          const prompt = keys.map(varExpr).join(" and ");
          const def = wf({ a: { type: "agent", prompt } }, []);
          const store = fakeVariableStore(present);

          const warnings = await validateDagWorkflowTemplates(def, { variableStore: store });
          const missing = missingVarWarnings(warnings);

          // Exactly one warning per distinct absent key.
          expect(missing.length).toBe(absent.length);

          // Each warning carries the step slug, the field, and the missing key.
          const warnedKeys = new Set<string>();
          for (const w of missing) {
            expect(w.stepSlug).toBe("a");
            expect(w.field).toBe("prompt");
            const matched = absent.find((k) => w.message.includes(`"${k}"`));
            expect(matched).not.toBeUndefined();
            warnedKeys.add(matched!);
          }
          // One distinct warned key per absent key (no duplicates, no misses).
          expect(warnedKeys.size).toBe(absent.length);
          for (const k of absent) expect(warnedKeys.has(k)).toBe(true);

          // No missing-var warning names a present key.
          for (const k of present) {
            expect(missing.some((w) => w.message.includes(`"${k}"`))).toBe(false);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("Property 8: duplicate references to one absent key still warn once (per-field de-dup)", async () => {
    await fc.assert(
      fc.asyncProperty(keyArb, fc.integer({ min: 2, max: 5 }), async (key, repeats) => {
        const prompt = Array.from({ length: repeats }, () => varExpr(key)).join(" ");
        const def = wf({ a: { type: "agent", prompt } }, []);
        const store = fakeVariableStore([]); // key absent

        const warnings = await validateDagWorkflowTemplates(def, { variableStore: store });
        const missing = missingVarWarnings(warnings);
        expect(missing.length).toBe(1);
        expect(missing[0]!.message).toContain(`"${key}"`);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("validateDagWorkflowTemplates (malformed var-expression properties)", () => {
  // Feature: global-variables, Property 9: Validator flags malformed var
  // expressions.
  // Validates: Requirements 6.4, 6.5
  //
  // For any var-prefixed expression that is not exactly the prefix followed by
  // a single key segment (e.g. {{var}}, {{var.A.B}}, {{var.}}), the validator
  // emits exactly one warning describing the expected {{var.<KEY>}} form,
  // regardless of whether a variable store is provided.

  /** Generates a malformed var expression body (the text inside {{ }}). */
  const malformedBodyArb = fc.oneof(
    // Bare prefix: "var" (parts.length === 1).
    fc.constant("var"),
    // Trailing dot / empty key: "var." (parts = ["var", ""]).
    fc.constant("var."),
    // Deep path: "var.A.B", "var.A.B.C" (parts.length > 2).
    fc
      .array(fc.stringMatching(/^[A-Z][A-Z0-9_]{0,5}$/), { minLength: 2, maxLength: 4 })
      .map((segs) => `var.${segs.join(".")}`),
    // Prefix + empty deeper segment: "var.KEY." (parts = ["var","KEY",""]).
    fc.stringMatching(/^[A-Z][A-Z0-9_]{0,5}$/).map((k) => `var.${k}.`),
  );

  test("Property 9: exactly one malformed-expression warning, with or without a store", async () => {
    await fc.assert(
      fc.asyncProperty(malformedBodyArb, fc.boolean(), async (body, provideStore) => {
        const def = wf({ a: { type: "agent", prompt: `{{${body}}}` } }, []);
        const options = provideStore ? { variableStore: fakeVariableStore(["ANY_KEY"]) } : {};

        const warnings = await validateDagWorkflowTemplates(def, options);
        const malformed = malformedVarWarnings(warnings);

        // Exactly one malformed-var warning regardless of store presence.
        expect(malformed.length).toBe(1);
        const w = malformed[0]!;
        expect(w.stepSlug).toBe("a");
        expect(w.field).toBe("prompt");
        // The message describes the expected form.
        expect(w.message).toContain("var.<KEY>");
        // A malformed expression is never also reported as a missing-variable.
        expect(missingVarWarnings(warnings).length).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("Property 9: malformed count is store-independent for a given expression", async () => {
    await fc.assert(
      fc.asyncProperty(malformedBodyArb, async (body) => {
        const def = wf({ a: { type: "agent", prompt: `{{${body}}}` } }, []);

        const withStore = malformedVarWarnings(
          await validateDagWorkflowTemplates(def, { variableStore: fakeVariableStore(["ANY_KEY"]) }),
        );
        const withoutStore = malformedVarWarnings(await validateDagWorkflowTemplates(def, {}));

        expect(withStore.length).toBe(1);
        expect(withoutStore.length).toBe(1);
        expect(withStore[0]!.message).toBe(withoutStore[0]!.message);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
