import { describe, expect, test } from "bun:test";
import { listNeedsRefetch } from "./workflowList";

describe("listNeedsRefetch", () => {
  test("refetches after a workflow file is reloaded or deleted", () => {
    expect(listNeedsRefetch("workflow_reload")).toBe(true);
    expect(listNeedsRefetch("workflow_deleted")).toBe(true);
  });

  test("refetches when a run ends or is removed", () => {
    expect(listNeedsRefetch("workflow_completed")).toBe(true);
    expect(listNeedsRefetch("workflow_failed")).toBe(true);
    expect(listNeedsRefetch("workflow_run_removed")).toBe(true);
  });

  test("ignores step progress and run starts", () => {
    expect(listNeedsRefetch("workflow_started")).toBe(false);
    expect(listNeedsRefetch("workflow_step_started")).toBe(false);
    expect(listNeedsRefetch("workflow_step_completed")).toBe(false);
    expect(listNeedsRefetch("workflow_step_waiting")).toBe(false);
  });
});
