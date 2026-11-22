/**
 * Converts a chat session as the server stores it into the messages the chat
 * UI keeps in IndexedDB, and summarizes tool calls the way the UI shows them.
 *
 * The server stores one row per agent message (user, assistant, tool result,
 * push). The UI shows one assistant message per turn: everything between two
 * user messages becomes a single assistant message whose segments keep the
 * order of text, thinking, tool calls, and push messages.
 *
 * Shared by the backend (which converts sessions for `GET /api/sessions/:id/chat`)
 * and the frontend (which summarizes tool calls while streaming).
 *
 * @module
 */

import type { TokenUsage } from "./chat";

/** Longest tool summary the UI shows before truncating it. */
const TOOL_SUMMARY_LIMIT = 80;

/** One stored session message, as read for conversion. */
export interface TranscriptSourceMessage {
  /** The message's sequence number within the session. */
  seq: number;
  /** The client-generated ID (chat user messages), or `null`. */
  clientId: string | null;
  /** The agent message role ("user", "assistant", "toolResult", "push", ...). */
  role: string;
  /** The message content: a string or an array of content blocks. */
  content: unknown;
  /** Epoch timestamp (ms) when the message was produced. */
  timestamp: number;
  /** Token usage (assistant messages only). */
  usage?: unknown;
}

/** A segment of a converted assistant message. */
export type TranscriptSegment =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tools"; tools: { name: string; summary: string }[] }
  | { type: "push"; content: string; contentType: "text/markdown" | "text/plain" };

/** A converted chat message, ready to store in the UI. */
export interface TranscriptMessage {
  /** The UI message ID: the client ID for user messages, `undefined` for assistant messages (the UI assigns one). */
  id?: string;
  /** "user" or "assistant". */
  role: "user" | "assistant";
  /** The message text. For assistant messages, the final text block of the turn. */
  content: string;
  /** Epoch timestamp (ms); strictly increasing within a transcript. */
  createdAt: number;
  /** Interleaved segments (assistant messages only). */
  segments?: TranscriptSegment[];
  /** Token usage of the turn's last assistant message (assistant messages only). */
  usage?: TokenUsage;
}

/**
 * Builds the short summary the chat UI shows for a tool call.
 *
 * Shell commands show the command, file tools the path, other tools their
 * first non-empty string argument. Longer summaries are cut to 80 characters.
 *
 * @param name - Tool name (e.g. "exec", "read_file")
 * @param args - The tool call's arguments
 * @returns The summary, or the tool name when the arguments say nothing useful
 */
export function summarizeToolCall(name: string, args?: Record<string, unknown>): string {
  const summary = rawToolSummary(name, args);
  return summary.length > TOOL_SUMMARY_LIMIT ? `${summary.slice(0, TOOL_SUMMARY_LIMIT - 3)}...` : summary;
}

/**
 * Picks the untruncated tool summary (see {@link summarizeToolCall}).
 *
 * @param name - Tool name
 * @param args - The tool call's arguments
 * @returns The summary
 */
function rawToolSummary(name: string, args?: Record<string, unknown>): string {
  if (!args || typeof args !== "object") return name;
  if (name === "exec" && typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return `${name} ${args.path}`;
  for (const val of Object.values(args)) {
    if (typeof val === "string" && val.length > 0) return val;
  }
  return name;
}

/**
 * Derives a conversation title from its first user message.
 *
 * @param content - The message text
 * @returns The trimmed text, cut to 50 characters
 */
export function titleFromMessage(content: string): string {
  const trimmed = content.trim();
  return trimmed.length <= 50 ? trimmed : `${trimmed.slice(0, 47)}...`;
}

/**
 * Reads the text of a user or push message.
 *
 * @param content - A string, or an array of content blocks
 * @returns The string, or the text blocks joined by newlines
 */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Reads the token usage of an assistant message.
 *
 * @param usage - The stored usage object
 * @returns The usage, or `undefined` when there is none
 */
function toTokenUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Partial<Record<keyof TokenUsage, unknown>>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    input: num(u.input),
    output: num(u.output),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    totalTokens: num(u.totalTokens),
  };
}

