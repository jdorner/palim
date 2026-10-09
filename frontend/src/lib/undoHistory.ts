/**
 * Snapshot-based undo/redo history.
 *
 * Stores whole immutable snapshots rather than inverse operations: callers
 * record the state *before* each change, and undo/redo swap snapshots between
 * the two stacks. Cheap when snapshots share structure (e.g. drafts updated via
 * object spread).
 *
 * Consecutive records with the same coalescing key inside a short time window
 * collapse into one undo step, so typing into a field undoes as a single edit.
 *
 * @module
 */

/** Options for {@link UndoHistory}. */
export interface UndoHistoryOptions {
  /** Maximum number of undo steps kept; the oldest are dropped first. Default 100. */
  limit?: number;
  /** Time window (ms) within which same-key records coalesce. Default 1000. */
  coalesceMs?: number;
  /** Clock source, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Undo/redo stack of immutable snapshots.
 *
 * @typeParam T - Snapshot type. Must not be mutated after it is recorded.
 */
export class UndoHistory<T> {
  private undoStack: T[] = [];
  private redoStack: T[] = [];
  private lastKey: string | undefined;
  private lastAt = 0;
  private readonly limit: number;
  private readonly coalesceMs: number;
  private readonly now: () => number;

  /**
   * @param options - History limits and clock; see {@link UndoHistoryOptions}.
   */
  constructor(options: UndoHistoryOptions = {}) {
    this.limit = options.limit ?? 100;
    this.coalesceMs = options.coalesceMs ?? 1000;
    this.now = options.now ?? Date.now;
  }

  /** Whether there is a step to undo. */
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Whether there is a step to redo. */
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Records the state before a change and clears the redo stack.
   *
   * When `key` matches the previous record's key and that record is younger
   * than the coalescing window, no new step is pushed: the earlier snapshot
   * already covers this change. Each coalesced record extends the window.
   *
   * @param previous - The state as it was before the change.
   * @param key - Optional coalescing key (e.g. `step:<id>`); omit for discrete operations.
   */
  record(previous: T, key?: string): void {
    const at = this.now();
    const coalesce =
      key !== undefined && key === this.lastKey && this.undoStack.length > 0 && at - this.lastAt < this.coalesceMs;
    this.lastKey = key;
    this.lastAt = at;
    this.redoStack = [];
    if (coalesce) return;

    this.undoStack.push(previous);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
  }

  /**
   * Steps back one change.
   *
   * @param current - The current state, pushed onto the redo stack.
   * @returns The state to restore, or `undefined` if there is nothing to undo.
   */
  undo(current: T): T | undefined {
    const previous = this.undoStack.pop();
    if (previous === undefined) return undefined;
    this.redoStack.push(current);
    this.breakCoalescing();
    return previous;
  }

  /**
   * Re-applies the last undone change.
   *
   * @param current - The current state, pushed onto the undo stack.
   * @returns The state to restore, or `undefined` if there is nothing to redo.
   */
  redo(current: T): T | undefined {
    const next = this.redoStack.pop();
    if (next === undefined) return undefined;
    this.undoStack.push(current);
    this.breakCoalescing();
    return next;
  }

  /** Ends the current coalescing run, so the next record always starts a new step. */
  breakCoalescing(): void {
    this.lastKey = undefined;
  }

  /** Drops all history. */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.breakCoalescing();
  }
}
