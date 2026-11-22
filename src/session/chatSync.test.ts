import { describe, expect, test } from "bun:test";
import { cutSeqForClientId, planChatSend } from "./chatSync";
import type { UserMessageMarker } from "./types";

/** User messages at seq 1, 5 and 7 with client IDs c1..c3. */
const markers: UserMessageMarker[] = [
  { seq: 1, clientId: "c1" },
  { seq: 5, clientId: "c2" },
  { seq: 7, clientId: "c3" },
];

describe("planChatSend", () => {
  test("appends a new message whose predecessor matches", () => {
    expect(planChatSend(markers, "c4", "c3")).toEqual({ kind: "append" });
  });

  test("appends the first message when the UI expects none", () => {
    expect(planChatSend([], "c1", null)).toEqual({ kind: "append" });
  });

  test("reruns the last user message, cutting everything after it", () => {
    expect(planChatSend(markers, "c3", "c2")).toEqual({ kind: "rerun", cutSeq: 8 });
  });

  test("diverges when an earlier user message is resent", () => {
    expect(planChatSend(markers, "c2", "c1")).toEqual({ kind: "diverged" });
  });

  test("diverges when the predecessor does not match", () => {
    expect(planChatSend(markers, "c4", "c2")).toEqual({ kind: "diverged" });
    expect(planChatSend(markers, "c4", null)).toEqual({ kind: "diverged" });
    expect(planChatSend([], "c1", "c0")).toEqual({ kind: "diverged" });
  });

  test("a message stored without client ID is known by legacy-<seq>", () => {
    const legacy = [
      { seq: 1, clientId: null },
      { seq: 4, clientId: null },
    ];
    expect(planChatSend(legacy, "c5", "legacy-4")).toEqual({ kind: "append" });
    expect(planChatSend(legacy, "c5", "anything")).toEqual({ kind: "diverged" });
    expect(planChatSend(legacy, "legacy-4", "legacy-1")).toEqual({ kind: "rerun", cutSeq: 5 });
  });
});

describe("cutSeqForClientId", () => {
  test("from cuts at the message, after cuts behind it", () => {
    expect(cutSeqForClientId(markers, "c2", "from")).toBe(5);
    expect(cutSeqForClientId(markers, "c2", "after")).toBe(6);
  });

  test("returns undefined for an unknown ID", () => {
    expect(cutSeqForClientId(markers, "nope", "from")).toBeUndefined();
  });

  test("finds a message stored without client ID by legacy-<seq>", () => {
    expect(cutSeqForClientId([{ seq: 3, clientId: null }], "legacy-3", "after")).toBe(4);
  });
});
