/**
 * Central chat streaming store. Processes chat WebSocket events globally
 * so in-flight responses survive page navigation.
 *
 * ChatView reads reactive state from the singleton `chatStream` instance
 * and delegates send/cancel/edit actions through its methods.
 */

import type { ChatWebSocketEvent } from "../../../shared/chat";
import { summarizeToolCall, type TranscriptMessage } from "../../../shared/chatTranscript";
import type { ApprovalRequestEvent, PushMessageEvent, SessionChangedEvent } from "../../../shared/websocket";
import { authFetch } from "./auth";
import { chatSendSync, conflictCode, truncateQuery } from "./chatSessionSync";
import {
  addMessage,
  type Conversation,
  createConversation,
  deleteConversation,
  deleteMessage,
  deleteMessagesFrom,
  generateTitle,
  getConversations,
  getMessages,
  type Message,
  type MessageSegment,
  replaceMessages,
  setChatStoreUser,
  updateConversationSessionId,
  updateConversationTitle,
  updateMessageContent,
} from "./chatStore";
import { translateCore as t } from "./i18nCore";
import { readState } from "./readState.svelte";
import { uuid } from "./utils";

/** A segment of streaming content: either a block of text, a thinking block, or a group of tool calls. */
export type StreamSegment =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tools"; tools: { name: string; summary: string; running: boolean }[] }
  | { type: "push"; content: string; contentType: "text/markdown" | "text/plain" };

/** State for a single in-flight stream, keyed by chatId. */
interface InFlightStream {
  /** The conversation this stream belongs to. */
  conversationId: string;
  /** The server-side job ID. */
  jobId: string | null;
  /** Accumulated text from text_delta events. */
  content: string;
  /** Currently active tool name. */
  activeTool: string | null;
  /** Interleaved segments built during streaming. */
  segments: StreamSegment[];
  /** The jobId from the done event, used to tag the persisted message. */
  doneJobId: string | null;
  /** Usage data from the done event. */
  doneUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  } | null;
  /** The server-side session ID used for this stream. */
  sessionId: string | null;
}

/** A server chat session as `GET /api/sessions?source=chat` lists it. */
export interface ServerChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastUserClientId: string | null;
}

/** Body of `GET /api/sessions/:id/chat`. */
interface ServerChatTranscript extends ServerChatSession {
  messages: TranscriptMessage[];
}

/**
 * Reactive chat stream state exposed as a Svelte 5 class with `$state` fields.
 * A single module-level instance (`chatStream`) is exported for global use.
 *
 * Supports multiple concurrent in-flight streams (one per conversation).
 */
class ChatStreamStore {
  /** All conversations, kept in sync after mutations. */
  conversations = $state<Conversation[]>([]);
  /** Currently selected conversation ID. */
  activeConversationId = $state<string | null>(null);

  /** Conversation whose messages are currently being loaded (dedupes redundant selects). */
  private loadingConversationId: string | null = null;
  /** Messages for the active conversation. */
  messages = $state<Message[]>([]);
  /** Last error message, if any. */
  error = $state<string | null>(null);

  /** Whether the chat page is currently visible to the user. */
  chatVisible = $state(false);

  /**
   * Map of chatId to in-flight stream state. Multiple streams can be active
   * simultaneously (one per conversation).
   */
  private streams = $state<Map<string, InFlightStream>>(new Map());

  /** Reverse lookup: conversationId -> chatId for the active stream. */
  private convToChatId = $state<Map<string, string>>(new Map());

  /** The server-side session ID for the active conversation. */
  private currentSessionId: string | null = null;

  /** The user whose conversations are loaded (null when logged out or unknown). */
  private userId: string | null = null;

  /**
   * IDs this tab sent with its own session changes (chat IDs, truncation request
   * IDs). `session_changed` events carrying one of them are this tab's own.
   */
  private ownOrigins = new Set<string>();

  /** The resync running for each conversation, so resyncs of one conversation run in order. */
  private resyncs = new Map<string, Promise<boolean>>();

  // -------------------------------------------------------------------------
  // Derived state for the active conversation's stream
  // -------------------------------------------------------------------------

  /** Whether any stream is currently in-flight. */
  get streaming(): boolean {
    return this.streams.size > 0;
  }

  /** Whether the active conversation has an in-flight stream. */
  get activeStreaming(): boolean {
    if (!this.activeConversationId) return false;
    return this.convToChatId.has(this.activeConversationId);
  }

