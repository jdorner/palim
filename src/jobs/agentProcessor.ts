/**
 * Reusable agent processor - extracts the shared "create agent, subscribe to
 * events, prompt, collect result" pattern from the queue factories.
 *
 * Queue factories no longer need to know about {@link Agent}, models,
 * skills, or tools - all of that is injected via {@link AgentProcessorConfig}.
 */

import type { AgentEvent, AgentMessage, AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Agent } from "@mariozechner/pi-agent-core";
import type { Model, TextContent } from "@mariozechner/pi-ai";
import type { EventBus } from "@src/extensions/eventBus";
import type { AgentEventContext, BeforeAgentStartEvent, CoreQueueName } from "@src/extensions/types";
import type { QueueJob } from "@src/queue";
import { getSessionStore } from "@src/session";
import { createSandboxTools, SANDBOX_TOOL_NAMES } from "@src/tools/file";
import type { Bash } from "just-bash";
import { registerJob, unregisterJob } from "./cancellation";

/** Dependencies injected into the agent processor at call time. */
export interface AgentProcessorConfig {
  /** LLM model to use. */
  model: Model<"openai-completions">;
  /**
   * Tool names to make available to the agent.
   * Sandbox tool names (e.g. `"exec"`, `"read_file"`) are created from the
   * shell instance. All other names are resolved via {@link toolResolver}.
   */
  tools: string[];
  /**
   * Resolves a non-sandbox tool name to its {@link AgentTool} instance.
   * Called for every name in {@link tools} that is not a sandbox tool.
   * Return `undefined` to silently skip an unresolvable name.
   */
  toolResolver?: (name: string) => AgentTool | undefined;
  /** API key for the LLM provider. */
  apiKey: string;
  /** System prompt (already assembled). */
  systemPrompt: string;
  /** Thinking level passed to the agent. */
  thinkingLevel?: ThinkingLevel;
  /** Session ID for conversation context. */
  sessionId: string;
  /** Factory to create an isolated shell instance scoped to the given skills. */
  shellFactory?: (skills: string[], sessionId: string) => Promise<Bash>;
  /** Skill names to mount in the shell for this agent run. */
  skills?: string[];
  /** Event bus for dispatching the before_agent_start event. */
  eventBus?: EventBus;
  /** Which queue is running this agent (used in before_agent_start event payload). */
  queue?: CoreQueueName;
  /** Optional routing context (source, chat ID, etc.) passed to before_agent_start. */
  context?: AgentEventContext;
}

/** Result returned by {@link runAgent}. */
export interface AgentProcessorResult {
  /** The assistant's final text response. */
  answer: string;
  /** The agent's final state snapshot. */
  state: unknown;
  /** Completion timestamp (ms). */
  timestamp: number;
}

/**
 * Runs an agent to completion, reporting logs to the
 * provided {@link QueueJob}.
 *
 * Messages are loaded from the session store (via `config.sessionId`).
 * Callers must append the user message to the session before invoking.
 *
 * Event dispatching: When `config.eventBus` is present, agent lifecycle events
 * are automatically dispatched to the bus enriched with `config.context` and
 * the job ID. Callers can override this behavior by providing an explicit
 * `onAgentEvent` callback (e.g. workflows that stamp extra routing metadata).
 *
 * @param job - The queue job (used for logging)
 * @param config - Injected dependencies (model, tools, API key, sessionId, etc.)
 * @param onAgentEvent - Optional override callback. When provided, replaces the
 *   automatic EventBus dispatch for agent lifecycle events.
 * @returns The processing result
 */
