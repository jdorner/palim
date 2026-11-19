/**
 * Keeps the in-memory workflow store in sync with the workflow files, one file
 * at a time.
 *
 * A workflow's name comes from its `name` field, not its file name, so the
 * index remembers which workflow each file defines. That lets a single-file
 * reload drop the right entry when a file becomes invalid, is deleted, or
 * renames its workflow, without rescanning the whole directory.
 *
 * It also keeps why each skipped file is not loaded (invalid, or a duplicate
 * name), so the API and the sandbox CLI can report it instead of the workflow
 * silently missing.
 *
 * @module
 */

import type { Logger } from "@ext/types";
import type { WorkflowLoadError } from "@shared/workflows";
import type { DagWorkflowDefinition } from "./schemas";

/** A workflow definition and the file (relative to the workflows directory) it was loaded from. */
export interface LoadedWorkflowFile {
  file: string;
  definition: DagWorkflowDefinition;
}

/**
 * Explains why a workflow name is missing from the store.
 *
 * @param name - Workflow name that was not found
 * @param loadError - The load error that explains it, if any (from {@link WorkflowFileIndex.loadErrorFor})
 * @returns `Workflow not found: <name>`, or which file is broken and why
 */
export function missingWorkflowMessage(name: string, loadError: WorkflowLoadError | undefined): string {
  if (!loadError) return `Workflow not found: ${name}`;
  return `Workflow "${name}" is not loaded because ${loadError.file} is invalid: ${loadError.error}`;
}

/** Per-file updates of a workflow store. */
export interface WorkflowFileIndex {
  /**
   * Replaces the whole store with a full directory scan.
   *
   * @param loaded - The valid workflows found, in scan order (first file wins a duplicate name)
   * @param errors - Why the other files of the scan were skipped as invalid
   */
  replaceAll(loaded: LoadedWorkflowFile[], errors?: WorkflowLoadError[]): void;
  /**
   * Applies the current state of one file.
   *
   * @param file - File name relative to the workflows directory
   * @param definition - The file's valid, enabled definition, or `null` when it is gone, invalid, or disabled
   * @param error - Why the file is invalid, when `definition` is `null` for that reason
   */
  applyFile(file: string, definition: DagWorkflowDefinition | null, error?: WorkflowLoadError): void;
  /**
   * Lists the files that are currently not loaded because of an error.
   *
   * @returns The load errors, sorted by file name
   */
  loadErrors(): WorkflowLoadError[];
  /**
   * Finds the load error that explains why a workflow is missing: a broken
   * file whose `name` (or, when unreadable, file name) matches, or the file
   * that defined it before an edit broke it.
   *
   * @param name - Workflow name that was not found in the store
   * @returns The matching load error, or `undefined` when none explains it
   */
  loadErrorFor(name: string): WorkflowLoadError | undefined;
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
  /** Why each skipped file is not loaded. */
  const errorByFile = new Map<string, WorkflowLoadError>();

  function duplicateError(file: string, name: string, owner: string): WorkflowLoadError {
    return { file, name, error: `Duplicate workflow name "${name}" (already defined in ${owner})` };
  }

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
    replaceAll(loaded, errors = []) {
      store.clear();
      nameByFile.clear();
      errorByFile.clear();
      for (const error of errors) errorByFile.set(error.file, error);
      for (const { file, definition } of loaded) {
        if (store.has(definition.name)) {
          log.warn(`Duplicate workflow name "${definition.name}" from ${file}, skipping`);
          errorByFile.set(file, duplicateError(file, definition.name, fileDefining(definition.name)!));
          continue;
        }
        store.set(definition.name, definition);
        nameByFile.set(file, definition.name);
      }
    },

    applyFile(file, definition, error) {
      errorByFile.delete(file);
      if (!definition) {
        const previous = nameByFile.get(file);
        removeFile(file);
        if (error) errorByFile.set(file, previous === undefined ? error : { ...error, unloaded: previous });
        return;
      }
      const owner = fileDefining(definition.name);
      if (owner !== undefined && owner !== file) {
        // Same rule as a full scan: the file that has the name keeps it.
        log.warn(`Duplicate workflow name "${definition.name}" from ${file} (already defined in ${owner}), skipping`);
        const previous = nameByFile.get(file);
        removeFile(file);
        const duplicate = duplicateError(file, definition.name, owner);
        errorByFile.set(file, previous === undefined ? duplicate : { ...duplicate, unloaded: previous });
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

    loadErrors() {
      return [...errorByFile.values()].sort((a, b) => a.file.localeCompare(b.file));
    },

    loadErrorFor(name) {
      const errors = [...errorByFile.values()];
      return (
        errors.find((e) => e.name === name) ??
        errors.find((e) => e.unloaded === name) ??
        errors.find((e) => e.name === undefined && e.file === `${name}.json5`)
      );
    },
  };
}