  /** The conversation ID of the stream targeting the active conversation (for backward compat). */
  get streamingConversationId(): string | null {
    if (!this.activeConversationId) return null;
    if (this.convToChatId.has(this.activeConversationId)) return this.activeConversationId;
    return null;
  }

  /** Accumulated streaming content for the active conversation (direct $state for reactivity). */
  activeStreamContent = $state("");
  /** Active tool for the active conversation's stream (direct $state for reactivity). */
  activeStreamTool = $state<string | null>(null);
  /** Stream segments for the active conversation's stream (direct $state for reactivity). */
  activeStreamSegments = $state<StreamSegment[]>([]);

  /** Accumulated streaming content for the active conversation. */
  get streamingContent(): string {
    return this.activeStreamContent;
  }

  /** Active tool for the active conversation's stream. */
  get activeTool(): string | null {
    return this.activeStreamTool;
  }

  /** Stream segments for the active conversation's stream. */
  get streamSegments(): StreamSegment[] {
    return this.activeStreamSegments;
  }

  // -------------------------------------------------------------------------
  // Conversation management
  // -------------------------------------------------------------------------

  /**
   * Switches the store to a different user (or none, on logout). Clears all
   * in-memory conversation/stream state and re-scopes persistence so one
   * user's conversations never appear for another user in the same browser.
   * @param userId - The authenticated user's id, or null when logged out.
   */
  async setUser(userId: string | null): Promise<void> {
    if (userId === this.userId) return;
    this.userId = userId;
    setChatStoreUser(userId);
    readState.setUser(userId);
    this.conversations = [];
    this.activeConversationId = null;
    this.loadingConversationId = null;
    this.messages = [];
    this.error = null;
    this.streams = new Map();
    this.convToChatId = new Map();
    this.currentSessionId = null;
    this.activeStreamContent = "";
    this.activeStreamTool = null;
    this.activeStreamSegments = [];
    if (userId) await this.loadConversations();
  }

  /** Loads all conversations from IndexedDB. */
  async loadConversations(): Promise<void> {
    try {
      this.conversations = await getConversations();
      readState.prune(new Set(this.conversations.map((c) => c.id)));
    } catch (err) {
      console.error("Failed to load conversations:", err);
    }
  }

  /**
   * Selects a conversation and loads its messages.
   * @param id - Conversation ID to select.
   */
  async selectConversation(id: string): Promise<void> {
    // Guard against redundant selects for the same conversation. The UI can
    // trigger this twice for one switch: `onSelect` calls it directly AND then
    // navigates, and the route `$effect` reacts to the param change. Without
    // this guard the second call clears + reloads `messages`, tearing down and
    // remounting every message (a fresh comark/rangi parse of each code block)
    // — the visible multi-flicker.
    if (id === this.loadingConversationId) return;
    if (id === this.activeConversationId && this.messages.length > 0) return;

    this.loadingConversationId = id;
    this.activeConversationId = id;
    this.error = null;
    readState.markRead(id);

    // Sync active stream fields: if this conversation has an in-flight stream, restore its state
    const chatId = this.convToChatId.get(id);
    if (chatId) {
      const stream = this.streams.get(chatId);
      if (stream) {
        this.activeStreamContent = stream.content;
        this.activeStreamTool = stream.activeTool;
        this.activeStreamSegments = stream.segments;
      } else {
        this.activeStreamContent = "";
        this.activeStreamTool = null;
        this.activeStreamSegments = [];
      }
    } else {
      this.activeStreamContent = "";
      this.activeStreamTool = null;
      this.activeStreamSegments = [];
    }

    try {
      const loaded = await getMessages(id);
      // A newer switch may have started while this load was in flight; only
      // apply if we are still loading this conversation.
      if (this.loadingConversationId !== id) return;
      this.messages = loaded;
      // Restore persisted server-side session ID
      const conv = this.conversations.find((c) => c.id === id);
      this.currentSessionId = conv?.sessionId ?? null;
      if (conv?.sessionId) void this.resyncIfStale(id, conv.sessionId, loaded);
    } catch (err) {
      console.error("Failed to load messages:", err);
      if (this.loadingConversationId === id) {
        this.messages = [];
        this.currentSessionId = null;
      }
    } finally {
      if (this.loadingConversationId === id) {
        this.loadingConversationId = null;
      }
    }
  }

