/**
 * Core Workflow Steps extension - provides built-in workflow step types
 * that execute deterministic (non-LLM) logic.
 *
 * Currently registered step types:
 * - `http-request` - Makes outbound HTTP requests with configurable method,
 *   headers, body, timeout, and response format handling.
 * - `fail` - Immediately aborts the workflow run with a configurable error
 *   message. Useful in control-flow branches to signal unexpected states.
 * - `start-workflow` - Dispatches another named workflow in a fire-and-forget
 *   fashion (no join, no result propagation, independent lifecycle).
 * - `for-each` - Iterates over an array and executes a sub-DAG of steps for
 *   each element (supports concurrency and configurable failure strategies).
 *
 * This extension is marked `core: true` and cannot be disabled since these
 * step types are fundamental workflow building blocks.
 */

import type { Extension, ExtensionContext, ExtensionManifest } from "@ext/types";
import { createFailHandler } from "./fail";
import { createForEachHandler } from "./for-each";
import { createHttpRequestHandler } from "./http-request";
import { createStartWorkflowHandler, WORKFLOW_NAMES_PROVIDER } from "./start-workflow";

const manifest = {
  name: "core-wf-steps",
  version: "1.0.0",
  description: "Built-in workflow step types (HTTP Request, etc.)",
  dependencies: ["workflows"],
  core: true,
} satisfies ExtensionManifest;

const extension: Extension = {
  manifest,

  async initialize(ctx: ExtensionContext) {
    ctx.stepTypes.register("http-request", createHttpRequestHandler());
    ctx.stepTypes.register("fail", createFailHandler());

    // Populate the start-workflow step's "Workflow Name" dropdown in the editor
    // with the current set of loaded workflow names, resolved at request time.
    ctx.dynamicItems.register(WORKFLOW_NAMES_PROVIDER, () => ctx.workflows.names().slice().sort());

    ctx.stepTypes.register(
      "start-workflow",
      createStartWorkflowHandler(
        (name, payload) => ctx.workflows.dispatch(name, payload),
        () => ctx.workflows.names(),
      ),
    );

    ctx.stepTypes.register(
      "for-each",
      createForEachHandler({
        getStepHandler: (type) => ctx.stepTypes.get(type),
      }),
    );
  },

  async shutdown() {
    // No resources to clean up
  },
};

export default extension;
