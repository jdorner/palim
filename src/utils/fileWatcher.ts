import EventEmitter from "node:events";
import type { PathLike } from "node:fs";
import fs from "node:fs";
import { mainLogger as log } from "@src/utils/logger";
import chokidar, { type FSWatcher } from "chokidar";

interface FileWatcherEvents {
  new: [filename: string];
  change: [filename: string];
  delete: [filename: string];
  error: [Error];
}

interface FileWatcherOptions {
  /**
   * Watch for changes on files recursively.
   *
   * @default false
   */
  recursive?: boolean;
  /**
   * If true, scans the given path for existing files and emits `new` events for them.
   *
   * @default false
   */
  processExistingOnStart?: boolean;
  /**
   * Use polling instead of native fs events. More reliable for detecting
   * rapid delete+add cycles (e.g. file moves into a watched directory) at
   * the cost of slightly higher CPU usage.
   *
   * @default false
   */
  usePolling?: boolean;
  /**
   * Polling interval in milliseconds (only relevant when usePolling is true).
   *
   * @default 500
   */
  pollingInterval?: number;
}

/** Minimum time (ms) a file's size must remain stable before emitting. */
const STABILITY_THRESHOLD = 1500;
/** Interval (ms) between size checks for write stabilization. */
const STABILITY_POLL_INTERVAL = 200;

/**
 * Watches a directory for file system events and emits typed events.
 *
 * Uses manual write-finish stabilization instead of chokidar's built-in
 * `awaitWriteFinish` to avoid a race condition where atomically-moved files
 * can be missed when multiple files arrive simultaneously.
 *
 * @fires new - When a file is created or renamed
 * @fires change - When a file's content changes
 * @fires delete - When a file is deleted
 * @fires error - When a watcher error occurs
 */
export class FileWatcher extends EventEmitter<FileWatcherEvents> {
  private watcher: FSWatcher | undefined = undefined;
  private pendingFiles = new Map<string, { size: number; stableSince: number; timer: Timer }>();

  constructor(
    private fileOrPath: PathLike,
    private options: FileWatcherOptions = {},
  ) {
    super();
  }

  /** Start watching the configured path for file system events. */
  public async start() {
    const polling = this.options.usePolling ?? false;
    this.watcher = chokidar.watch(this.fileOrPath.toString(), {
      persistent: true,
      usePolling: polling,
      interval: polling ? (this.options.pollingInterval ?? 500) : undefined,
      ignoreInitial: !this.options.processExistingOnStart,
      depth: this.options.recursive === true ? undefined : 0,
    });

    this.watcher.on("unlink", (filePath) => {
      // Cancel any pending stabilization for this file
      this.cancelPending(filePath);
      this.emit("delete", filePath);
    });

    this.watcher.on("add", (filePath) => {
      this.stabilize(filePath, "new");
    });

    this.watcher.on("change", (filePath) => {
      this.stabilize(filePath, "change");
    });

    this.watcher.on("error", (err) => {
      const message = err instanceof Error ? err : new Error(String(err));
      log.error("File watcher error:", message);
      this.emit("error", message);
    });
  }

  /**
   * Waits for a file's size to stabilize before emitting the event.
   * If the file was moved atomically (size is stable immediately), it emits
   * after a single threshold period. Resets the stability timer on size changes.
   *
   * @param filePath - Absolute path to the file
   * @param event - Event type to emit once stable
   */
  private stabilize(filePath: string, event: "new" | "change"): void {
    // If already pending, the poll loop will handle size changes
    if (this.pendingFiles.has(filePath)) return;

    let currentSize: number;
    try {
      currentSize = fs.statSync(filePath).size;
    } catch {
      // File disappeared before we could stat it — ignore
      return;
    }

    const entry = {
      size: currentSize,
      stableSince: Date.now(),
      timer: setInterval(() => {
        let newSize: number;
        try {
          newSize = fs.statSync(filePath).size;
        } catch {
          // File disappeared — clean up
          this.cancelPending(filePath);
          return;
        }

        if (newSize !== entry.size) {
          // Size changed — reset stability timer
          entry.size = newSize;
          entry.stableSince = Date.now();
          return;
        }

        if (Date.now() - entry.stableSince >= STABILITY_THRESHOLD) {
          // Stable long enough — emit and clean up
          this.cancelPending(filePath);
          this.emit(event, filePath);
        }
      }, STABILITY_POLL_INTERVAL),
    };

    this.pendingFiles.set(filePath, entry);
  }

  /**
   * Cancels pending stabilization for a file path.
   *
   * @param filePath - The file path to cancel
   */
  private cancelPending(filePath: string): void {
    const pending = this.pendingFiles.get(filePath);
    if (pending) {
      clearInterval(pending.timer);
      this.pendingFiles.delete(filePath);
    }
  }

  /** Stop watching and close the underlying FSWatcher. */
  public async close(): Promise<void> {
    // Clean up all pending timers
    for (const [, entry] of this.pendingFiles) {
      clearInterval(entry.timer);
    }
    this.pendingFiles.clear();
    await this.watcher?.close();
  }
}