  /**
   * Creates a new conversation and selects it.
   * @returns The new conversation's ID.
   */
  async handleCreate(): Promise<string> {
    const conv = await createConversation(t("chat.newChat"));
    await this.loadConversations();
    await this.selectConversation(conv.id);
    return conv.id;
  }

  /**
   * Renames a conversation.
   * @param id - Conversation ID.
   * @param title - New title.
   */
  async handleRename(id: string, title: string): Promise<void> {
    await updateConversationTitle(id, title);
    await this.loadConversations();
  }

  /**
   * Deletes a conversation and adjusts selection.
   * @param id - Conversation ID to delete.
   * @returns The new active conversation ID (or null).
   */
  async handleDelete(id: string): Promise<string | null> {
    // Resolve the server-side session id before the local record is removed,
    // so the backend session (and its messages) can be deleted too.
    const sessionId = this.conversations.find((c) => c.id === id)?.sessionId;

    await deleteConversation(id);
    if (sessionId) await this.deleteServerSession(sessionId);
    await this.loadConversations();

    if (this.activeConversationId === id) {
      if (this.conversations.length > 0 && this.conversations[0]) {
        await this.selectConversation(this.conversations[0].id);
        return this.conversations[0].id;
      }
      this.activeConversationId = null;
      this.messages = [];
      return null;
    }
    return this.activeConversationId;
  }

  // -------------------------------------------------------------------------
  // Server sessions: import and resync
  // -------------------------------------------------------------------------

  /**
   * Lists the user's chat sessions on the server that no local conversation mirrors.
   * @returns The sessions, most recently updated first.
   * @throws Error when the request fails.
   */
  async listImportableSessions(): Promise<ServerChatSession[]> {
    const res = await authFetch("/api/sessions?source=chat");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { sessions: ServerChatSession[] };
    const local = new Set(this.conversations.map((c) => c.sessionId).filter(Boolean));
    return body.sessions.filter((s) => !local.has(s.id));
  }

  /**
   * Imports a server chat session as a conversation. When a conversation
   * already mirrors the session, resyncs that one instead.
   * @param sessionId - The server session to import.
   * @returns The conversation's ID, or `null` when the import failed (sets `error`).
   */
  async importSession(sessionId: string): Promise<string | null> {
    this.error = null;
    const existing = this.conversations.find((c) => c.sessionId === sessionId);
    if (existing) {
      await this.resyncConversation(existing.id);
      return existing.id;
    }
    const transcript = await this.fetchTranscript(sessionId);
    if (!transcript) {
      this.error = t("chat.importFailed");
      return null;
    }
    try {
      const conv = await createConversation(transcript.title || t("chat.newChat"), sessionId);
      await replaceMessages(conv.id, transcript.messages);
      // The user asked for this conversation: it holds nothing new to them.
      readState.markRead(conv.id);
      await this.loadConversations();
      return conv.id;
    } catch (err) {
      console.error("Failed to import session:", err);
      this.error = t("chat.importFailed");
      return null;
    }
  }

  /**
   * Replaces a conversation's messages with its server session's.
   *
   * Does nothing while the conversation has a response in flight; its end
   * brings the conversation up to date on its own.
   * @param conversationId - The conversation to resync.
   * @returns Whether the conversation now matches the session.
   */
  resyncConversation(conversationId: string): Promise<boolean> {
    const previous = this.resyncs.get(conversationId) ?? Promise.resolve(true);
    const next = previous.then(() => this.runResync(conversationId));
    this.resyncs.set(conversationId, next);
    next.finally(() => {
      if (this.resyncs.get(conversationId) === next) this.resyncs.delete(conversationId);
    });
    return next;
  }

  /**
   * Performs one resync (see {@link resyncConversation}).
   * @param conversationId - The conversation to resync.
   * @returns Whether the conversation now matches the session.
   */
  private async runResync(conversationId: string): Promise<boolean> {
    const conv = this.conversations.find((c) => c.id === conversationId);
    if (!conv?.sessionId || this.convToChatId.has(conversationId)) return false;
    const transcript = await this.fetchTranscript(conv.sessionId);
    if (!transcript || this.convToChatId.has(conversationId)) return false;
    try {
      const stored = await replaceMessages(conversationId, transcript.messages);
      if (this.activeConversationId === conversationId) {
        this.messages = stored;
        // The user sees the new state, so the bumped updatedAt is not unread.
        if (this.chatVisible) readState.markRead(conversationId);
      }
      await this.loadConversations();
      return true;
    } catch (err) {
      console.error("Failed to resync conversation:", err);
      return false;
    }
  }

