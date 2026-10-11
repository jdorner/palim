/**
 * Tests for the debounced workflow reload scheduler.
 */

import { describe, expect, test } from "bun:test";
import { createReloadScheduler } from "./reloadScheduler";

/** Creates a scheduler that records its calls. */
function setup(delayMs = 20) {
  const calls: string[] = [];
  let reloaded = 0;
  const errors: unknown[] = [];
  const scheduler = createReloadScheduler({
    delayMs,
    reloadFile: async (filename) => {
      if (filename === "broken.json5") throw new Error("boom");
      calls.push(filename);
    },
    reloadAll: async () => {
      calls.push("*");
    },
    onReloaded: () => {
      reloaded++;
    },
    onError: (err) => errors.push(err),
  });
  return { scheduler, calls, errors, reloaded: () => reloaded };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createReloadScheduler", () => {
  test("reloads every file changed within one window, each once", async () => {
    const { scheduler, calls, reloaded } = setup();
    scheduler.schedule("a.json5");
    scheduler.schedule("b.json5");
    scheduler.schedule("a.json5");
    await wait(50);
    expect(calls).toEqual(["a.json5", "b.json5"]);
    expect(reloaded()).toBe(1);
  });

  test("a full reload request supersedes single files", async () => {
    const { scheduler, calls } = setup();
    scheduler.schedule("a.json5");
    scheduler.schedule();
    await wait(50);
    expect(calls).toEqual(["*"]);
  });

  test("a failing file does not stop the others", async () => {
    const { scheduler, calls, errors, reloaded } = setup();
    scheduler.schedule("broken.json5");
    scheduler.schedule("ok.json5");
    await wait(50);
    expect(calls).toEqual(["ok.json5"]);
    expect(errors).toHaveLength(1);
    expect(reloaded()).toBe(1);
  });

  test("batches are independent and cancel drops a pending one", async () => {
    const { scheduler, calls } = setup();
    scheduler.schedule("a.json5");
    await wait(50);
    scheduler.schedule("b.json5");
    scheduler.cancel();
    await wait(50);
    scheduler.schedule("c.json5");
    await wait(50);
    expect(calls).toEqual(["a.json5", "c.json5"]);
  });
});
