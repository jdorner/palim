/**
 * IndexedDB persistence layer for chat conversations and messages.
 * Database: "chat-store", version 1.
 * Object stores: "conversations" (idx_updatedAt), "messages" (idx_conversationId).
 */

import { uuid } from "./utils";

/** A chat conversation. */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Whether this conversation was auto-created from a feedback report. */
  feedbackConversation?: boolean;
  /** Server-side session ID, persisted so edits/deletes can sync after reload. */
  sessionId?: string;
}

/** A persisted segment of an assistant response: either text, thinking, or a group of tool calls. */
export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tools"; tools: { name: string; summary: string }[] }
  | {
      type: "actions";
      actions: {
        label: string;
        endpoint: string;
        method: string;
        variant: "default" | "destructive";
        body?: Record<string, unknown>;
      }[];
    }
  | { type: "push"; content: string; contentType: "text/markdown" | "text/plain" };

/** A single message within a conversation. */
export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
  /** Queue job ID that produced this response (assistant messages only). */
  jobId?: string;
  /** Interleaved text/tool segments preserving the order they arrived (assistant messages only). */
  segments?: MessageSegment[];
  /** Token usage data for this response turn (assistant messages only). */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
}

const DB_NAME = "chat-store";
const DB_VERSION = 1;

let dbInstance: IDBDatabase | null = null;

/**
 * Opens or upgrades the IndexedDB database.
 * Creates "conversations" and "messages" object stores on first run.
 * @returns The opened IDBDatabase instance.
 */
function initDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("conversations")) {
        const convStore = db.createObjectStore("conversations", { keyPath: "id" });
        convStore.createIndex("idx_updatedAt", "updatedAt", { unique: false });
      }

      if (!db.objectStoreNames.contains("messages")) {
        const msgStore = db.createObjectStore("messages", { keyPath: "id" });
        msgStore.createIndex("idx_conversationId", "conversationId", { unique: false });
      }
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onerror = () => reject(request.error);
  });
}

/**
 * Generates a conversation title from message content, truncated to 50 characters.
 * @param content - The raw message content to derive a title from.
 * @returns A title string of at most 50 characters.
 */
export function generateTitle(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= 50) return trimmed;
  return `${trimmed.slice(0, 47)}...`;
}

/**
 * Creates a new conversation in the store.
 * @param title - The conversation title.
 * @param opts - Optional properties for the conversation.
 * @returns The newly created Conversation.
 */