  /**
   * Handles a `session_changed` event: another tab or device (or a push)
   * changed a session this browser shows, so resync its conversation.
   *
   * Skips the tab's own changes, sessions no conversation mirrors, and new
   * messages the conversation already holds.
   * @param event - The event from the server.
   */
  async handleSessionChanged(event: SessionChangedEvent): Promise<void> {
    if (event.origin && this.ownOrigins.has(event.origin)) return;
    const conv = this.conversations.find((c) => c.sessionId === event.sessionId);
    if (!conv) return;
    if (event.reason === "message") {
      try {
        const local = conv.id === this.activeConversationId ? this.messages : await getMessages(conv.id);
        if ((local.findLast((m) => m.role === "user")?.id ?? null) === event.lastUserClientId) return;
      } catch (err) {
        console.error("Failed to read conversation:", err);
      }
    }
    await this.resyncConversation(conv.id);
  }

  /**
   * Resyncs a conversation when its last user message differs from the server session's.
   * @param conversationId - The conversation just opened.
   * @param sessionId - Its server session.
   * @param messages - Its messages as loaded from IndexedDB.
   */
  private async resyncIfStale(conversationId: string, sessionId: string, messages: Message[]): Promise<void> {
    try {
      const res = await authFetch(`/api/sessions/${sessionId}`);
      if (!res.ok) return;
      const session = (await res.json()) as ServerChatSession;
      const localLast = messages.findLast((m) => m.role === "user")?.id ?? null;
      if (session.lastUserClientId !== localLast) await this.resyncConversation(conversationId);
    } catch (err) {
      console.error("Failed to check conversation sync:", err);
    }
  }

  /**
   * Fetches a server session converted into chat messages.
   * @param sessionId - The server session.
   * @returns The transcript, or `null` when the request failed.
   */
  private async fetchTranscript(sessionId: string): Promise<ServerChatTranscript | null> {
    try {
      const res = await authFetch(`/api/sessions/${sessionId}/chat`);
      if (!res.ok) return null;
      return (await res.json()) as ServerChatTranscript;
    } catch (err) {
      console.error("Failed to fetch session:", err);
      return null;
    }
  }

  /**
   * Shows the message for a failed chat or session request; on a divergence,
   * replaces the active conversation with the server's version.
   * @param body - The parsed error response body.
   * @param fallback - The message for errors that are no known conflict.
   */
  private async handleRequestError(body: unknown, fallback: string): Promise<void> {
    const code = conflictCode(body);
    if (code === "session_busy") {
      this.error = t("chat.sessionBusy");
      return;
    }
    if (code !== "session_diverged") {
      this.error = fallback;
      return;
    }
    const convId = this.activeConversationId;
    this.error =
      convId && (await this.resyncConversation(convId)) ? t("chat.sessionResynced") : t("chat.sessionDiverged");
  }

  // -------------------------------------------------------------------------
  // WebSocket event handling (called from App.svelte's global handler)
  // -------------------------------------------------------------------------

