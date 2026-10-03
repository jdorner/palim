import { describe, expect, test } from "bun:test";
import type { OutputSchemaContext, StepExecutionContext, StepTemplateOverrides } from "@ext/types";
import { type TSchema, Type } from "@sinclair/typebox";
import { InMemoryFs } from "just-bash";
import { resolveTemplates, type TemplateContext } from "../core/workflows/template";
import { createSetVariablesHandler, deriveSetVariablesOutputSchema } from "./setVariables";

/**
 * Creates a StepExecutionContext backed by the real template engine, mirroring
 * the DAG worker (including its per-call `stepResults` overlay).
 */
function createContext(
  opts: {
    stepSlug?: string;
    stepResults?: Record<string, unknown>;
    triggerPayload?: unknown;
    iterationContext?: TemplateContext["iterationContext"];
    logs?: string[];
  } = {},
): StepExecutionContext {
  const stepResults = opts.stepResults ?? {};
  const tmplCtx: TemplateContext = {
    triggerPayload: opts.triggerPayload,
    stepResults,
    iterationContext: opts.iterationContext,
  };
  return {
    resolveTemplate: async (template: string, overrides?: StepTemplateOverrides) =>
      resolveTemplates(
        template,
        overrides?.stepResults ? { ...tmplCtx, stepResults: { ...stepResults, ...overrides.stepResults } } : tmplCtx,
      ),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as StepExecutionContext["log"],
    workDir: "/tmp/test-work",
    fs: new InMemoryFs(),
    jobLog: async (msg: string) => {
      opts.logs?.push(msg);
    },
    workflowRunId: "test-run-123",
    stepSlug: opts.stepSlug ?? "vars",
    stepResults,
  };
}

/** Builds a set-variables step definition. */
function stepDef(variables: unknown[]): Record<string, unknown> {
  return { type: "set-variables", variables };
}

