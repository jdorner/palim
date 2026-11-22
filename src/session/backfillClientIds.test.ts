/**
 * Tests migration 0021, which gives chat user messages stored before client
 * IDs a random one. The migration already ran on the empty test DB, so the
 * test inserts such rows and runs its SQL again.
 */

import { describe, expect, test } from "bun:test";
import { createTestDb } from "@src/test/db";
import { sql } from "drizzle-orm";
import { SessionStore } from "./sessionStore";

const MIGRATION = new URL("../../drizzle/0021_backfill-chat-client-ids.sql", import.meta.url);

describe("migration 0021: backfill chat client IDs", () => {
  test("fills missing client IDs of chat user messages only", async () => {
    const db = createTestDb();
    const store = new SessionStore(db);
    const chat = store.create({ source: "chat", sourceId: "m21-chat" });
    store.append(chat.id, { role: "user", content: "old", timestamp: 1 });
    store.append(chat.id, { role: "assistant", content: [], timestamp: 2 } as never);
    store.append(chat.id, { role: "user", content: "new", timestamp: 3 }, { clientId: "kept" });
    const other = store.create({ source: "telegram", sourceId: "m21-tg" });
    store.append(other.id, { role: "user", content: "tg", timestamp: 1 });

    db.run(sql.raw(await Bun.file(MIGRATION).text()));

    const [filled, kept] = store.getUserMessageMarkers(chat.id).map((m) => m.clientId);
    expect(filled).toMatch(/^[0-9a-f]{32}$/);
    expect(kept).toBe("kept");
    expect(store.getTranscriptRows(chat.id).find((r) => r.role === "assistant")?.clientId).toBeNull();
    expect(store.getUserMessageMarkers(other.id).map((m) => m.clientId)).toEqual([null]);
  });
});
