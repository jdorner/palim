import { describe, expect, test } from "bun:test";
import { containerGroup, groupContainer, NEW_GROUP_CONTAINER, normalizeGroupName } from "./workflowGroupDnd";

describe("group drop-zone ids", () => {
  test("round-trip group names, including the ungrouped section", () => {
    for (const group of ["Finance", "ungrouped", "group:x", null]) {
      expect(containerGroup(groupContainer(group))).toBe(group);
    }
  });

  test("ids are never empty and distinct from the new-group zone", () => {
    expect(groupContainer(null)).not.toBe("");
    expect(groupContainer(null)).not.toBe(NEW_GROUP_CONTAINER);
    expect(containerGroup(NEW_GROUP_CONTAINER)).toBeUndefined();
  });
});

describe("normalizeGroupName", () => {
  test("trims and enforces 1-64 characters", () => {
    expect(normalizeGroupName("  Ops  ")).toBe("Ops");
    expect(normalizeGroupName("   ")).toBeNull();
    expect(normalizeGroupName("x".repeat(64))).toBe("x".repeat(64));
    expect(normalizeGroupName("x".repeat(65))).toBeNull();
  });
});
