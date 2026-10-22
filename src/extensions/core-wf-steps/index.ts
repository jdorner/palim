/**
 * Core Workflow Steps extension - provides built-in workflow step types
 * that execute deterministic (non-LLM) logic.
 *
 * Currently registered step types:
 * - `http-request` - Makes outbound HTTP requests with configurable method,
 *   headers, body, timeout, and response format handling.
 * - `fail` - Immediately aborts the workflow run with a configurable error
 *   message. Useful in control-flow branches to signal unexpected states.
 * - `noop` - Does nothing and succeeds. Marks a control-flow branch (e.g. the
 *   `else` of an `if`) as intentionally ending.
 * - `start-workflow` - Dispatches another named workflow in a fire-and-forget
 *   fashion (no join, no result propagation, independent lifecycle).
 * - `chunk` - Splits a string or array into fixed-size batches, typically fed
 *   into an `iterator` so large inputs can be processed in manageable pieces.
 * - `set-variables` - Defines workflow-local variables (literal or template
 *   values, optionally typed) referenceable by successor steps; supports
 *   accumulating values across iterations via self-reference.
 *
 * This extension is marked `core: true` and cannot be disabled since these
 * step types are fundamental workflow building blocks.
 */

import type { Extension, ExtensionContext, ExtensionManifest, StepTypeHandler } from "@ext/types";
import { createChunkHandler } from "./chunk";
import { createFailHandler } from "./fail";
import { createHttpRequestHandler } from "./http-request";
import { createNoopHandler } from "./noop";
import { createSetVariablesHandler } from "./setVariables";
import { createStartWorkflowHandler, WORKFLOW_NAMES_PROVIDER } from "./start-workflow";

const manifest = {
  name: "core-wf-steps",
  version: "1.3.0",
  description: "Built-in workflow step types (HTTP Request, etc.)",
  dependencies: ["workflows"],
  core: true,
} satisfies ExtensionManifest;

/**
 * Attaches the Markdown usage reference in `stepDocs/<type>.md` to a handler.
 *
 * @param type - Step type identifier (the doc file's base name)
 * @param handler - The step type handler
 * @returns The handler with `docs` set
 */
async function withDocs(type: string, handler: StepTypeHandler): Promise<StepTypeHandler> {
  return { ...handler, docs: await Bun.file(`${import.meta.dir}/stepDocs/${type}.md`).text() };
}

const extension: Extension = {
  manifest,

  async initialize(ctx: ExtensionContext) {
    ctx.stepTypes.register("http-request", await withDocs("http-request", createHttpRequestHandler()));
    ctx.stepTypes.register("fail", await withDocs("fail", createFailHandler()));
    ctx.stepTypes.register("noop", await withDocs("noop", createNoopHandler()));
    ctx.stepTypes.register("chunk", await withDocs("chunk", createChunkHandler()));
    ctx.stepTypes.register("set-variables", await withDocs("set-variables", createSetVariablesHandler()));

    // Populate the start-workflow step's "Workflow Name" dropdown in the editor
    // with the current set of loaded workflow names, resolved at request time.
    ctx.dynamicItems.register(WORKFLOW_NAMES_PROVIDER, () => ctx.workflows.names().slice().sort());

    ctx.stepTypes.register(
      "start-workflow",
      await withDocs(
        "start-workflow",
        createStartWorkflowHandler(
          (name, payload) => ctx.workflows.dispatch(name, payload),
          () => ctx.workflows.names(),
        ),
      ),
    );
  },

  async shutdown() {
    // No resources to clean up
  },
};

export default extension;
