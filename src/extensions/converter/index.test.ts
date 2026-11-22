/**
 * Tests for the converter extension's wait on its conversion jobs: a cancelled
 * `convert` step, or a timeout, cancels the conversion job instead of leaving
 * it running.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionContext, StepExecutionContext, StepTypeHandler } from "@ext/types";
import { ReadWriteFs } from "just-bash";
import { createExtension } from "./index";

/** Bytes that `file-type` detects as a PNG. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
]);

/** A loaded converter with a fake queue that never runs its jobs. */
async function loadConverter(timeoutMs = 60_000) {
  const cancelled: { jobId: string; reason?: string }[] = [];
  const steps = new Map<string, StepTypeHandler>();
  const queue = {
    add: async () => "job-1",
    cancelJob: async (jobId: string, reason?: string) => {
      cancelled.push({ jobId, reason });
      return "cancelled";
    },
    onEvent: () => {},
    close: async () => {},
  };
  const ctx = {
    log: { info() {}, warn() {}, error() {}, debug() {} },
    config: { get: <T>(key: string, fallback: T) => (key === "CONVERSION_TIMEOUT_MS" ? timeoutMs : fallback) as T },
    queues: { create: () => queue },
    stepTypes: { register: (type: string, handler: StepTypeHandler) => steps.set(type, handler) },
    routes: { register() {} },
  } as unknown as ExtensionContext;
  const extension = createExtension();
  await extension.initialize(ctx);
  return { extension, convert: steps.get("convert")!, cancelled };
}

describe("converter conversion wait", () => {
  let workDir: string | undefined;

  afterEach(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
    workDir = undefined;
  });

  /** A step context over a work dir holding `scan.png`. */
  async function stepCtx(signal?: AbortSignal): Promise<StepExecutionContext> {
    workDir = await mkdtemp(path.join(tmpdir(), "palim-converter-"));
    await Bun.write(path.join(workDir, "scan.png"), PNG_BYTES);
    return {
      resolveTemplate: async (template: string) => ({ resolved: template, warnings: [] }),
      jobLog: async () => {},
      log: console as never,
      workDir,
      fs: new ReadWriteFs({ root: workDir }),
      signal,
    } as unknown as StepExecutionContext;
  }

  test("cancelling the step cancels the conversion job and fails with the cancel reason", async () => {
    const { extension, convert, cancelled } = await loadConverter();
    const controller = new AbortController();
    const running = convert.execute({ file: "scan.png" }, await stepCtx(controller.signal));
    await Bun.sleep(20);

    controller.abort(new Error("Cancelled by alice"));

    await expect(running).rejects.toThrow("Cancelled by alice");
    expect(cancelled).toEqual([{ jobId: "job-1", reason: "Cancelled by alice" }]);
    await extension.shutdown();
  });

  test("a timeout cancels the conversion job", async () => {
    const { extension, convert, cancelled } = await loadConverter(30);

    await expect(convert.execute({ file: "scan.png" }, await stepCtx())).rejects.toThrow("Conversion timed out");
    expect(cancelled).toEqual([{ jobId: "job-1", reason: "Conversion timed out" }]);
    await extension.shutdown();
  });
});
