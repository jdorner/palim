/**
 * Chat streaming and token usage types shared between backend and frontend.
 *
 * @module
 */

/** WebSocket message for chat streaming events. */
export interface ChatWebSocketEvent {
  type: "chat_event";
  chatId: string;
  event: "text_delta" | "thinking_delta" | "tool_start" | "tool_end" | "done" | "error";
  /** Text content for text_delta, thinking_delta, and done events. */
  content?: string;
  /** Tool name for tool_start/tool_end events. */
  toolName?: string;
  /** Tool arguments for tool_start events. */
  toolArgs?: Record<string, unknown>;
  /** Tool result text for tool_end events. */
  toolResult?: string;
  /** Error message for error events. */
  error?: string;
  /** Queue job ID that produced this response (included in done events). */
  jobId?: string;
  /** Token usage data from the final assistant message (included in done events). */
  usage?: TokenUsage;
}

/** Token usage data for a single assistant message or aggregated across a session. */
export interface TokenUsage {
  /** Number of input (prompt) tokens. */
  input: number;
  /** Number of output (completion) tokens. */
  output: number;
  /** Number of tokens read from cache. */
  cacheRead: number;
  /** Number of tokens written to cache. */
  cacheWrite: number;
  /** Total tokens consumed (input + output). */
  totalTokens: number;
}

/** Aggregated token usage for a session, returned by the usage API endpoint. */
export interface SessionUsage {
  /** Sum of input tokens across all assistant messages. */
  totalInput: number;
  /** Sum of output tokens across all assistant messages. */
  totalOutput: number;
  /** Sum of cache-read tokens across all assistant messages. */
  totalCacheRead: number;
  /** Sum of cache-write tokens across all assistant messages. */
  totalCacheWrite: number;
  /** Sum of totalTokens across all assistant messages. */
  totalTokens: number;
  /** Input token count from the most recent assistant message (approximates current context size). */
  lastInputTokens: number;
}
