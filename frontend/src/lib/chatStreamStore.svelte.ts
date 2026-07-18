/**
 * Central chat streaming store. Processes chat WebSocket events globally
 * so in-flight responses survive page navigation.
 *
 * ChatView reads reactive state from the singleton `chatStream` instance
 * and delegates send/cancel/edit actions through its methods.
 */

import type {
  ApprovalRequestEvent,
  ChatWebSocketEvent,
  FeedbackReportEvent,
  PushMessageEvent,
  SessionUsage,
} from "../../../shared/types";
import { authFetch } from "./auth";
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
  updateConversationSessionId,
  updateConversationTitle,
  updateMessageContent,
} from "./chatStore";
import { readState } from "./readState.svelte";
import { uuid } from "./utils";

function truncateString(str: string, limit: number) {
  if (str.length > limit) {
    return `${str.substring(0, limit - 3)}...`;
  }
  return str;
}

/**
 * Extracts a human-readable summary from tool call arguments.
 * @param name - Tool name (e.g. "exec", "read_file")
 * @param args - Raw tool arguments from the WebSocket event
 * @returns A short summary string, or the tool name as fallback
 */
function summarizeToolCall(name: string, args?: Record<string, unknown>): string {
  if (!args) return name;

  // Shell commands - show the command itself
  if (name === "exec" && typeof args.command === "string") {
    return args.command;
  }

  // File tools - show the path
  if (typeof args.path === "string") {
    return `${name} ${args.path}`;
  }

  // Fallback: show first string arg value
  for (const val of Object.values(args)) {
    if (typeof val === "string" && val.length > 0) {
      return val;
    }
  }

  return name;
}

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
  /** Messages for the active conversation. */
  messages = $state<Message[]>([]);
  /** Last error message, if any. */
  error = $state<string | null>(null);
  /** Token usage for the active conversation's server-side session. */
  sessionUsage = $state<SessionUsage | null>(null);

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
      this.messages = await getMessages(id);
      // Restore persisted server-side session ID
      const conv = this.conversations.find((c) => c.id === id);
      this.currentSessionId = conv?.sessionId ?? null;
      // Fetch token usage from the server if session exists
      this.fetchSessionUsage();
    } catch (err) {
      console.error("Failed to load messages:", err);
      this.messages = [];
      this.currentSessionId = null;
      this.sessionUsage = null;
    }
  }

  /**
   * Creates a new conversation and selects it.
   * @returns The new conversation's ID.
   */
  async handleCreate(): Promise<string> {
    const conv = await createConversation("New Chat");
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
    await deleteConversation(id);
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
        this.error = event.error ?? "An unknown error occurred";
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
        const summary = truncateString(summarizeToolCall(name, event.toolArgs), 80);
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
        this.error = event.error ?? "An unknown error occurred";
        this.preservePartialAndFinalize(event.chatId);
        break;
    }
  }

  /** Handles WebSocket close while streaming. Preserves partial content for all active streams. */
  handleWsClose(): void {
    if (this.streams.size > 0) {
      this.error = "Connection lost. Your partial response has been preserved.";
      // Preserve all active streams
      for (const chatId of [...this.streams.keys()]) {
        this.preservePartialAndFinalize(chatId);
      }
    }
  }

  /**
   * Handles a feedback_report WebSocket event by auto-creating a new conversation
   * with the report as the first assistant message.
   * @param event - The feedback report event from the backend.
   */
  async handleFeedbackReport(event: FeedbackReportEvent): Promise<void> {
    try {
      const title = `Feedback: ${event.report.slice(0, 40).replace(/\n/g, " ")}...`;
      const conv = await createConversation(title, { feedbackConversation: true });
      const contentSegments: MessageSegment[] = [{ type: "text", content: event.report }];
      await addMessage({
        conversationId: conv.id,
        role: "assistant",
        content: event.report,
        createdAt: Date.now(),
        segments: contentSegments,
      });
      await this.loadConversations();
    } catch (err) {
      console.error("Failed to create feedback conversation:", err);
    }
  }

  /**
   * Handles an approval_request WebSocket event by auto-creating a new
   * conversation with the extension details and approve/reject action buttons.
   * @param event - The approval request event from the backend.
   */
  async handleApprovalRequest(event: ApprovalRequestEvent): Promise<void> {
    try {
      const title = `Install: ${event.name} v${event.version}`;
      const conv = await createConversation(title);

      const packageList = event.packages.map((p) => `- \`${p}\``).join("\n");
      let content = `**Extension "${event.name}" v${event.version}** wants to install npm packages:\n\n${packageList}`;

      if (event.description) {
        content = `${event.description}\n\n${content}`;
      }

      if (event.binRequirements.length > 0) {
        content += `\n\nRequired system binaries: ${event.binRequirements.join(", ")}`;
      }

      const contentSegments: MessageSegment[] = [
        { type: "text", content },
        {
          type: "actions",
          actions: [
            {
              label: "Approve",
              endpoint: `/ext/ext-installer/approve/${event.name}`,
              method: "POST",
              variant: "default",
              body: { token: event.approvalToken },
            },
            {
              label: "Reject",
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

    await this.startStream(content);
    return this.activeConversationId;
  }

  /** Cancels the in-flight request for the active conversation. */
  async handleCancel(): Promise<void> {
    if (!this.activeConversationId) return;
    const chatId = this.convToChatId.get(this.activeConversationId);
    if (!chatId) return;

    const stream = this.streams.get(chatId);
    const jobId = stream?.jobId ?? null;

    this.preservePartialAndFinalize(chatId);

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
   * @param msg - The message to delete.
   */
  async handleDeleteMessage(msg: Message): Promise<void> {
    if (!this.activeConversationId) return;
    if (this.activeStreaming) return;
    await deleteMessagesFrom(this.activeConversationId, msg.createdAt);
    this.messages = this.messages.filter((m) => m.createdAt < msg.createdAt);

    // Sync server-side session: count remaining complete turns and trailing user message
    if (this.currentSessionId) {
      const lastMsg = this.messages[this.messages.length - 1];
      const lastIsUser = lastMsg?.role === "user";
      const userCount = this.messages.filter((m) => m.role === "user").length;
      // If the last message is a user message, it's a trailing message without a response.
      // Keep (userCount - 1) complete turns + that trailing user message.
      // Otherwise keep all complete turns.
      const completeTurns = lastIsUser ? userCount - 1 : userCount;
      await this.truncateServerSession(completeTurns, lastIsUser);
    }
  }

  /**
   * Edits a message, removes all subsequent messages, and re-sends.
   * @param msg - The message to edit.
   * @param newContent - The replacement content.
   */
  async handleEditMessage(msg: Message, newContent: string): Promise<void> {
    if (!this.activeConversationId) return;
    if (this.activeStreaming) return;

    await updateMessageContent(msg.id, newContent);

    const msgIndex = this.messages.findIndex((m) => m.id === msg.id);
    if (msgIndex < 0) return;

    for (const m of this.messages.slice(msgIndex + 1)) {
      await deleteMessage(m.id);
    }

    this.messages = this.messages
      .slice(0, msgIndex + 1)
      .map((m) => (m.id === msg.id ? { ...m, content: newContent } : m));

    // Truncate server-side session: keep turns before the edited message
    // (the edited user message will be re-sent as a new turn)
    if (this.currentSessionId) {
      const userTurns = this.messages.slice(0, msgIndex).filter((m) => m.role === "user").length;
      await this.truncateServerSession(userTurns);
    }

    await this.startStream(newContent);
  }

  /**
   * Regenerates the response for a given assistant message.
   * @param msg - The assistant message to regenerate from.
   */
  async handleRegenerate(msg: Message): Promise<void> {
    if (!this.activeConversationId) return;
    if (this.activeStreaming) return;

    //console.log($state.snapshot(msg))
    //return
    await deleteMessagesFrom(this.activeConversationId, msg.createdAt);
    this.messages = this.messages.filter((m) => m.createdAt < msg.createdAt);

    // Truncate server-side session to remove the assistant message being regenerated
    // Keep all turns before the last one complete, plus the trailing user message
    if (this.currentSessionId) {
      const userTurns = this.messages.filter((m) => m.role === "user").length;
      await this.truncateServerSession(userTurns - 1, true);
    }

    // Re-send the last user message
    const lastUserMsg = [...this.messages].reverse().find((m) => m.role === "user");
    if (!lastUserMsg) return;

    await this.startStream(lastUserMsg.content, { skipAppend: true });
  }

  /** Retries the last request using the current message history. */
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

    // Only skip appending if we already have a server-side session (meaning the
    // message was previously delivered). If the original request never reached the
    // server, the message must be appended to the newly created session.
    const skipAppend = !!this.currentSessionId;
    await this.startStream(lastUserMsg.content, { skipAppend });
  }

  /**
   * Sends feedback for a downvoted assistant message.
   * @param msg - The downvoted assistant message.
   * @param comment - The user's feedback comment (may be empty).
   */
  async handleDownvote(msg: Message, comment: string): Promise<void> {
    if (!this.activeConversationId) return;

    const payload = {
      chatId: this.activeConversationId,
      jobId: msg.jobId ?? "",
      comment,
      messages: this.messages.map((m) => ({ role: m.role, content: m.content })),
    };

    try {
      await authFetch("/ext/response-feedback/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error("Failed to send feedback:", err);
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Fetches token usage for the current server-side session.
   * Updates the `sessionUsage` reactive field. Fails silently.
   */
  async fetchSessionUsage(): Promise<void> {
    if (!this.currentSessionId) {
      this.sessionUsage = null;
      return;
    }
    try {
      const res = await authFetch(`/api/sessions/${this.currentSessionId}/usage`);
      if (res.ok) {
        const data = (await res.json()) as SessionUsage & { sessionId: string };
        this.sessionUsage = {
          totalInput: data.totalInput,
          totalOutput: data.totalOutput,
          totalCacheRead: data.totalCacheRead,
          totalCacheWrite: data.totalCacheWrite,
          totalTokens: data.totalTokens,
          lastInputTokens: data.lastInputTokens,
        };
      } else {
        this.sessionUsage = null;
      }
    } catch {
      // Non-critical - silently ignore
    }
  }

  /**
   * Starts a streaming request to the chat API.
   * @param message - The user message to send.
   * @param options - Optional flags for the request.
   */
  private async startStream(message: string, options?: { skipAppend?: boolean }): Promise<void> {
    const chatId = uuid();
    const convId = this.activeConversationId!;

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
      const payload: Record<string, string | boolean> = {
        message,
        chatId,
      };
      if (this.currentSessionId) {
        payload.sessionId = this.currentSessionId;
      }
      if (options?.skipAppend) {
        payload.skipAppend = true;
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
        const body = await res.json().catch(() => ({ error: "Request failed" }));
        this.error = body.error || `HTTP ${res.status}`;
        this.removeStream(chatId);
      }
    } catch {
      this.error = "Failed to send message. Check your connection.";
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

    const targetConvId = stream.conversationId;

    try {
      const segments = this.buildPersistedSegments(stream.segments);
      const assistantMsg = await addMessage({
        conversationId: targetConvId,
        role: "assistant",
        content,
        createdAt: Date.now(),
        ...(stream.doneJobId ? { jobId: stream.doneJobId } : {}),
        ...(segments ? { segments } : {}),
        ...(stream.doneUsage ? { usage: stream.doneUsage } : {}),
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

    this.removeStream(chatId);
    // Refresh conversation list so updatedAt changes are reflected (triggers unread styling)
    await this.loadConversations();
    // Refresh session usage to reflect the new assistant message's tokens
    this.fetchSessionUsage();
  }

  /**
   * Preserves any partial streaming content as an assistant message, then removes the stream.
   * @param chatId - The chatId identifying the stream.
   */
  private async preservePartialAndFinalize(chatId: string): Promise<void> {
    const stream = this.streams.get(chatId);
    if (!stream) return;

    const targetConvId = stream.conversationId;
    if (stream.content && targetConvId) {
      try {
        const segments = this.buildPersistedSegments(stream.segments);
        const partialMsg = await addMessage({
          conversationId: targetConvId,
          role: "assistant",
          content: stream.content,
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
    this.removeStream(chatId);
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
   * Truncates the server-side session to keep only the first N complete turns.
   * A "turn" = a user message + all following assistant/tool messages until the
   * next user message. Optionally keeps one additional trailing user message
   * (without its response).
   * @param keepTurns - Number of complete turns to keep.
   * @param includeTrailingUserMessage - If true, also keep the user message that starts the next turn (without its response).
   */
  private async truncateServerSession(keepTurns: number, includeTrailingUserMessage = false): Promise<void> {
    if (!this.currentSessionId) return;
    try {
      const params = new URLSearchParams({ keep: String(keepTurns) });
      if (includeTrailingUserMessage) {
        params.set("includeTrailing", "true");
      }
      await authFetch(`/api/sessions/${this.currentSessionId}/messages?${params}`, {
        method: "DELETE",
      });
    } catch (err) {
      console.error("Failed to truncate server session:", err);
    }
  }
}

/** Singleton chat stream store instance. */
export const chatStream = new ChatStreamStore();
