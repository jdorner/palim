import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FSWatcher } from "chokidar";
import { watchWorkflowDir } from "./workflowDirWatcher";

const NAMES = ["a", "b", "c", "d"];

describe("watchWorkflowDir", () => {
  let dir: string;
  let watcher: FSWatcher | null = null;
  let seen: Set<string>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "wf-watch-"));
    for (const n of NAMES) await Bun.write(path.join(dir, `${n}.json5`), `{ "name": "${n}" }`);
    seen = new Set();
    watcher = await watchWorkflowDir(
      dir,
      (filename) => seen.add(filename),
      () => {},
    );
  });

  afterEach(async () => {
    await watcher?.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** Waits until `expected` were all reported (or the timeout elapses). */
  async function waitFor(expected: string[], timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !expected.every((f) => seen.has(f))) await Bun.sleep(25);
  }

  // Regression: Bun's fs.watch reported only one file of such a burst.
  test("reports every file of a burst of parallel writes", async () => {
    await Promise.all(NAMES.map((n) => Bun.write(path.join(dir, `${n}.json5`), `{ "name": "${n}", "x": 1 }`)));
    const expected = NAMES.map((n) => `${n}.json5`);
    await waitFor(expected);
    expect([...seen].sort()).toEqual(expected);
  });

  test("reports files replaced by rename (sed -i style)", async () => {
    for (const n of NAMES) {
      const tmp = path.join(dir, `.tmp-${n}`);
      await Bun.write(tmp, `{ "name": "${n}", "y": 2 }`);
      Bun.spawnSync(["mv", tmp, path.join(dir, `${n}.json5`)]);
    }
    const expected = NAMES.map((n) => `${n}.json5`);
    await waitFor(expected);
    expect([...seen].sort()).toEqual(expected);
  });

  test("reports added and removed files, ignores non-JSON5 files", async () => {
    await Bun.write(path.join(dir, "e.json5"), "{}");
    await Bun.write(path.join(dir, "notes.txt"), "x");
    await rm(path.join(dir, "b.json5"));
    await waitFor(["b.json5", "e.json5"]);
    await Bun.sleep(100);
    expect([...seen].sort()).toEqual(["b.json5", "e.json5"]);
  });
});
