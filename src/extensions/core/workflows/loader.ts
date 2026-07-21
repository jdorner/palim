/**
 * Workflow JSON5 loader - scans `WORK_DIR/workflows/` for JSON5 files,
 * parses them, and validates against the TypeBox schema.
 */

import { formatValidationErrors } from "@ext/sdk";
import type { Logger } from "@ext/types";
import { Value } from "@sinclair/typebox/value";
import { normalizePrompt, type WorkflowDefinition, WorkflowDefinitionSchema } from "./schemas";
import type { TemplateSecretResolver } from "./template";
import { validateWorkflowTemplates } from "./templateValidation";

/**
 * Options for workflow loading.
 */
export interface LoadWorkflowsOptions {
  /** Secret resolver for validating `{{secret.<KEY>}}` expressions at load time. */
  secretStore?: TemplateSecretResolver;
}

/**
 * Load all valid workflow definitions from a directory.
 *
 * Scans for `*.json5` files, parses each with `Bun.JSON5.parse()`, validates
 * against {@link WorkflowDefinitionSchema}, and returns the valid ones.
 * Invalid files are logged and skipped.
 *
 * After schema validation, performs a dry-run template validation pass that
 * checks step slug references, forward references, expression syntax, env
 * allowlist compliance, and optionally secret key existence.
 *
 * @param workflowsDir - Absolute path to the workflows directory
 * @param log - Logger instance for reporting errors
 * @param options - Optional loading configuration (secret store for key checks)
 * @returns Map of workflow name -> validated definition
 */
export async function loadWorkflows(
  workflowsDir: string,
  log: Logger,
  options: LoadWorkflowsOptions = {},
): Promise<Map<string, WorkflowDefinition>> {
  const workflows = new Map<string, WorkflowDefinition>();

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
    try {
      const content = await Bun.file(filePath).text();
      const parsed = Bun.JSON5.parse(content);

      if (!Value.Check(WorkflowDefinitionSchema, parsed)) {
        log.error(`Invalid workflow ${entry}: ${formatValidationErrors(WorkflowDefinitionSchema, parsed)}`);
        continue;
      }

      // Normalize prompt arrays to strings
      const definition = parsed as WorkflowDefinition;
      for (const step of definition.steps) {
        if (step.type === "agent") {
          step.prompt = normalizePrompt(step.prompt);
        }
      }

      // Check for duplicate step slugs
      const slugs = new Set<string>();
      let hasDuplicates = false;
      for (const step of definition.steps) {
        if (slugs.has(step.slug)) {
          log.error(`Invalid workflow ${entry}: duplicate step slug "${step.slug}"`);
          hasDuplicates = true;
          break;
        }
        slugs.add(step.slug);
      }
      if (hasDuplicates) continue;

      // Template expression validation (dry-run)
      const templateWarnings = await validateWorkflowTemplates(definition, {
        secretStore: options.secretStore,
        workflowName: definition.name,
      });
      if (templateWarnings.length > 0) {
        const summary = templateWarnings.map((w) => `[${w.stepSlug}.${w.field}] ${w.message}`).join("; ");
        log.warn(`Workflow "${definition.name}" has template issues: ${summary}`);
      }

      // Skip disabled workflows
      if (definition.enabled === false) {
        log.debug(`Skipping disabled workflow "${definition.name}" from ${entry}`);
        continue;
      }

      if (workflows.has(definition.name)) {
        log.warn(`Duplicate workflow name "${definition.name}" from ${entry}, skipping`);
        continue;
      }

      workflows.set(definition.name, definition);
      log.info(`Loaded workflow "${definition.name}" (${definition.steps.length} steps) from ${entry}`);
    } catch (err) {
      log.error(`Failed to load workflow ${entry}:`, err);
    }
  }

  return workflows;
}