  /**
   * Processes an incoming chat WebSocket event. Called by the global WS
   * handler in App.svelte so events are processed regardless of which
   * page is mounted.
   * @param event - The chat WebSocket event.
   */
  handleChatEvent(event: ChatWebSocketEvent): void {
    const stream = this.streams.get(event.chatId);
    if (!stream) {
      // Even without an active stream, error events must be surfaced to the user.
      // This handles cases where the job fails before the stream is registered or
      // after the stream was already cleaned up (e.g. race with HTTP response).
      if (event.event === "error") {
        this.error = event.error ?? t("chat.unknownError");
      }
      return;
    }

    const isActive = stream.conversationId === this.activeConversationId;

    switch (event.event) {
      case "thinking_delta": {
        const delta = event.content ?? "";
        const lastThinkSeg = stream.segments[stream.segments.length - 1];
        if (lastThinkSeg && lastThinkSeg.type === "thinking") {
          lastThinkSeg.content += delta;
          stream.segments = [...stream.segments.slice(0, -1), lastThinkSeg];
        } else {
          stream.segments = [...stream.segments, { type: "thinking", content: delta }];
        }
        if (isActive) this.activeStreamSegments = stream.segments;
        break;
      }
      case "text_delta": {
        const delta = event.content ?? "";
        stream.content += delta;
        const lastSeg = stream.segments[stream.segments.length - 1];
        if (lastSeg && lastSeg.type === "text") {
          lastSeg.content += delta;
          stream.segments = [...stream.segments.slice(0, -1), lastSeg];
        } else {
          stream.segments = [...stream.segments, { type: "text", content: delta }];
        }
        if (isActive) {
          this.activeStreamContent = stream.content;
          this.activeStreamSegments = stream.segments;
        }
        break;
      }
      case "tool_start": {
        stream.activeTool = event.toolName ?? null;
        const name = event.toolName ?? "unknown";
        const summary = summarizeToolCall(name, event.toolArgs);
        const toolEntry = { name, summary, running: true };
        const lastToolSeg = stream.segments[stream.segments.length - 1];
        if (lastToolSeg && lastToolSeg.type === "tools") {
          lastToolSeg.tools = [...lastToolSeg.tools, toolEntry];
          stream.segments = [...stream.segments.slice(0, -1), lastToolSeg];
        } else {
          stream.segments = [...stream.segments, { type: "tools", tools: [toolEntry] }];
        }
        if (isActive) {
          this.activeStreamTool = stream.activeTool;
          this.activeStreamSegments = stream.segments;
        }
        break;
      }
      case "tool_end": {
        stream.activeTool = null;
        const endName = event.toolName ?? "unknown";
        stream.segments = stream.segments.map((seg) => {
          if (seg.type !== "tools") return seg;
          const updated = seg.tools.map((tc) => (tc.name === endName && tc.running ? { ...tc, running: false } : tc));
          return { ...seg, tools: updated };
        });
        if (isActive) {
          this.activeStreamTool = null;
          this.activeStreamSegments = stream.segments;
        }
        break;
      }
      case "done":
        stream.doneJobId = event.jobId ?? null;
        stream.doneUsage = event.usage ?? null;
        this.persistAssistantMessage(event.chatId, event.content ?? stream.content);
        break;
      case "error":
        this.error = event.error ?? t("chat.unknownError");
        this.preservePartialAndFinalize(event.chatId);
        break;
    }
  }

  /** Handles WebSocket close while streaming. Preserves partial content for all active streams. */
  handleWsClose(): void {
    if (this.streams.size > 0) {
      this.error = t("chat.connectionLostPartial");
      // Preserve all active streams
      for (const chatId of [...this.streams.keys()]) {
        this.preservePartialAndFinalize(chatId);
      }
    }
  }

  /**
   * Handles an approval_request WebSocket event by auto-creating a new
   * conversation with the extension details and approve/reject action buttons.
   * @param event - The approval request event from the backend.
   */
  async handleApprovalRequest(event: ApprovalRequestEvent): Promise<void> {
    try {
      const title = t("chat.installTitle", { name: event.name, version: event.version });
      const conv = await createConversation(title);

      const packageList = event.packages.map((p) => `- \`${p}\``).join("\n");
      let content = `${t("chat.installRequest", { name: event.name, version: event.version })}\n\n${packageList}`;

      if (event.description) {
        content = `${event.description}\n\n${content}`;
      }

      if (event.binRequirements.length > 0) {
        content += `\n\n${t("chat.installBinaries", { binaries: event.binRequirements.join(", ") })}`;
      }

      const contentSegments: MessageSegment[] = [
        { type: "text", content },
        {
          type: "actions",
          actions: [
            {
              label: t("chat.approve"),
              endpoint: `/ext/ext-installer/approve/${event.name}`,
              method: "POST",
              variant: "default",
              body: { token: event.approvalToken },
            },
            {
              label: t("chat.reject"),
              endpoint: `/ext/ext-installer/reject/${event.name}`,
              method: "POST",
              variant: "destructive",
              body: { token: event.approvalToken },
            },
          ],
        },
      ];

      await addMessage({
        conversationId: conv.id,
        role: "system",
        content,
        createdAt: Date.now(),
        segments: contentSegments,
      });
      await this.loadConversations();
    } catch (err) {
      console.error("Failed to create approval conversation:", err);
    }
  }