export async function createConversation(
  title: string,
  opts?: { feedbackConversation?: boolean },
): Promise<Conversation> {
  const db = await initDB();
  const now = Date.now();
  const conversation: Conversation = {
    id: uuid(),
    title,
    createdAt: now,
    updatedAt: now,
    ...(opts?.feedbackConversation ? { feedbackConversation: true } : {}),
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction("conversations", "readwrite");
    tx.objectStore("conversations").add(conversation);
    tx.oncomplete = () => resolve(conversation);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Retrieves all conversations, sorted by updatedAt descending (most recent first).
 * @returns Array of all stored Conversations.
 */
export async function getConversations(): Promise<Conversation[]> {
  const db = await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("conversations", "readonly");
    const index = tx.objectStore("conversations").index("idx_updatedAt");
    const request = index.getAll();
    request.onsuccess = () => {
      const results = request.result as Conversation[];
      results.reverse();
      resolve(results);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Retrieves a single conversation by ID.
 * @param id - The conversation ID.
 * @returns The Conversation, or undefined if not found.
 */
export async function getConversation(id: string): Promise<Conversation | undefined> {
  const db = await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("conversations", "readonly");
    const request = tx.objectStore("conversations").get(id);
    request.onsuccess = () => resolve(request.result as Conversation | undefined);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Updates the title of an existing conversation.
 * @param id - The conversation ID.
 * @param title - The new title.
 */
export async function updateConversationTitle(id: string, title: string): Promise<void> {
  const db = await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("conversations", "readwrite");
    const store = tx.objectStore("conversations");
    const getReq = store.get(id);

    getReq.onsuccess = () => {
      const conv = getReq.result as Conversation | undefined;
      if (!conv) {
        reject(new Error(`Conversation ${id} not found`));
        return;
      }
      conv.title = title;
      conv.updatedAt = Date.now();
      store.put(conv);
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Deletes a conversation and all its associated messages.
 * @param id - The conversation ID to delete.
 */
export async function deleteConversation(id: string): Promise<void> {
  const db = await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(["conversations", "messages"], "readwrite");

    tx.objectStore("conversations").delete(id);

    const msgIndex = tx.objectStore("messages").index("idx_conversationId");
    const cursorReq = msgIndex.openCursor(IDBKeyRange.only(id));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Adds a message to a conversation. Also updates the conversation's updatedAt timestamp.
 * @param msg - The message data (without id, which is auto-generated).
 * @returns The persisted Message with its generated id.
 */
export async function addMessage(msg: Omit<Message, "id">): Promise<Message> {
  const db = await initDB();
  const message: Message = { ...msg, id: uuid() };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(["messages", "conversations"], "readwrite");

    tx.objectStore("messages").add(message);

    // Update conversation's updatedAt
    const convStore = tx.objectStore("conversations");
    const getReq = convStore.get(msg.conversationId);
    getReq.onsuccess = () => {
      const conv = getReq.result as Conversation | undefined;
      if (conv) {
        conv.updatedAt = Date.now();
        convStore.put(conv);
      }
    };

    tx.oncomplete = () => resolve(message);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Retrieves all messages for a conversation, sorted by createdAt ascending.
 * @param conversationId - The conversation ID to fetch messages for.
 * @returns Array of Messages in chronological order.
 */
export async function getMessages(conversationId: string): Promise<Message[]> {
  const db = await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readonly");
    const index = tx.objectStore("messages").index("idx_conversationId");
    const request = index.getAll(IDBKeyRange.only(conversationId));
    request.onsuccess = () => {
      const results = request.result as Message[];
      results.sort((a, b) => a.createdAt - b.createdAt);
      resolve(results);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Deletes a message and all messages created after it within the same conversation.
 * @param conversationId - The conversation the messages belong to.
 * @param fromCreatedAt - The createdAt timestamp of the message to delete from (inclusive).
 */
export async function deleteMessagesFrom(conversationId: string, fromCreatedAt: number): Promise<void> {
  const db = await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readwrite");
    const index = tx.objectStore("messages").index("idx_conversationId");
    const cursorReq = index.openCursor(IDBKeyRange.only(conversationId));

    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        const msg = cursor.value as Message;
        if (msg.createdAt >= fromCreatedAt) {
          cursor.delete();
        }
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Deletes a single message by ID.
 * @param id - The message ID to delete.
 */
export async function deleteMessage(id: string): Promise<void> {
  const db = await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readwrite");
    tx.objectStore("messages").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Updates the server-side session ID on a conversation.
 * @param conversationId - The conversation ID.
 * @param sessionId - The server session ID to persist.
 */
export async function updateConversationSessionId(conversationId: string, sessionId: string): Promise<void> {
  const db = await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("conversations", "readwrite");
    const store = tx.objectStore("conversations");
    const getReq = store.get(conversationId);

    getReq.onsuccess = () => {
      const conv = getReq.result as Conversation | undefined;
      if (!conv) {
        reject(new Error(`Conversation ${conversationId} not found`));
        return;
      }
      conv.sessionId = sessionId;
      store.put(conv);
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Updates the content (and optionally segments) of an existing message.
 * @param id - The message ID.
 * @param content - The new content.
 * @param segments - Optional updated segments array.
 */
export async function updateMessageContent(id: string, content: string, segments?: MessageSegment[]): Promise<void> {
  const db = await initDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readwrite");
    const store = tx.objectStore("messages");
    const getReq = store.get(id);

    getReq.onsuccess = () => {
      const msg = getReq.result as Message | undefined;
      if (!msg) {
        reject(new Error(`Message ${id} not found`));
        return;
      }
      msg.content = content;
      if (segments !== undefined) {
        // Deep-clone to strip Svelte 5 reactive proxies which are not
        // compatible with IndexedDB's structured clone algorithm.
        msg.segments = JSON.parse(JSON.stringify(segments));
      }
      store.put(msg);
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
