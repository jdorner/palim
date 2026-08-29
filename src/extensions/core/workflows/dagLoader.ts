/**
 * DAG Workflow JSON5 loader - scans `WORK_DIR/workflows/` for JSON5 files,
 * parses them, and validates against the DAG TypeBox schema plus structural
 * DAG validation (cycles, connectivity, CF-edge rules).
 *
 * @module
 */

import { formatValidationErrors } from "@ext/sdk";
import type { Logger } from "@ext/types";
import { Value } from "@sinclair/typebox/value";
import { validateCfEdges, validateDag, validateIteratorPairing } from "./dagValidation";
import { type DagWorkflowDefinition, DagWorkflowDefinitionSchema, normalizePrompt } from "./schemas";

/**
 * Loads, parses, validates, and normalizes a single workflow JSON5 file.
 *
 * Returns `null` when the file is invalid, structurally broken, disabled,
 * or has a duplicate name (same rules as the full-scanner skip logic).
 *
 * @param filePath - Absolute path to the JSON5 file
 * @param log - Logger instance for reporting errors
 * @returns The validated DAG definition, or `null` if skipped
 */
export async function loadSingleWorkflow(filePath: string, log: Logger): Promise<DagWorkflowDefinition | null> {
  const filename = filePath.split("/").pop()!;

  try {
    const content = await Bun.file(filePath).text();
    const parsed = Bun.JSON5.parse(content);

    if (!Value.Check(DagWorkflowDefinitionSchema, parsed)) {
      log.error(`Invalid workflow ${filename}: ${formatValidationErrors(DagWorkflowDefinitionSchema, parsed)}`);
      return null;
    }

    const definition = parsed as DagWorkflowDefinition;

    // Structural DAG validation
    const dagErrors = validateDag(definition);
    const cfErrors = validateCfEdges(definition);
    const allErrors = [...dagErrors, ...cfErrors];
    if (allErrors.length > 0) {
      log.error(`Invalid workflow ${filename}: ${allErrors.map((e) => e.message).join("; ")}`);
      return null;
    }

    // Iterator/aggregator pairing validation (non-blocking warnings)
    const pairingErrors = validateIteratorPairing(definition);
    if (pairingErrors.length > 0) {
      log.warn(`Workflow ${filename} has pairing issues: ${pairingErrors.map((e) => e.message).join("; ")}`);
    }

    // Normalize agent prompt arrays to strings
    for (const stepDef of Object.values(definition.steps)) {
      if (stepDef.type === "agent") {
        const agentStep = stepDef as { type: "agent"; prompt: string | string[] };
        agentStep.prompt = normalizePrompt(agentStep.prompt);
      }
    }

    // Skip disabled workflows
    if (definition.enabled === false) {
      log.debug(`Skipping disabled workflow "${definition.name}" from ${filename}`);
      return null;
    }

    return definition;
  } catch (err) {
    log.error(`Failed to load workflow ${filename}:`, err);
    return null;
  }
}

/**
 * Load all valid DAG workflow definitions from a directory.
 *
 * Scans for `*.json5` files, parses each with `Bun.JSON5.parse()`, validates
 * against {@link DagWorkflowDefinitionSchema}, and runs structural DAG validation
 * (edge reference integrity, cycle detection, connectivity, CF-edge rules).
 * Invalid files are logged and skipped.
 *
 * @param workflowsDir - Absolute path to the workflows directory
 * @param log - Logger instance for reporting errors
 * @returns Map of workflow name -> validated DAG definition
 */
export async function loadDagWorkflows(workflowsDir: string, log: Logger): Promise<Map<string, DagWorkflowDefinition>> {
  const workflows = new Map<string, DagWorkflowDefinition>();

  const glob = new Bun.Glob("*.json5");
  let entries: string[];

  try {
    entries = [...glob.scanSync({ cwd: workflowsDir, absolute: false })];
  } catch {
    log.debug(`Workflows directory not found or unreadable: ${workflowsDir}`);
    return workflows;
  }

  for (const entry of entries) {
    const filePath = `${workflowsDir}/${entry}`;
    const definition = await loadSingleWorkflow(filePath, log);
    if (!definition) continue;

    if (workflows.has(definition.name)) {
      log.warn(`Duplicate workflow name "${definition.name}" from ${entry}, skipping`);
      continue;
    }

    workflows.set(definition.name, definition);
    log.info(
      `Loaded workflow "${definition.name}" (${Object.keys(definition.steps).length} steps, ${definition.edges.length} edges) from ${entry}`,
    );
  }

  return workflows;
}