  /**
   * Handles a push_message WebSocket event by appending a push segment to the
   * active stream, or logging a warning if no stream is active (the message is
   * already persisted server-side).
   * @param event - The push message event from the backend.
   */
  handlePushMessage(event: PushMessageEvent): void {
    const stream = this.streams.get(event.chatId);

    if (stream) {
      // Append push segment to the active stream
      const pushSeg: StreamSegment = { type: "push", content: event.content, contentType: event.contentType };
      stream.segments = [...stream.segments, pushSeg];

      // Update active stream fields if this is the active conversation
      if (stream.conversationId === this.activeConversationId) {
        this.activeStreamSegments = stream.segments;
      }
    } else {
      // No active stream - the message was already persisted server-side in the
      // session store and will appear when the user reloads messages. Log a
      // warning for observability but don't lose the event silently.
      console.warn("push_message received for chatId with no active stream:", event.chatId);
    }
  }

  // -------------------------------------------------------------------------
  // Sending messages
  // -------------------------------------------------------------------------

  /**
   * Sends a new user message (or creates a conversation first if needed).
   * @param content - The user's message text.
   * @returns The active conversation ID after sending.
   */
  async handleSubmit(content: string): Promise<string | null> {
    this.error = null;

    if (!this.activeConversationId) {
      try {
        const title = generateTitle(content);
        const conv = await createConversation(title);
        await this.loadConversations();
        this.activeConversationId = conv.id;
      } catch (err) {
        console.error("Failed to create conversation:", err);
        return null;
      }
    }

    if (this.messages.length === 0) {
      const title = generateTitle(content);
      try {
        await updateConversationTitle(this.activeConversationId, title);
        await this.loadConversations();
      } catch (err) {
        console.error("Failed to update title:", err);
      }
    }

    const userMsg = await addMessage({
      conversationId: this.activeConversationId,
      role: "user",
      content,
      createdAt: Date.now(),
    });
    this.messages = [...this.messages, userMsg];

    await this.startStream(userMsg);
    return this.activeConversationId;
  }

  /** Cancels the in-flight request for the active conversation. */
  async handleCancel(): Promise<void> {
    if (!this.activeConversationId) return;
    const chatId = this.convToChatId.get(this.activeConversationId);
    if (!chatId) return;

    const stream = this.streams.get(chatId);
    const jobId = stream?.jobId ?? null;

    // Finalize first; this removes the stream synchronously so events arriving
    // after the backend stops the job are ignored, not rendered as a second copy.
    await this.preservePartialAndFinalize(chatId);

    if (jobId) {
      try {
        await authFetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
      } catch (err) {
        console.error("Failed to cancel job:", err);
      }
    }
  }

  /**
   * Deletes a single message and all subsequent messages.
   *
   * The server session is truncated first; when that fails the conversation
   * stays as it is, so it never holds less than the session.
   * @param msg - The message to delete.
   */
  async handleDeleteMessage(msg: Message): Promise<void> {
    if (!this.activeConversationId) return;
    if (this.activeStreaming) return;
    this.error = null;
    if (this.currentSessionId && !(await this.truncateServerSession(truncateQuery(this.messages, msg)))) return;

    await deleteMessagesFrom(this.activeConversationId, msg.createdAt);
    this.messages = this.messages.filter((m) => m.createdAt < msg.createdAt);
  }

  /**
   * Edits a message, removes all subsequent messages, and re-sends.
   * @param msg - The message to edit.
   * @param newContent - The replacement content.
   */
  async handleEditMessage(msg: Message, newContent: string): Promise<void> {
    if (!this.activeConversationId) return;
    if (this.activeStreaming) return;

    const msgIndex = this.messages.findIndex((m) => m.id === msg.id);
    if (msgIndex < 0) return;
    this.error = null;

    // The edited message is sent again as a new message under the same ID.
    if (this.currentSessionId && !(await this.truncateServerSession(truncateQuery(this.messages, msg)))) return;

    await updateMessageContent(msg.id, newContent);
    for (const m of this.messages.slice(msgIndex + 1)) {
      await deleteMessage(m.id);
    }

    const edited = { ...msg, content: newContent };
    this.messages = [...this.messages.slice(0, msgIndex), edited];

    await this.startStream(edited);
  }