/** An assistant message being collected from the rows between two user messages. */
interface TurnBuilder {
  segments: TranscriptSegment[];
  /** The final text of the turn, as the `done` event reports it. */
  finalText: string;
  usage?: TokenUsage;
  lastTimestamp: number;
}

/**
 * Appends a segment, merging it into the previous one when both are text,
 * thinking, or tool segments (as the UI does while streaming).
 *
 * @param segments - The segments so far (changed in place)
 * @param seg - The segment to add
 */
function pushSegment(segments: TranscriptSegment[], seg: TranscriptSegment): void {
  const last = segments.at(-1);
  if (last && last.type === seg.type) {
    if ((last.type === "text" || last.type === "thinking") && (seg.type === "text" || seg.type === "thinking")) {
      last.content += seg.content;
      return;
    }
    if (last.type === "tools" && seg.type === "tools") {
      last.tools.push(...seg.tools);
      return;
    }
  }
  segments.push(seg);
}

/**
 * Adds one assistant message's content blocks to a turn.
 *
 * @param turn - The turn being built
 * @param content - The message's content blocks
 */
function addAssistantContent(turn: TurnBuilder, content: unknown): void {
  if (typeof content === "string") {
    if (content) {
      pushSegment(turn.segments, { type: "text", content });
      turn.finalText = content;
    }
    return;
  }
  if (!Array.isArray(content)) return;
  let firstText: string | undefined;
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string" && block.text) {
      pushSegment(turn.segments, { type: "text", content: block.text });
      firstText ??= block.text;
    } else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
      pushSegment(turn.segments, { type: "thinking", content: block.thinking });
    } else if (block?.type === "toolCall" && typeof block.name === "string") {
      const args = block.arguments && typeof block.arguments === "object" ? block.arguments : undefined;
      pushSegment(turn.segments, {
        type: "tools",
        tools: [{ name: block.name, summary: summarizeToolCall(block.name, args) }],
      });
    }
  }
  if (firstText !== undefined) turn.finalText = firstText;
}

/**
 * Converts a chat session into UI messages.
 *
 * - A user message becomes a user message whose ID is its client ID. Rows
 *   stored without one get `legacy-<seq>`.
 * - Everything up to the next user message becomes one assistant message.
 *   Its text is the turn's final text block (as the `done` event reports it),
 *   its usage that of the last assistant message with usage. Tool results are
 *   dropped; push messages become push segments. A turn with nothing to show
 *   yields no assistant message.
 * - `createdAt` follows the stored timestamps but is forced to increase, since
 *   the UI orders and truncates messages by it.
 *
 * @param rows - The session's messages, ordered by `seq`
 * @returns The UI messages, oldest first
 */
export function sessionToChatMessages(rows: TranscriptSourceMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let lastCreatedAt = Number.NEGATIVE_INFINITY;
  const nextCreatedAt = (ts: number) => {
    lastCreatedAt = Math.max(Number.isFinite(ts) ? ts : 0, lastCreatedAt + 1);
    return lastCreatedAt;
  };

  let turn: TurnBuilder | null = null;
  const flush = () => {
    if (turn && turn.segments.length > 0) {
      out.push({
        role: "assistant",
        content: turn.finalText,
        createdAt: nextCreatedAt(turn.lastTimestamp),
        segments: turn.segments,
        ...(turn.usage ? { usage: turn.usage } : {}),
      });
    }
    turn = null;
  };

  for (const row of rows) {
    if (row.role === "user") {
      flush();
      out.push({
        id: row.clientId ?? `legacy-${row.seq}`,
        role: "user",
        content: messageText(row.content),
        createdAt: nextCreatedAt(row.timestamp),
      });
      continue;
    }

    const current: TurnBuilder = turn ?? { segments: [], finalText: "", lastTimestamp: row.timestamp };
    turn = current;
    current.lastTimestamp = row.timestamp;
    if (row.role === "assistant") {
      addAssistantContent(current, row.content);
      current.usage = toTokenUsage(row.usage) ?? current.usage;
    } else if (row.role === "push") {
      const text = messageText(row.content);
      if (text) pushSegment(current.segments, { type: "push", content: text, contentType: "text/markdown" });
    }
  }
  flush();
  return out;
}
