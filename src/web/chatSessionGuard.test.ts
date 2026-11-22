import { describe, expect, test } from "bun:test";
import type { ChatJob } from "@src/jobs";
import type { ManagedQueuePort } from "@src/queue";
import { createChatSessionGuard } from "./chatSessionGuard";

/** A fake chat queue whose waiting and active jobs are the given ones. */
function fakeQueue(waiting: ChatJob[], active: ChatJob[]): ManagedQueuePort<ChatJob> {
  return {
    getWaiting: async () => waiting.map((data) => ({ data })),
    getActive: async () => active.map((data) => ({ data })),
  } as unknown as ManagedQueuePort<ChatJob>;
}

const job = (sessionId: string): ChatJob => ({ context: { source: "chat", id: "c" }, sessionId });

describe("createChatSessionGuard", () => {
  test("claims a free session once until released", async () => {
    const guard = createChatSessionGuard(fakeQueue([], []));
    const [first, second] = await Promise.all([guard.claim("s1"), guard.claim("s1")]);
    expect([first, second].sort()).toEqual([false, true]);
    expect(await guard.claim("s2")).toBe(true);
    guard.release("s1");
    expect(await guard.claim("s1")).toBe(true);
  });

  test("refuses a session with a waiting or active job, without holding a claim", async () => {
    const guard = createChatSessionGuard(fakeQueue([job("w")], [job("a")]));
    expect(await guard.claim("w")).toBe(false);
    expect(await guard.claim("a")).toBe(false);
    expect(await guard.claim("free")).toBe(true);
  });
});