  /**
   * Regenerates the response for a given assistant message.
   *
   * Resending the user message under its ID makes the server drop the old
   * response and run it again.
   * @param msg - The assistant message to regenerate from.
   */
  async handleRegenerate(msg: Message): Promise<void> {
    if (!this.activeConversationId) return;
    if (this.activeStreaming) return;

    // Clear any prior error so a stale error box is dismissed on regenerate
    // (mirrors handleRetry and handleSubmit).
    this.error = null;

    await deleteMessagesFrom(this.activeConversationId, msg.createdAt);
    this.messages = this.messages.filter((m) => m.createdAt < msg.createdAt);

    const lastUserMsg = [...this.messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return;

    await this.startStream(lastUserMsg);
  }

  /**
   * Retries the last request.
   *
   * The user message is resent under its ID: the server appends it if the
   * failed request never arrived, and otherwise runs it again.
   */
  async handleRetry(): Promise<void> {
    const lastUserMsg = [...this.messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg || !this.activeConversationId) return;

    this.error = null;

    // Remove any partial assistant message that was persisted after the failure.
    // This prevents duplicate consecutive assistant messages on retry.
    const lastMsg = this.messages[this.messages.length - 1];
    if (lastMsg && lastMsg.role === "assistant") {
      await deleteMessagesFrom(this.activeConversationId, lastMsg.createdAt);
      this.messages = this.messages.filter((m) => m.createdAt < lastMsg.createdAt);
    }

    await this.startStream(lastUserMsg);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Starts a streaming request to the chat API.
   * @param userMsg - The user message to send; must be in `this.messages`.
   */
  private async startStream(userMsg: Message): Promise<void> {
    const chatId = uuid();
    const convId = this.activeConversationId!;
    // The server announces this message and its response with the chat ID.
    this.ownOrigins.add(chatId);

    // Register the stream in the map
    const stream: InFlightStream = {
      conversationId: convId,
      jobId: null,
      content: "",
      activeTool: null,
      segments: [],
      doneJobId: null,
      doneUsage: null,
      sessionId: this.currentSessionId,
    };
    this.streams.set(chatId, stream);
    this.convToChatId = new Map(this.convToChatId).set(convId, chatId);
    this.streams = new Map(this.streams);

    // Reset active stream fields since this is the currently viewed conversation
    this.activeStreamContent = "";
    this.activeStreamTool = null;
    this.activeStreamSegments = [];

    try {
      const payload: Record<string, string | number | null> = {
        message: userMsg.content,
        chatId,
        ...chatSendSync(this.messages, userMsg),
      };
      if (this.currentSessionId) {
        payload.sessionId = this.currentSessionId;
      }

      const res = await authFetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        stream.jobId = body.jobId ?? null;
        // Store the session ID returned by the server
        if (body.sessionId) {
          this.currentSessionId = body.sessionId;
          stream.sessionId = body.sessionId;
          // Persist to IndexedDB so it survives page reloads
          if (convId) {
            updateConversationSessionId(convId, body.sessionId).catch((err) =>
              console.error("Failed to persist sessionId:", err),
            );
          }
        }
      } else {
        const body = await res.json().catch(() => ({ error: t("chat.requestFailed") }));
        this.removeStream(chatId);
        await this.handleRequestError(body, body.error || `HTTP ${res.status}`);
      }
    } catch {
      this.error = t("chat.sendFailed");
      this.removeStream(chatId);
    }
  }

  /**
   * Persists the final assistant message and removes the stream from the map.
   * @param chatId - The chatId identifying the stream.
   * @param content - The complete assistant response.
   */
  private async persistAssistantMessage(chatId: string, content: string): Promise<void> {
    const stream = this.streams.get(chatId);
    if (!stream) return;

    // Remove synchronously before the async persist so a concurrent finalize
    // (e.g. a cancel racing this `done`) can't pass the guard and duplicate.
    const targetConvId = stream.conversationId;
    const segments = this.buildPersistedSegments(stream.segments);
    const doneJobId = stream.doneJobId;
    const doneUsage = stream.doneUsage;
    this.removeStream(chatId);

    try {
      const assistantMsg = await addMessage({
        conversationId: targetConvId,
        role: "assistant",
        content,
        createdAt: Date.now(),
        ...(doneJobId ? { jobId: doneJobId } : {}),
        ...(segments ? { segments } : {}),
        ...(doneUsage ? { usage: doneUsage } : {}),
      });
      if (this.activeConversationId === targetConvId) {
        this.messages = [...this.messages, assistantMsg];
        // Keep the active conversation marked as read only if the user is viewing chat
        if (this.chatVisible) {
          readState.markRead(targetConvId);
        }
      }
    } catch (err) {
      console.error("Failed to persist assistant message:", err);
    }

    // Refresh conversation list so updatedAt changes are reflected (triggers unread styling)
    await this.loadConversations();
  }

  /**
   * Preserves any partial streaming content as an assistant message, then removes the stream.
   * @param chatId - The chatId identifying the stream.
   */
  private async preservePartialAndFinalize(chatId: string): Promise<void> {
    const stream = this.streams.get(chatId);
    if (!stream) return;

    // Snapshot, then remove the stream SYNCHRONOUSLY before the async persist:
    // otherwise a late `done`/`text_delta` arriving during `await addMessage`
    // would find the stream still present and persist a duplicate.
    const targetConvId = stream.conversationId;
    const content = stream.content;
    const segments = this.buildPersistedSegments(stream.segments);
    this.removeStream(chatId);

    if (content && targetConvId) {
      try {
        const partialMsg = await addMessage({
          conversationId: targetConvId,
          role: "assistant",
          content,
          createdAt: Date.now(),
          ...(segments ? { segments } : {}),
        });
        if (this.activeConversationId === targetConvId) {
          this.messages = [...this.messages, partialMsg];
        }
      } catch (err) {
        console.error("Failed to persist partial assistant message:", err);
      }
    }
  }

  /**
   * Converts stream segments into a persistence-friendly format
   * (strips the `running` flag from tool entries).
   * @param segments - The stream segments to convert.
   * @returns The segments array, or undefined if empty.
   */
  private buildPersistedSegments(segments: StreamSegment[]): MessageSegment[] | undefined {
    if (segments.length === 0) return undefined;
    return segments.map((seg) => {
      if (seg.type === "text") return { type: "text" as const, content: seg.content };
      if (seg.type === "thinking") return { type: "thinking" as const, content: seg.content };
      if (seg.type === "push") return { type: "push" as const, content: seg.content, contentType: seg.contentType };
      return {
        type: "tools" as const,
        tools: seg.tools.map((tc) => ({ name: tc.name, summary: tc.summary })),
      };
    });
  }

  /**
   * Removes a stream from the map and cleans up the reverse lookup.
   * @param chatId - The chatId to remove.
   */
  private removeStream(chatId: string): void {
    const stream = this.streams.get(chatId);
    if (stream) {
      // Only remove the reverse lookup if it still points to this chatId
      const currentChatId = this.convToChatId.get(stream.conversationId);
      if (currentChatId === chatId) {
        const next = new Map(this.convToChatId);
        next.delete(stream.conversationId);
        this.convToChatId = next;
      }
      // Clear active stream fields if this was the active conversation's stream
      if (stream.conversationId === this.activeConversationId) {
        this.activeStreamContent = "";
        this.activeStreamTool = null;
        this.activeStreamSegments = [];
      }
    }
    this.streams.delete(chatId);
    this.streams = new Map(this.streams);
  }

  /**
   * Truncates the server-side session.
   *
   * On failure sets `this.error`; callers must then leave the conversation
   * unchanged so it keeps matching the session.
   * @param query - The truncation query, from `truncateQuery`.
   * @returns Whether the session was truncated.
   */
  private async truncateServerSession(query: Record<string, string>): Promise<boolean> {
    if (!this.currentSessionId) return true;
    const origin = uuid();
    this.ownOrigins.add(origin);
    try {
      const res = await authFetch(
        `/api/sessions/${this.currentSessionId}/messages?${new URLSearchParams({ ...query, origin })}`,
        { method: "DELETE" },
      );
      if (res.ok) return true;
      const body = await res.json().catch(() => null);
      await this.handleRequestError(body, t("chat.syncFailed"));
    } catch (err) {
      console.error("Failed to truncate server session:", err);
      this.error = t("chat.syncFailed");
    }
    return false;
  }

  /**
   * Deletes the backend session (and all its messages) for a deleted conversation.
   *
   * Best-effort: failures are logged but do not block local deletion, since the
   * conversation has already been removed from IndexedDB.
   *
   * @param sessionId - The server-side session ID to delete.
   */
  private async deleteServerSession(sessionId: string): Promise<void> {
    try {
      await authFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
    } catch (err) {
      console.error("Failed to delete server session:", err);
    }
  }
}

/** Singleton chat stream store instance. */
export const chatStream = new ChatStreamStore();
