/**
 * Chat event broadcasting - maps agent lifecycle events to {@link ChatWebSocketEvent}
 * messages for real-time streaming to the chat frontend via WebSocket.
 *
 * Only processes events from jobs with `context.source === "chat"`.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ChatWebSocketEvent, TokenUsage } from "@shared/types";
import type { AgentEventContext, EventParam } from "@src/extensions";

// ---------------------------------------------------------------------------
// Internal typed shapes for event payloads that pi-agent-core exposes
// at runtime but whose intersection with EventParam loses precision.
// ---------------------------------------------------------------------------

/**
 * Typed payload for the `agent_end` event as dispatched through the event bus.
 * Combines the pi-agent-core `AgentEvent` shape with the routing context
 * added by the agent processor.
 */
interface AgentEndEvent {
  type: "agent_end";
  messages: AgentMessage[];
  context?: AgentEventContext;
}

/** Shape of an assistant message's content block. */
interface ContentBlock {
  type: string;
  text?: string;
}

/** Shape of token usage attached to assistant messages at runtime. */
interface AssistantUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

/** Runtime shape of an assistant message (fields beyond the base AgentMessage type). */
interface AssistantMessagePayload {
  role: "assistant";
  content: ContentBlock[];
  usage?: AssistantUsage;
}

/** Shape of tool result content returned by agent tools. */
interface ToolResultPayload {
  content?: Array<{ type: string; text?: string }>;
}

/**
 * Maps an {@link EventParam} to a {@link ChatWebSocketEvent} for WebSocket broadcast.
 *
 * Returns `undefined` if the event is not from a chat source or has no meaningful
 * chat representation (e.g. `turn_start`, `agent_start`).
 *
 * @param event - The agent event (with optional routing context)
 * @returns A chat WebSocket event to broadcast, or `undefined` if not applicable
 */
export function mapAgentEventToChatEvent(event: EventParam): ChatWebSocketEvent | undefined {
  const context = event.context;
  if (context?.source !== "chat" || !context.id) return undefined;

  const chatId = context.id;

  switch (event.type) {
    case "message_update": {
      const assistantEvent = event.assistantMessageEvent;
      if (assistantEvent?.type === "text_delta" && assistantEvent.delta) {
        return { type: "chat_event", chatId, event: "text_delta", content: assistantEvent.delta };
      }
      if (assistantEvent?.type === "thinking_delta" && assistantEvent.delta) {
        return { type: "chat_event", chatId, event: "thinking_delta", content: assistantEvent.delta };
      }
      return undefined;
    }

    case "tool_execution_start":
      return {
        type: "chat_event",
        chatId,
        event: "tool_start",
        toolName: event.toolName,
        toolArgs: event.args,
      };

    case "tool_execution_end":
      return {
        type: "chat_event",
        chatId,
        event: "tool_end",
        toolName: event.toolName,
        toolResult: extractToolResultText(event.result),
      };

    case "message_end":
      // Don't emit done here - message_end fires for every assistant turn,
      // not just the final one. The done event is sent from agent_end instead.
      return undefined;

    case "agent_end": {
      // Agent run completed - collect the final assistant text and usage from the last message
      const endEvent = event as unknown as AgentEndEvent;
      const messages = endEvent.messages;
      let finalText = "";
      let usage: TokenUsage | undefined;
      if (Array.isArray(messages)) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i] as unknown as AssistantMessagePayload | undefined;
          if (msg?.role === "assistant") {
            if (!finalText && Array.isArray(msg.content)) {
              const textContent = msg.content.find((c) => c.type === "text");
              if (textContent?.text) {
                finalText = textContent.text;
              }
            }
            // Extract usage from the last assistant message (most recent context snapshot)
            if (!usage && msg.usage) {
              usage = {
                input: msg.usage.input ?? 0,
                output: msg.usage.output ?? 0,
                cacheRead: msg.usage.cacheRead ?? 0,
                cacheWrite: msg.usage.cacheWrite ?? 0,
                totalTokens: msg.usage.totalTokens ?? 0,
              };
            }
            if (finalText && usage) break;
          }
        }
      }
      return {
        type: "chat_event",
        chatId,
        event: "done",
        content: finalText,
        jobId: context.jobId as string | undefined,
        usage,
      };
    }

    default:
      return undefined;
  }
}

/**
 * Extracts a text summary from an agent tool result.
 *
 * @param result - The raw tool result object
 * @returns A string representation of the result content
 */
function extractToolResultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const payload = result as ToolResultPayload;
  if (!Array.isArray(payload.content)) return undefined;
  const textPart = payload.content.find((c) => c.type === "text");
  return textPart?.text;
}