describe("createSetVariablesHandler", () => {
  const handler = createSetVariablesHandler();

  test("has correct label, icon, and category", () => {
    expect(handler.label).toBe("Set Variables");
    expect(handler.icon).toBe("BracketsCurlyIcon");
    expect(handler.category).toBe("action");
    expect(handler.selfReference).toBe(true);
  });

  test("declares string as the default variable type so new form rows preselect it", () => {
    const schema = JSON.parse(JSON.stringify(handler.schema));
    expect(schema.properties.variables.items.properties.type.default).toBe("string");
  });

  describe("execute", () => {
    test("sets literal and template values", async () => {
      const ctx = createContext({ triggerPayload: { user: "ada" } });
      const result = await handler.execute(
        stepDef([
          { name: "greeting", value: "hello" },
          { name: "key", value: "user-{{trigger.payload.user}}" },
        ]),
        ctx,
      );
      expect(result).toEqual({ greeting: "hello", key: "user-ada" });
    });

    test("coerces typed values", async () => {
      const ctx = createContext({ triggerPayload: { n: 42, obj: { a: [1, 2] } } });
      const result = await handler.execute(
        stepDef([
          { name: "num", value: "{{trigger.payload.n}}", type: "number" },
          { name: "flag", value: "true", type: "boolean" },
          { name: "data", value: "{{trigger.payload.obj}}", type: "json" },
          { name: "str", value: "7", type: "string" },
        ]),
        ctx,
      );
      expect(result).toEqual({ num: 42, flag: true, data: { a: [1, 2] }, str: "7" });
    });

    test.each([
      ["number", "abc", /not a number/],
      ["number", "", /not a number/],
      ["boolean", "yes", /not a boolean/],
      ["json", "{bad", /invalid JSON/],
    ])("rejects %s value %p", async (type, value, error) => {
      await expect(handler.execute(stepDef([{ name: "x", value, type }]), createContext())).rejects.toThrow(error);
    });

    test("rejects duplicate names", async () => {
      await expect(
        handler.execute(
          stepDef([
            { name: "a", value: "1" },
            { name: "a", value: "2" },
          ]),
          createContext(),
        ),
      ).rejects.toThrow(/Duplicate variable name "a"/);
    });

    test("rejects invalid configuration", async () => {
      await expect(handler.execute(stepDef([]), createContext())).rejects.toThrow(/Invalid set-variables/);
      await expect(handler.execute(stepDef([{ name: "1bad", value: "x" }]), createContext())).rejects.toThrow(
        /Invalid set-variables/,
      );
    });

    test("later entries see earlier entries of the same execution", async () => {
      const result = await handler.execute(
        stepDef([
          { name: "first", value: "a" },
          { name: "both", value: "{{steps.vars.result.first}}b" },
        ]),
        createContext(),
      );
      expect(result).toEqual({ first: "a", both: "ab" });
    });

    test("self-reference resolves to zero values without a previous result", async () => {
      const result = await handler.execute(
        stepDef([
          { name: "text", value: "[{{steps.vars.result.text}}]" },
          { name: "count", value: "{{steps.vars.result.count}}", type: "number" },
          { name: "flag", value: "{{steps.vars.result.flag}}", type: "boolean" },
          { name: "data", value: "{{steps.vars.result.data}}", type: "json" },
        ]),
        createContext(),
      );
      expect(result).toEqual({ text: "[]", count: 0, flag: false, data: null });
    });

    test("self-reference accumulates across executions (iterator passes)", async () => {
      const def = stepDef([{ name: "text", value: "{{steps.vars.result.text}}{{item}}," }]);
      const stepResults: Record<string, unknown> = {};
      for (const [i, item] of ["a", "b", "c"].entries()) {
        const ctx = createContext({ stepResults, iterationContext: { item, itemIndex: i, as: "item" } });
        stepResults.vars = await handler.execute(def, ctx);
      }
      expect(stepResults.vars).toEqual({ text: "a,b,c," });
    });

    test("does not mutate the shared step results", async () => {
      const stepResults: Record<string, unknown> = { vars: { text: "x" } };
      await handler.execute(
        stepDef([{ name: "text", value: "{{steps.vars.result.text}}y" }]),
        createContext({ stepResults }),
      );
      expect(stepResults).toEqual({ vars: { text: "x" } });
    });
  });

  describe("outputSchema", () => {
    test("returns an empty object schema for an empty config (palette)", () => {
      const schema = deriveSetVariablesOutputSchema({});
      expect(schema.type).toBe("object");
      expect(schema.properties).toEqual({});
    });

    test("skips partial and invalid entries", () => {
      const schema = deriveSetVariablesOutputSchema(
        stepDef([{ name: "ok", value: "x" }, { value: "no name" }, { name: "1bad", value: "x" }, null, "junk"]),
      );
      expect(Object.keys(schema.properties)).toEqual(["ok"]);
    });

    test("maps each type to its schema", () => {
      const schema = deriveSetVariablesOutputSchema(
        stepDef([
          { name: "s", value: "" },
          { name: "n", value: "", type: "number" },
          { name: "b", value: "", type: "boolean" },
          { name: "j", value: "[]", type: "json" },
        ]),
      );
      const props = JSON.parse(JSON.stringify(schema.properties));
      expect(props).toEqual({ s: { type: "string" }, n: { type: "number" }, b: { type: "boolean" }, j: {} });
    });

    test("json variable copying a single reference inherits its schema", () => {
      const fetched = Type.Object({ id: Type.Number() });
      const seen: string[] = [];
      const ctx: OutputSchemaContext = {
        resolveReferenceSchema: (expr: string): TSchema | undefined => {
          seen.push(expr);
          return expr === "steps.fetch.result.data" ? fetched : undefined;
        },
      };
      const schema = deriveSetVariablesOutputSchema(
        stepDef([
          { name: "data", value: " {{ steps.fetch.result.data }} ", type: "json" },
          { name: "mixed", value: "x{{steps.fetch.result.data}}", type: "json" },
        ]),
        ctx,
      );
      expect(seen).toEqual(["steps.fetch.result.data"]);
      expect(schema.properties.data).toBe(fetched);
      expect(JSON.parse(JSON.stringify(schema.properties.mixed))).toEqual({});
    });
  });
});
