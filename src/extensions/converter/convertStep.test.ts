/**
 * Tests for the `convert` workflow step (with a fake conversion backend).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StepExecutionContext } from "@ext/types";
import { ReadWriteFs } from "just-bash";
import { type ConvertBytesFn, createConvertStepHandler } from "./convertStep";

describe("convert step", () => {
  let base: string;
  let workDir: string;

  /** Step context over the work dir, resolving `{{name}}` from a variable map. */
  function makeCtx(vars: Record<string, string> = {}): StepExecutionContext & { logs: string[] } {
    const logs: string[] = [];
    return {
      logs,
      async resolveTemplate(template: string) {
        return {
          resolved: template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => vars[key] ?? ""),
          warnings: [],
        };
      },
      async jobLog(message: string) {
        logs.push(message);
      },
      log: console as never,
      workDir,
      fs: new ReadWriteFs({ root: workDir }),
    } as StepExecutionContext & { logs: string[] };
  }

  /** A fake backend recording its calls. */
  function fakeConvert() {
    const calls: { bytes: string; filename: string; prompt?: string }[] = [];
    const fn: ConvertBytesFn = async (bytes, filename, prompt) => {
      calls.push({ bytes: new TextDecoder().decode(bytes), filename, prompt });
      return `# ${filename}`;
    };
    return { fn, calls };
  }

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), "palim-convert-step-"));
    workDir = path.join(base, "work");
    await Bun.write(path.join(workDir, "uploads/a/scan.png"), "PNGDATA");
    await Bun.write(path.join(base, "secret.png"), "SECRET");
    await symlink(path.join(base, "secret.png"), path.join(workDir, "link.png"));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("converts a work-dir file resolved from a template and passes the prompt", async () => {
    const { fn, calls } = fakeConvert();
    const result = await createConvertStepHandler(fn).execute(
      { type: "convert", file: "{{path}}", prompt: "Extract the total" },
      makeCtx({ path: "uploads/a/scan.png" }),
    );
    expect(result).toEqual({ markdown: "# scan.png", file: "uploads/a/scan.png", output: null });
    expect(calls).toEqual([{ bytes: "PNGDATA", filename: "scan.png", prompt: "Extract the total" }]);
  });

  test("saves the markdown when output is set", async () => {
    const { fn } = fakeConvert();
    await createConvertStepHandler(fn).execute(
      { type: "convert", file: "uploads/a/scan.png", output: "out/{{name}}.md" },
      makeCtx({ name: "scan" }),
    );
    expect(await Bun.file(path.join(workDir, "out/scan.md")).text()).toBe("# scan.png");
  });

  test("cannot read outside the work directory", async () => {
    const { fn, calls } = fakeConvert();
    const handler = createConvertStepHandler(fn);
    await expect(handler.execute({ type: "convert", file: "../secret.png" }, makeCtx())).rejects.toThrow();
    await expect(handler.execute({ type: "convert", file: "link.png" }, makeCtx())).rejects.toThrow();
    expect(calls.some((c) => c.bytes === "SECRET")).toBe(false);
  });

  test("fails on a missing file, an empty path, and invalid config", async () => {
    const handler = createConvertStepHandler(fakeConvert().fn);
    await expect(handler.execute({ type: "convert", file: "nope.png" }, makeCtx())).rejects.toThrow(
      "File not found in the work directory: nope.png",
    );
    await expect(handler.execute({ type: "convert", file: "{{missing}}" }, makeCtx())).rejects.toThrow("empty");
    await expect(handler.execute({ type: "convert" }, makeCtx())).rejects.toThrow("Invalid convert step configuration");
  });

  test("reports why an existing file can't be read instead of 'not found'", async () => {
    const handler = createConvertStepHandler(fakeConvert().fn);
    const ctx = makeCtx();
    // A tiny read limit stands in for a photo above the filesystem's limit.
    Object.assign(ctx, { fs: new ReadWriteFs({ root: workDir, maxFileReadSize: 3 }) });
    await expect(handler.execute({ type: "convert", file: "uploads/a/scan.png" }, ctx)).rejects.toThrow(
      /^Cannot read uploads\/a\/scan\.png: EFBIG/,
    );
  });
});
