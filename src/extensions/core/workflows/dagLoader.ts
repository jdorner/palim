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
import type { LoadedWorkflowFile } from "./workflowFileIndex";

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
 * Loads every valid DAG workflow file in a directory, with the file each came from.
 *
 * Scans for `*.json5` files and loads each with {@link loadSingleWorkflow}.
 * Invalid and disabled files are logged and skipped. Duplicate names are
 * kept, so the caller decides which file wins.
 *
 * @param workflowsDir - Absolute path to the workflows directory
 * @param log - Logger instance for reporting errors
 * @returns The loaded workflows in scan order
 */
export async function loadDagWorkflowFiles(workflowsDir: string, log: Logger): Promise<LoadedWorkflowFile[]> {
  const glob = new Bun.Glob("*.json5");
  let entries: string[];

  try {
    entries = [...glob.scanSync({ cwd: workflowsDir, absolute: false })];
  } catch {
    log.debug(`Workflows directory not found or unreadable: ${workflowsDir}`);
    return [];
  }

  const loaded: LoadedWorkflowFile[] = [];
  for (const entry of entries) {
    const definition = await loadSingleWorkflow(`${workflowsDir}/${entry}`, log);
    if (definition) loaded.push({ file: entry, definition });
  }
  return loaded;
}

/**
 * Load all valid DAG workflow definitions from a directory.
 *
 * Scans for `*.json5` files, parses each with `Bun.JSON5.parse()`, validates
 * against {@link DagWorkflowDefinitionSchema}, and runs structural DAG validation
 * (edge reference integrity, cycle detection, connectivity, CF-edge rules).
 * Invalid files are logged and skipped; of duplicate names the first file wins.
 *
 * @param workflowsDir - Absolute path to the workflows directory
 * @param log - Logger instance for reporting errors
 * @returns Map of workflow name -> validated DAG definition
 */
export async function loadDagWorkflows(workflowsDir: string, log: Logger): Promise<Map<string, DagWorkflowDefinition>> {
  const workflows = new Map<string, DagWorkflowDefinition>();
  for (const { file, definition } of await loadDagWorkflowFiles(workflowsDir, log)) {
    if (workflows.has(definition.name)) {
      log.warn(`Duplicate workflow name "${definition.name}" from ${file}, skipping`);
      continue;
    }
    workflows.set(definition.name, definition);
  }
  return workflows;
}
