/**
 * Excel Writer extension — provides an "excel" workflow step type
 * for generating and appending to .xlsx files.
 *
 * This extension registers a custom workflow step type handler that
 * produces Excel files deterministically (no LLM involvement).
 * It supports two modes:
 * - `create`: Generate a new .xlsx file from structured data
 * - `append`: Add rows to an existing .xlsx file
 *
 * Data is typically passed from previous workflow steps via template
 * expressions (e.g. `{{steps.extract.result}}`).
 */

import type { Extension, ExtensionContext, ExtensionManifest } from "@ext/types";
import { createExcelHandler } from "./handler";

const manifest = {
  name: "excel-writer",
  version: "1.0.0",
  description: "Workflow step type for generating and appending to Excel (.xlsx) files",
} satisfies ExtensionManifest;

/**
 * Creates a fresh Excel Writer extension instance.
 *
 * @returns An {@link Extension} object ready to be loaded by the registry
 */
export function createExtension(): Extension {
  return {
    manifest,

    async initialize(ctx: ExtensionContext) {
      const handler = createExcelHandler();
      ctx.registerStepType("excel", handler);
      ctx.log.info("Registered 'excel' workflow step type");
    },

    async shutdown() {
      // No resources to clean up
    },
  };
}

export default createExtension();
