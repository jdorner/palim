/**
 * Core Workflow Steps extension - provides built-in workflow step types
 * that execute deterministic (non-LLM) logic.
 *
 * Currently registered step types:
 * - `http-request` - Makes outbound HTTP requests with configurable method,
 *   headers, body, timeout, and response format handling.
 * - `fail` - Immediately aborts the workflow run with a configurable error
 *   message. Useful in control-flow branches to signal unexpected states.
 *
 * This extension is marked `core: true` and cannot be disabled since these
 * step types are fundamental workflow building blocks.
 */

import type { Extension, ExtensionContext, ExtensionManifest } from "@ext/types";
import { createFailHandler } from "./fail";
import { createHttpRequestHandler } from "./http-request";

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
  },

  async shutdown() {
    // No resources to clean up
  },
};

export default extension;
