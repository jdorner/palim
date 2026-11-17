import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@ext/types";
import type { OutputSchema } from "@shared/workflows";
import { Type } from "@sinclair/typebox";
import { getDesignWarnings } from "./designWarnings";
import type { DagWorkflowDefinition, Edge } from "./schemas";
import { createWorkflowAnalyzer } from "./workflowAnalysis";

/** Result schema of a step type that returns a list of objects, as `imap-fetch` does. */
const FETCH_SCHEMA: OutputSchema = {
  type: "object",
  properties: {
    count: { type: "number" },
    messages: {
      type: "array",
      items: { type: "object", properties: { uid: { type: "number" }, subject: { type: "string" } } },
    },
    folders: { type: "array", items: { type: "string" } },
  },
};

/** Resolver for definitions whose list-returning step is `fetch-mails`. */
const schemas = (slug: string): OutputSchema | null => (slug === "fetch-mails" ? FETCH_SCHEMA : null);

function wf(steps: Record<string, unknown>, edges: Edge[]): DagWorkflowDefinition {
  return { name: "design", trigger: { type: "manual" }, steps: steps as never, edges };
}

const chain = (...slugs: string[]): Edge[] => slugs.slice(1).map((to, i) => ({ from: slugs[i]!, to }));

/** The workflow that started this: whole list in one prompt, free text read as data. */
const TAGGING = wf(
  {
    "fetch-mails": { type: "imap-fetch" },
    classify: { type: "agent", prompt: "Classify these mails:\n{{steps.fetch-mails.result.messages}}" },
    "tag-mails": { type: "agent", prompt: "Tag {{steps.classify.result.labels}}" },
    notify: { type: "notify-ntfy", message: "Done" },
  },
  chain("fetch-mails", "classify", "tag-mails", "notify"),
);

/** The same job per item, with fixed fields. */
const LOOP = wf(
  {
    "fetch-mails": { type: "imap-fetch" },
    "each-mail": { type: "iterator", items: "{{steps.fetch-mails.result.messages}}", as: "mail" },
    classify: { type: "agent", prompt: "Classify {{mail.subject}}", outputSchema: { label: "string" } },
    "each-mail-done": { type: "aggregator", iterator: "each-mail" },
    notify: { type: "notify-ntfy", message: "{{steps.each-mail-done.result.succeeded}} mails" },
  },
  [
    { from: "fetch-mails", to: "each-mail" },
    { from: "each-mail", to: "classify", branch: "each" },
    { from: "classify", to: "each-mail-done" },
    { from: "each-mail-done", to: "notify" },
  ],
);

const withStep = (def: DagWorkflowDefinition, slug: string, step: unknown): DagWorkflowDefinition => ({
  ...def,
  steps: { ...def.steps, [slug]: step as never },
});

