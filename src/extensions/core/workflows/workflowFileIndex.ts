/**
 * Keeps the in-memory workflow store in sync with the workflow files, one file
 * at a time.
 *
 * A workflow's name comes from its `name` field, not its file name, so the
 * index remembers which workflow each file defines. That lets a single-file
 * reload drop the right entry when a file becomes invalid, is deleted, or
 * renames its workflow, without rescanning the whole directory.
 *
 * @module
 */

import type { Logger } from "@ext/types";
import type { DagWorkflowDefinition } from "./schemas";

/** A workflow definition and the file (relative to the workflows directory) it was loaded from. */
export interface LoadedWorkflowFile {
  file: string;
  definition: DagWorkflowDefinition;
}

/** Per-file updates of a workflow store. */
export interface WorkflowFileIndex {
  /**
   * Replaces the whole store with a full directory scan.
   *
   * @param loaded - The valid workflows found, in scan order (first file wins a duplicate name)
   */
  replaceAll(loaded: LoadedWorkflowFile[]): void;
  /**
   * Applies the current state of one file.
   *
   * @param file - File name relative to the workflows directory
   * @param definition - The file's valid, enabled definition, or `null` when it is gone, invalid, or disabled
   */
  applyFile(file: string, definition: DagWorkflowDefinition | null): void;
}

/**
 * Creates the index for a store. The store stays the single source of truth
 * for lookups; routes may still update entries of existing workflows directly.
 *
 * @param store - Workflow definitions by name
 * @param log - Logger for the reload messages
 * @returns The index
 */
export function createWorkflowFileIndex(store: Map<string, DagWorkflowDefinition>, log: Logger): WorkflowFileIndex {
  /** Workflow name defined by each loaded file. */
  const nameByFile = new Map<string, string>();

  function fileDefining(name: string): string | undefined {
    for (const [file, n] of nameByFile) if (n === name) return file;
    return undefined;
  }

  function removeFile(file: string): void {
    const previous = nameByFile.get(file);
    if (previous === undefined) return;
    nameByFile.delete(file);
    if (store.delete(previous)) log.info(`Removed workflow "${previous}" (${file})`);
  }

  return {
    replaceAll(loaded) {
      store.clear();
      nameByFile.clear();
      for (const { file, definition } of loaded) {
        if (store.has(definition.name)) {
          log.warn(`Duplicate workflow name "${definition.name}" from ${file}, skipping`);
          continue;
        }
        store.set(definition.name, definition);
        nameByFile.set(file, definition.name);
      }
    },

    applyFile(file, definition) {
      if (!definition) {
        removeFile(file);
        return;
      }
      const owner = fileDefining(definition.name);
      if (owner !== undefined && owner !== file) {
        // Same rule as a full scan: the file that has the name keeps it.
        log.warn(`Duplicate workflow name "${definition.name}" from ${file} (already defined in ${owner}), skipping`);
        removeFile(file);
        return;
      }
      const previous = nameByFile.get(file);
      if (previous !== undefined && previous !== definition.name) {
        store.delete(previous);
        log.info(`Workflow "${previous}" was renamed to "${definition.name}" (${file})`);
      }
      store.set(definition.name, definition);
      nameByFile.set(file, definition.name);
      log.info(
        `Reloaded workflow "${definition.name}" (${Object.keys(definition.steps).length} steps, ${definition.edges.length} edges) from ${file}`,
      );
    },
  };
}