export async function runAgent(
  job: QueueJob<unknown>,
  config: AgentProcessorConfig,
  onAgentEvent?: (event: AgentEvent) => void,
): Promise<AgentProcessorResult> {
  const ac = new AbortController();
  registerJob(job.id, ac);

  let shell: Bash | null = null;

  try {
    // Resolve tool names to instances
    const requestedNames = new Set(config.tools);
    const resolvedTools: AgentTool[] = [];

    // Create sandbox tools from the shell (if available)
    if (config.shellFactory) {
      shell = await config.shellFactory(config.skills ?? [], config.sessionId);
      for (const tool of createSandboxTools(shell)) {
        if (requestedNames.has(tool.name)) {
          resolvedTools.push(tool);
        }
      }
    }

    // Resolve remaining (non-sandbox) names via the resolver
    if (config.toolResolver) {
      for (const name of requestedNames) {
        if (SANDBOX_TOOL_NAMES.has(name)) continue; // already handled above
        const tool = config.toolResolver(name);
        if (tool) resolvedTools.push(tool);
      }
    }

    const tools = resolvedTools;

    // Build messages - load from session store
    const sessionStore = getSessionStore();
    const messages: AgentMessage[] = sessionStore.getMessages(config.sessionId);

    // Dispatch before_agent_start - let extensions mutate systemPrompt and messages
    let systemPrompt = config.systemPrompt;
    if (config.eventBus) {
      const beforeEvent: BeforeAgentStartEvent = {
        type: "before_agent_start",
        queue: config.queue ?? "agents",
        systemPrompt,
        messages,
        sessionId: config.sessionId,
        context: config.context,
      };
      await config.eventBus.dispatchAwait(beforeEvent);
      systemPrompt = beforeEvent.systemPrompt;
    }

    const agent = new Agent({
      initialState: {
        model: config.model,
        tools,
        thinkingLevel: config.thinkingLevel ?? "low",
        systemPrompt: systemPrompt,
      },
      convertToLlm: (messages) => messages.filter((m) => m.role !== "push"),
      getApiKey: () => config.apiKey,
    });

    // Wire external cancellation to agent abort
    ac.signal.addEventListener("abort", () => agent.abort(), { once: true });

    // Log conversation context and prompt in chronological order.
    // Prior turns (everything before the last user message) are logged as context,
    // then the new user prompt follows in the correct position.
    if (messages.length > 0) {
      const priorMessages = messages.slice(0, -1);
      const lastMessage = messages.at(-1)!;

      for (const msg of priorMessages) {
        const text = extractMessageText(msg);
        if (text) {
          const label = msg.role === "user" ? "User" : msg.role === "assistant" ? "Assistant" : msg.role;
          await job.log(`**${label}:**\n\n${text}`);
        }
      }

      const promptText = extractMessageText(lastMessage);
      if (promptText) {
        await job.log(`**Prompt:**\n\n${promptText}`);
      }
    }

    // Track how many messages are replayed by the agent framework so we can
    // skip logging their message_end events (they are already logged above).
    const replayedMessageCount = messages.length;
    let replayedSeen = 0;

    let assistantMessage = "";
    let thinkingBuffer = "";

    // Resolve the event dispatch function: explicit callback takes precedence,
    // otherwise auto-dispatch to the EventBus with routing context.
    const dispatchEvent: ((event: AgentEvent) => void) | undefined = onAgentEvent
      ? onAgentEvent
      : config.eventBus
        ? (event) => {
            config.eventBus!.dispatch({
              ...event,
              context: config.context ? { ...config.context, jobId: job.id } : undefined,
            });
          }
        : undefined;

    agent.subscribe(async (event) => {
      dispatchEvent?.(event);

      // The agent framework replays message_start/message_end for all prompt
      // messages (the full session history). Skip logging those since we
      // already logged them as context above.
      if (event.type === "message_end" && replayedSeen < replayedMessageCount) {
        replayedSeen++;
        return;
      }
      if (event.type === "message_start" && replayedSeen < replayedMessageCount) {
        return;
      }

      if (event.type === "message_update") {
        const assistantEvent = event.assistantMessageEvent;
        if (assistantEvent?.type === "thinking_delta" && assistantEvent.delta) {
          thinkingBuffer += assistantEvent.delta;
        }
        if (assistantEvent?.type === "thinking_end" && thinkingBuffer) {
          await job.log(`***Thinking:***\n\n${thinkingBuffer}`);
          thinkingBuffer = "";
        }
      }

      if (event.type === "tool_execution_start") {
        await job.log(`**Executing tool:**\n\n${event.toolName} ${JSON.stringify(event.args)}`);
      }

      if (event.type === "tool_execution_end") {
        const toolResults: TextContent[] = event.result.content.filter((m: TextContent) => m.type === "text");
        if (toolResults?.[0]) {
          await job.log(`**Tool call result:**\n\n${toolResults[0].text}`);
        }
      }

      if (event.type === "message_end" && event.message.role === "assistant") {
        if (event.message.stopReason === "length") {
          throw new Error("Maximum response length exceeded.");
        }

        const textMessages = event.message.content.filter((m) => m.type === "text");
        if (textMessages.length > 0) {
          assistantMessage = textMessages[0]?.text || "";
          await job.log(assistantMessage);
        }
      }
    });

    await agent.prompt(messages);

    if (ac.signal.aborted) {
      await job.log("Agent run was cancelled.");
      return { answer: "", state: agent.state, timestamp: Date.now() };
    }

    if (agent.state.errorMessage) {
      throw new Error(agent.state.errorMessage);
    }

    // Auto-append new messages to the session on successful completion
    {
      // The agent's messages array includes the system prompt (index 0) and
      // all prior session messages. New messages start after those.
      const priorCount = messages.length; // system prompt + session history
      const allMessages = agent.state.messages ?? [];
      const newMessages = allMessages.slice(priorCount);
      for (const msg of newMessages) {
        sessionStore.append(config.sessionId, msg);
      }
    }

    return { answer: assistantMessage, state: agent.state, timestamp: Date.now() };
  } catch (err: unknown) {
    await job.log(`**Error:** ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  } finally {
    unregisterJob(job.id);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Content block shape for text extraction. */
interface ContentBlock {
  type: string;
  text?: string;
}

/**
 * Extracts a plain-text representation from an {@link AgentMessage}.
 *
 * Handles both string content (user messages appended via session store) and
 * array content (assistant messages with content blocks).
 *
 * @param msg - The agent message to extract text from
 * @returns The text content, or undefined if no text could be extracted
 */
function extractMessageText(msg: AgentMessage): string | undefined {
  if (typeof msg.content === "string") {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    const textBlock = (msg.content as ContentBlock[]).find((c) => c.type === "text");
    return textBlock?.text;
  }
  return undefined;
}
