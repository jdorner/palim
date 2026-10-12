/**
 * Watches the workflows directory for added, changed, and removed JSON5 files.
 *
 * Uses chokidar rather than `node:fs` `watch`: Bun's `fs.watch` reports only
 * one event per inotify burst, so of several files changed together (`sed -i`
 * over a few files, parallel writes) all but one were silently never reloaded.
 *
 * @module
 */

import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

/**
 * Starts watching `dir` (not recursive) and reports every `.json5` file that is
 * added, changed, or removed.
 *
 * @param dir - Absolute path of the workflows directory
 * @param onFile - Called with the file name (relative to `dir`) of each changed workflow file
 * @param onError - Called when the watcher reports an error
 * @returns The watcher, ready once its initial scan has finished; close it with `close()`
 */
export async function watchWorkflowDir(
  dir: string,
  onFile: (filename: string) => void,
  onError: (err: unknown) => void,
): Promise<FSWatcher> {
  const watcher = chokidar.watch(dir, { persistent: true, ignoreInitial: true, depth: 0 });
  const handle = (filePath: string) => {
    const filename = path.basename(filePath);
    if (filename.endsWith(".json5")) onFile(filename);
  };
  watcher.on("add", handle);
  watcher.on("change", handle);
  watcher.on("unlink", handle);
  watcher.on("error", onError);
  await new Promise<void>((resolve) => watcher.once("ready", () => resolve()));
  return watcher;
}
