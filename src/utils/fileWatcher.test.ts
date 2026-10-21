import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileWatcher } from "./fileWatcher";

/** Short stabilization so events arrive quickly; the timings below are relative to it. */
const STABILITY_THRESHOLD_MS = 300;
const STABILITY_POLL_INTERVAL_MS = 50;
const TEST_TIMEOUT_MS = 10_000;

type EventName = "new" | "change" | "delete";

describe("FileWatcher", () => {
  let dir: string;
  let watcher: FileWatcher | null = null;
  let events: Array<{ event: EventName; file: string; at: number }>;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "file-watcher-"));
    events = [];
  });

  afterEach(async () => {
    await watcher?.close();
    watcher = null;
    await rm(dir, { recursive: true, force: true });
  });

  /** Starts a watcher on `dir` that records every event with its relative path. */
  async function watch(options: ConstructorParameters<typeof FileWatcher>[1] = {}): Promise<void> {
    watcher = new FileWatcher(dir, {
      stabilityThreshold: STABILITY_THRESHOLD_MS,
      stabilityPollInterval: STABILITY_POLL_INTERVAL_MS,
      ...options,
    });
    for (const event of ["new", "change", "delete"] as const) {
      watcher.on(event, (file) => events.push({ event, file: path.relative(dir, file), at: Date.now() }));
    }
    watcher.on("error", () => {});
    await watcher.start();
  }

  /** Recorded events as `"<event> <file>"`, sorted. */
  function seen(): string[] {
    return events.map((e) => `${e.event} ${e.file}`).sort();
  }

  /** Waits until `expected` were all recorded (or the timeout elapses). */
  async function waitFor(expected: string[], timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !expected.every((e) => seen().includes(e))) await Bun.sleep(20);
  }

  test(
    "reports new, changed, and deleted files",
    async () => {
      await watch();

      await Bun.write(path.join(dir, "a.txt"), "1");
      await waitFor(["new a.txt"]);
      await Bun.write(path.join(dir, "a.txt"), "22");
      await waitFor(["new a.txt", "change a.txt"]);
      await unlink(path.join(dir, "a.txt"));
      await waitFor(["new a.txt", "change a.txt", "delete a.txt"]);

      expect(seen()).toEqual(["change a.txt", "delete a.txt", "new a.txt"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reports every file of a burst and of files moved in",
    async () => {
      const outside = await mkdtemp(path.join(tmpdir(), "file-watcher-src-"));
      try {
        await watch();
        await Bun.write(path.join(outside, "moved.txt"), "moved");
        await Promise.all([
          ...["b1", "b2", "b3", "b4"].map((n) => Bun.write(path.join(dir, `${n}.txt`), n)),
          rename(path.join(outside, "moved.txt"), path.join(dir, "moved.txt")),
        ]);
        const expected = ["new b1.txt", "new b2.txt", "new b3.txt", "new b4.txt", "new moved.txt"];
        await waitFor(expected);

        expect(seen()).toEqual(expected);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "waits until a growing file stops changing and reports it once",
    async () => {
      await watch();

      const file = path.join(dir, "upload.bin");
      await Bun.write(file, "chunk");
      for (let i = 0; i < 5; i++) {
        await Bun.sleep(STABILITY_THRESHOLD_MS / 3);
        await appendFile(file, "chunk");
      }
      const lastWrite = Date.now();
      await waitFor(["new upload.bin"]);
      await Bun.sleep(STABILITY_THRESHOLD_MS);

      expect(seen()).toEqual(["new upload.bin"]);
      expect(events[0]!.at - lastWrite).toBeGreaterThanOrEqual(STABILITY_THRESHOLD_MS - STABILITY_POLL_INTERVAL_MS);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reports only the deletion of a file removed while still settling",
    async () => {
      await watch();

      await Bun.write(path.join(dir, "short.txt"), "x");
      await Bun.sleep(STABILITY_THRESHOLD_MS / 3);
      await unlink(path.join(dir, "short.txt"));
      await waitFor(["delete short.txt"]);
      await Bun.sleep(STABILITY_THRESHOLD_MS * 3);

      expect(seen()).toEqual(["delete short.txt"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reports existing files only with processExistingOnStart",
    async () => {
      await Bun.write(path.join(dir, "existing.txt"), "x");

      await watch();
      await Bun.sleep(STABILITY_THRESHOLD_MS * 3);
      expect(seen()).toEqual([]);
      await watcher?.close();

      await watch({ processExistingOnStart: true });
      await waitFor(["new existing.txt"]);
      expect(seen()).toEqual(["new existing.txt"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reports files in subdirectories only when recursive",
    async () => {
      await mkdir(path.join(dir, "sub"));

      await watch();
      await Bun.write(path.join(dir, "sub", "flat.txt"), "x");
      await Bun.write(path.join(dir, "top.txt"), "x");
      await waitFor(["new top.txt"]);
      await Bun.sleep(STABILITY_THRESHOLD_MS);
      expect(seen()).toEqual(["new top.txt"]);
      await watcher?.close();
      events = [];

      await watch({ recursive: true });
      await Bun.write(path.join(dir, "sub", "deep.txt"), "x");
      await waitFor([`new ${path.join("sub", "deep.txt")}`]);
      expect(seen()).toEqual([`new ${path.join("sub", "deep.txt")}`]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reports new and deleted files with polling",
    async () => {
      await watch({ usePolling: true, pollingInterval: 100 });

      await Bun.write(path.join(dir, "polled.txt"), "x");
      await waitFor(["new polled.txt"]);
      await unlink(path.join(dir, "polled.txt"));
      await waitFor(["new polled.txt", "delete polled.txt"]);

      expect(seen()).toEqual(["delete polled.txt", "new polled.txt"]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "emits nothing after close, not even for files still settling",
    async () => {
      await watch();

      await Bun.write(path.join(dir, "pending.txt"), "x");
      await Bun.sleep(STABILITY_THRESHOLD_MS / 3);
      await watcher?.close();
      await Bun.write(path.join(dir, "late.txt"), "x");
      await Bun.sleep(STABILITY_THRESHOLD_MS * 3);

      expect(seen()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
