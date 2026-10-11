/**
 * Debounced reload scheduling for workflow definition files.
 *
 * File watcher events arrive in bursts (an editor save, or several files
 * written at once). Every change within the debounce window is collected, so
 * a later change never drops the reload of an earlier file.
 *
 * @module
 */

/** Callbacks of a {@link createReloadScheduler}. */
export interface ReloadSchedulerOptions {
  /** Debounce window in milliseconds. */
  delayMs: number;
  /** Reloads (or removes) a single workflow file. */
  reloadFile: (filename: string) => Promise<void>;
  /** Reloads all workflow files from disk. */
  reloadAll: () => Promise<void>;
  /** Called once after each batch, whether or not it failed. */
  onReloaded: () => void;
  /** Called when a reload throws. */
  onError: (err: unknown) => void;
}

/** A debounced reload scheduler. */
export interface ReloadScheduler {
  /**
   * Schedules a reload of one file, or of all files when `filename` is omitted.
   *
   * @param filename - The changed file (relative to the workflows directory)
   */
  schedule(filename?: string): void;
  /** Cancels a pending reload. */
  cancel(): void;
}

/**
 * Creates a debounced reload scheduler. Within one window, a full reload
 * request supersedes the single-file ones; otherwise each changed file is
 * reloaded once.
 *
 * @param options - Timing and reload callbacks
 * @returns The scheduler
 */
export function createReloadScheduler(options: ReloadSchedulerOptions): ReloadScheduler {
  const pending = new Set<string>();
  let reloadAll = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush(): Promise<void> {
    timer = null;
    const files = [...pending];
    const all = reloadAll;
    pending.clear();
    reloadAll = false;
    // One failing file must not keep the others from reloading.
    const reloads = all ? [() => options.reloadAll()] : files.map((f) => () => options.reloadFile(f));
    for (const reload of reloads) {
      try {
        await reload();
      } catch (err) {
        options.onError(err);
      }
    }
    options.onReloaded();
  }

  return {
    schedule(filename) {
      if (filename) pending.add(filename);
      else reloadAll = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), options.delayMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending.clear();
      reloadAll = false;
    },
  };
}
