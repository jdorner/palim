import { describe, expect, test } from "bun:test";
import { cutSeqForClientId, cutSeqForTurns, hasLegacyUserMessages, legacySeqForTurn, planChatSend } from "./chatSync";
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

  test("skips the predecessor check after a legacy message", () => {
    expect(planChatSend([{ seq: 1, clientId: null }], "c2", "anything")).toEqual({ kind: "append" });
    expect(planChatSend([{ seq: 1, clientId: null }], "c2", "anything", 1)).toEqual({ kind: "append" });
  });

  test("reruns and backfills a legacy last message the UI resends", () => {
    const legacy = [
      { seq: 1, clientId: null },
      { seq: 4, clientId: null },
    ];
    expect(planChatSend(legacy, "ui-2", "ui-1", 1)).toEqual({ kind: "rerun", cutSeq: 5, backfillSeq: 4 });
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
});

describe("cutSeqForTurns", () => {
  test("keep=0 without trailing clears everything", () => {
    expect(cutSeqForTurns(markers, 0, false)).toBe(0);
  });

  test("keeps N turns, optionally with the next user message", () => {
    expect(cutSeqForTurns(markers, 1, false)).toBe(5);
    expect(cutSeqForTurns(markers, 1, true)).toBe(6);
    expect(cutSeqForTurns(markers, 0, true)).toBe(2);
  });

  test("keeps everything when there are not more turns", () => {
    expect(cutSeqForTurns(markers, 3, false)).toBeUndefined();
    expect(cutSeqForTurns(markers, 3, true)).toBeUndefined();
  });
});

describe("hasLegacyUserMessages", () => {
  test("detects user messages without a client ID", () => {
    expect(hasLegacyUserMessages(markers)).toBe(false);
    expect(hasLegacyUserMessages([...markers, { seq: 9, clientId: null }])).toBe(true);
  });
});

describe("legacySeqForTurn", () => {
  test("returns the seq of a legacy user message at the turn, else undefined", () => {
    const mixed = [
      { seq: 1, clientId: null },
      { seq: 3, clientId: "c2" },
    ];
    expect(legacySeqForTurn(mixed, 0)).toBe(1);
    expect(legacySeqForTurn(mixed, 1)).toBeUndefined();
    expect(legacySeqForTurn(mixed, 2)).toBeUndefined();
  });
});