describe("getDesignWarnings", () => {
  test("warns on both rules for the tagging workflow", () => {
    expect(getDesignWarnings(TAGGING, schemas)).toEqual([
      {
        stepSlug: "classify",
        field: "prompt",
        message:
          'The prompt gets the whole list {{steps.fetch-mails.result.messages}}. With many or large items this overflows the model\'s context. To handle one item per pass, run: workflow add-loop "design" "each-item" --over "{{steps.fetch-mails.result.messages}}" --as item --from "classify" --to "classify". Keep it as is only if the step must see all items at once (for example one summary of all).',
      },
      {
        stepSlug: "classify",
        field: "outputSchema",
        message:
          'Step "classify" returns free text, but "tag-mails" reads its result as data. Add an outputSchema to "classify" so the result has fixed fields.',
      },
    ]);
  });

  test("is silent for the loop version", () => {
    expect(getDesignWarnings(LOOP, schemas)).toEqual([]);
  });

  describe("whole list in a prompt", () => {
    const promptWarnings = (prompt: string | string[], resolve = schemas) =>
      getDesignWarnings(
        withStep(TAGGING, "classify", { type: "agent", prompt, outputSchema: { a: "string" } }),
        resolve,
      )
        .filter((w) => w.field === "prompt")
        .map((w) => w.message);

    test("warns once per list, also when the placeholder repeats or the prompt is an array", () => {
      expect(
        promptWarnings("{{ steps.fetch-mails.result.messages }} and again {{steps.fetch-mails.result.messages}}"),
      ).toHaveLength(1);
      expect(promptWarnings(["Mails:", "{{steps.fetch-mails.result.messages}}"])).toHaveLength(1);
    });

    test("is silent for a function around the path, a scalar list, a scalar, one item, and the length", () => {
      expect(promptWarnings("{{toJson(steps.fetch-mails.result.messages)}}")).toEqual([]);
      expect(promptWarnings("{{steps.fetch-mails.result.folders}}")).toEqual([]);
      expect(promptWarnings("{{steps.fetch-mails.result.count}}")).toEqual([]);
      expect(promptWarnings("{{steps.fetch-mails.result.messages.0}}")).toEqual([]);
      expect(promptWarnings("{{steps.fetch-mails.result.messages.length}}")).toEqual([]);
    });

    test("is silent when the source step has no output schema or the path is unknown", () => {
      expect(promptWarnings("{{steps.fetch-mails.result.messages}}", () => null)).toEqual([]);
      expect(promptWarnings("{{steps.fetch-mails.result.nothing}}")).toEqual([]);
      expect(
        promptWarnings("{{steps.unknown.result.messages}} {{trigger.payload.rows}} {{steps.fetch-mails}}"),
      ).toEqual([]);
    });

    test("is silent for an aggregator's results", () => {
      const summarize = withStep(LOOP, "notify", {
        type: "agent",
        prompt: "Summarize {{steps.each-mail-done.result.results}}",
      });
      const aggregatorSchema: OutputSchema = {
        type: "object",
        properties: { results: { type: "array", items: { type: "object", properties: {} } } },
      };
      expect(
        getDesignWarnings(summarize, (slug) => (slug === "each-mail-done" ? aggregatorSchema : schemas(slug))),
      ).toEqual([]);
    });

    test("inside a loop, says to read the loop variable instead", () => {
      const stale = withStep(LOOP, "classify", {
        type: "agent",
        prompt: "Classify {{steps.fetch-mails.result.messages}}",
        outputSchema: { label: "string" },
      });
      expect(getDesignWarnings(stale, schemas)).toEqual([
        {
          stepSlug: "classify",
          field: "prompt",
          message:
            'The prompt gets the whole list {{steps.fetch-mails.result.messages}} on every pass of the loop "each-mail". Read the current item instead: {{mail}} or {{mail.<field>}}.',
        },
      ]);
    });

    test("inside a loop, another list gets the size warning, not the advice to read the item", () => {
      const other = withStep(LOOP, "classify", {
        type: "agent",
        prompt: "Classify {{mail.subject}} with one of {{steps.fetch-mails.result.labels}}",
        outputSchema: { label: "string" },
      });
      const withLabels: OutputSchema = {
        ...FETCH_SCHEMA,
        properties: {
          ...(FETCH_SCHEMA.properties as object),
          labels: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } },
        },
      };
      const [warning] = getDesignWarnings(other, (slug) => (slug === "fetch-mails" ? withLabels : null));
      expect(warning!.message).toBe(
        'The prompt gets the whole list {{steps.fetch-mails.result.labels}} on every pass of the loop "each-mail". With many or large items this overflows the model\'s context. Keep it only if every pass needs all of these items.',
      );
    });

    test("only looks at agent steps", () => {
      const def = withStep(TAGGING, "classify", {
        type: "http-request",
        body: "{{steps.fetch-mails.result.messages}}",
      });
      expect(getDesignWarnings(def, schemas).filter((w) => w.field !== "outputSchema")).toEqual([]);
    });
  });

  describe("loop step read after the loop", () => {
    const after = (message: string) =>
      getDesignWarnings(withStep(LOOP, "notify", { type: "notify-ntfy", message }), schemas);

    test("warns on a step after the aggregator that reads a body step", () => {
      expect(after("{{steps.classify.result.label}} and {{steps.classify.result}}")).toEqual([
        {
          stepSlug: "notify",
          field: "message",
          message:
            'Step "notify" is after the loop "each-mail" but reads "classify", which runs once per item: it gets only the last pass\'s result. Move "notify" into the loop, or read {{steps.each-mail-done.result.results}}.',
        },
      ]);
    });

    test("is silent for the aggregator's results and for readers inside the same body", () => {
      expect(after("{{steps.each-mail-done.result.results}}")).toEqual([]);
      const inBody = wf(
        {
          ...LOOP.steps,
          store: { type: "notify-ntfy", message: "{{steps.classify.result.label}}" },
        },
        [
          { from: "fetch-mails", to: "each-mail" },
          { from: "each-mail", to: "classify", branch: "each" },
          { from: "classify", to: "store" },
          { from: "store", to: "each-mail-done" },
          { from: "each-mail-done", to: "notify" },
        ],
      );
      expect(getDesignWarnings(inBody, schemas)).toEqual([]);
    });

    test("is silent for a reader that is not after the loop", () => {
      const parallel = wf(
        { ...LOOP.steps, side: { type: "notify-ntfy", message: "{{steps.classify.result.label}}" } },
        [...LOOP.edges, { from: "fetch-mails", to: "side" }],
      );
      expect(getDesignWarnings(parallel, schemas).filter((w) => w.stepSlug === "side")).toEqual([]);
    });
  });

  describe("free text read as data", () => {
    const readBy = (reader: unknown, classify: unknown = { type: "agent", prompt: "Classify" }) =>
      getDesignWarnings(withStep(withStep(TAGGING, "classify", classify), "tag-mails", reader), schemas).filter(
        (w) => w.field === "outputSchema",
      );

    test("is silent for the bare result, in a notification or in another prompt", () => {
      expect(readBy({ type: "notify-ntfy", message: "{{steps.classify.result}}" })).toEqual([]);
      expect(readBy({ type: "agent", prompt: "Act on {{steps.classify.result}}" })).toEqual([]);
      expect(readBy({ type: "notify-ntfy", message: "{{steps.classify.result.length}} chars" })).toEqual([]);
    });

    test("warns on a field read inside an expression and in nested config", () => {
      expect(readBy({ type: "notify-ntfy", message: "{{upper(steps.classify.result.label)}}" })).toHaveLength(1);
      expect(
        readBy({ type: "datatable-insert", row: { label: "{{steps.classify.result.summary.total}}" } }),
      ).toHaveLength(1);
    });

    test("is silent when the agent step has an outputSchema", () => {
      const withSchema = { type: "agent", prompt: "Classify", outputSchema: { label: "string" } };
      expect(readBy({ type: "notify-ntfy", message: "{{steps.classify.result.label}}" }, withSchema)).toEqual([]);
    });

    test("warns once per agent step, naming the first reader", () => {
      const def = withStep(TAGGING, "notify", { type: "notify-ntfy", message: "{{steps.classify.result.count}}" });
      const warnings = getDesignWarnings(def, () => null);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toContain('but "tag-mails" reads');
    });

    test("handles hyphenated agent slugs", () => {
      const def = wf(
        {
          "classify-mails": { type: "agent", prompt: "Classify" },
          notify: { type: "notify-ntfy", message: "{{steps.classify-mails.result.summary.total}}" },
        },
        chain("classify-mails", "notify"),
      );
      expect(getDesignWarnings(def, () => null).map((w) => w.stepSlug)).toEqual(["classify-mails"]);
    });

    describe("through the aggregator", () => {
      const loopWithoutSchema = withStep(LOOP, "classify", { type: "agent", prompt: "Classify {{mail.subject}}" });
      const read = (message: string) =>
        getDesignWarnings(withStep(loopWithoutSchema, "notify", { type: "notify-ntfy", message }), schemas);

      test("warns when a field of a collected agent step is read", () => {
        expect(read("{{steps.each-mail-done.result.results.0.classify.label}}")).toEqual([
          {
            stepSlug: "classify",
            field: "outputSchema",
            message:
              'Step "classify" returns free text, but "notify" reads its result as data. Add an outputSchema to "classify" so the result has fixed fields.',
          },
        ]);
      });

      test("warns for an agent step that is not the last in the body", () => {
        const midBody = {
          ...withStep(loopWithoutSchema, "store", { type: "noop" }),
          edges: loopWithoutSchema.edges.flatMap((e) =>
            e.from === "classify"
              ? [
                  { from: "classify", to: "store" },
                  { ...e, from: "store" },
                ]
              : [e],
          ),
        };
        const def = withStep(midBody, "notify", {
          type: "notify-ntfy",
          message: "{{steps.each-mail-done.result.results.0.classify.label}}",
        });
        expect(getDesignWarnings(def, schemas).map((w) => `${w.stepSlug}.${w.field}`)).toContain(
          "classify.outputSchema",
        );
      });

      test("is silent for the counts, the whole results, and the collected text itself", () => {
        expect(read("{{steps.each-mail-done.result.succeeded}}")).toEqual([]);
        expect(read("{{steps.each-mail-done.result.results}}")).toEqual([]);
        expect(read("{{steps.each-mail-done.result.results.0.classify}}")).toEqual([]);
      });
    });
  });
});

describe("createWorkflowAnalyzer", () => {
  test("reports the design warnings and the undeclared config keys, with the handler's schemas", async () => {
    const handler = {
      schema: Type.Object({
        search: Type.Optional(Type.Composite([Type.Object({ seen: Type.Optional(Type.Boolean()) })])),
      }),
      outputSchema: Type.Object({
        messages: Type.Array(Type.Object({ uid: Type.Number(), subject: Type.String() })),
      }),
    };
    const ctx = {
      tools: { names: () => [] },
      skills: { names: () => [] },
      stepTypes: { get: (type: string) => (type === "imap-fetch" ? handler : undefined) },
      internal: {},
    } as unknown as ExtensionContext;
    const def = withStep(TAGGING, "fetch-mails", { type: "imap-fetch", search: { Seen: false } });
    const { warnings } = await createWorkflowAnalyzer(ctx)(def, { webhook: null, schedule: null, filewatcher: null });
    const located = warnings.map((w) => `${w.stepSlug}.${w.field}`);
    expect(located).toContain("fetch-mails.search.Seen");
    expect(located).toContain("classify.prompt");
    expect(located).toContain("classify.outputSchema");
  });
});
