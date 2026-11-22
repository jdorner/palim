import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SessionChangedEvent } from "@shared/websocket";
import { createTestDb } from "@src/test/db";
import { SessionStore, setSessionStoreForTests } from "./index";
import { createSessionChangeNotifier } from "./sessionEvents";

describe("createSessionChangeNotifier", () => {
  let store: SessionStore;
  const sent: SessionChangedEvent[] = [];
  const notify = createSessionChangeNotifier((e) => sent.push(e));

  beforeAll(() => {
    store = new SessionStore(createTestDb());
    setSessionStoreForTests(store);
  });

  afterAll(() => setSessionStoreForTests(null));

  test("announces a chat session's change to its owner with the last user message ID", () => {
    sent.length = 0;
    const session = store.create({ source: "chat", sourceId: "ev-1", userId: "alice" });
    store.append(session.id, { role: "user", content: "hi", timestamp: 1 }, { clientId: "u1" });
    notify(session.id, "message", "chat-1");
    expect(sent).toEqual([
      {
        type: "session_changed",
        userId: "alice",
        sessionId: session.id,
        lastUserClientId: "u1",
        title: "hi",
        reason: "message",
        origin: "chat-1",
      },
    ]);
  });

  test("reports null for a session without user messages and leaves out a missing origin", () => {
    sent.length = 0;
    const session = store.create({ source: "chat", sourceId: "ev-2", userId: "alice" });
    notify(session.id, "push");
    expect(sent).toEqual([
      {
        type: "session_changed",
        userId: "alice",
        sessionId: session.id,
        lastUserClientId: null,
        title: "",
        reason: "push",
      },
    ]);
  });

  test("stays silent for other sources, ownerless and unknown sessions", () => {
    sent.length = 0;
    notify(store.create({ source: "telegram", sourceId: "ev-3", userId: "alice" }).id, "response");
    notify(store.create({ source: "chat", sourceId: "ev-4" }).id, "response");
    notify("missing", "response");
    expect(sent).toEqual([]);
  });

  test("carries the stored title once the session is renamed", () => {
    sent.length = 0;
    const session = store.create({ source: "chat", sourceId: "ev-5", userId: "alice" });
    store.append(session.id, { role: "user", content: "derived", timestamp: 1 }, { clientId: "u1" });
    store.setTitle(session.id, "Mine");
    notify(session.id, "rename");
    expect(sent[0]?.title).toBe("Mine");
  });
});
