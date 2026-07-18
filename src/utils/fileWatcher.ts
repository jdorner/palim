import EventEmitter from "node:events";
import type { PathLike } from "node:fs";
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
}

/**
 * Watches a directory for file system events and emits typed events.
 *
 * @fires new - When a file is created or renamed
 * @fires change - When a file's content changes
 * @fires delete - When a file is deleted
 * @fires error - When a watcher error occurs
 * @fires close - When the watcher is closed
 */
export class FileWatcher extends EventEmitter<FileWatcherEvents> {
  private watcher: FSWatcher | undefined = undefined;

  constructor(
    private fileOrPath: PathLike,
    private options: FileWatcherOptions = {},
  ) {
    super();
  }

  /** Start watching the configured path for file system events. */
  public async start() {
    this.watcher = chokidar.watch(this.fileOrPath.toString(), {
      persistent: true,
      usePolling: false,
      ignoreInitial: !this.options.processExistingOnStart,
      depth: this.options.recursive === true ? undefined : 0,
    });

    this.watcher.on("unlink", (filePath) => {
      this.emit("delete", filePath);
    });

    this.watcher.on("add", (filePath) => {
      this.emit("new", filePath);
    });

    this.watcher.on("change", (filePath) => {
      this.emit("change", filePath);
    });

    this.watcher.on("error", (err) => {
      const message = err instanceof Error ? err : new Error(String(err));
      log.error("File watcher error:", message);
      this.emit("error", message);
    });
  }

  /** Stop watching and close the underlying FSWatcher. */
  public async close(): Promise<void> {
    await this.watcher?.close();
  }
}
