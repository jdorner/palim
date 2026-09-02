/**
 * DAG Workflow step worker - processes step jobs dispatched by the DAG engine.
 *
 * Similar to the legacy worker but reads template context from the DAG Run Store
 * instead of chain-parent results (since DAG jobs are individually dispatched).
 *
 * @module
 */

import type { ExtensionContext, Logger, QueueJob, StepTypeHandler } from "@ext/types";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { SANDBOX_TOOL_NAMES } from "@src/tools/file";
import type { TemplateVariableResolver } from "@src/variables";
import type { DagStepJobData } from "./dagEngine";
import * as dagRunStore from "./dagRunStore";
import { normalizePrompt } from "./schemas";
import type { TemplateContext, TemplateSecretResolver } from "./template";
import { resolveTemplates } from "./template";

/** Dependencies injected into the DAG step worker. */
export interface DagStepWorkerDeps {
  /** The extension context for running agents. */
  ctx: ExtensionContext;
  /** Emits an agent event onto the shared event bus. */
  emitEvent: (event: AgentEvent, jobId: string, jobData: DagStepJobData) => void;
  /** Logger instance. */
  log: Logger;
  /** Looks up a registered custom step type handler by type name. */
  getStepHandler?: (type: string) => StepTypeHandler | undefined;
}

/**
 * Builds the template context for a DAG step by reading all accumulated
 * results from the DAG Run Store.
 *
 * @param data - The DAG step job data
 * @param deps - Worker dependencies
 * @returns Template context with trigger payload and all previous step results
 */
async function buildDagTemplateContext(data: DagStepJobData, deps: DagStepWorkerDeps): Promise<TemplateContext> {
  // Read accumulated state from Run Store
  const run = dagRunStore.get(data.workflowRunId);
  const stepResults = run?.stepResults ?? {};
  const triggerPayload = run?.triggerPayload ?? data.triggerPayload;

  // Build a secret resolver
  const workflowName = data.workflowName;
  const secretStore: TemplateSecretResolver = {
    async resolve(name: string, consumer: string) {
      if (deps.ctx.internal?.secrets) {
        const value = await deps.ctx.internal.secrets.resolveAs(name, consumer);
        return { value, granted: value !== null, reason: value === null ? "denied or not found" : undefined };
      }
      deps.log.warn(`Secret "${name}" cannot be resolved: vault is not configured`);
      return { value: "", granted: true };
    },
  };

  // Build a variable resolver from the injected variable store (non-sensitive,
  // no ACL). Left undefined when the store is not available, in which case
  // {{var.KEY}} expressions are left literal with a warning by the engine.
  const variableStore: TemplateVariableResolver | undefined = deps.ctx.internal?.variables
    ? {
        resolve: (key: string) => deps.ctx.internal!.variables.resolve(key),
        has: (key: string) => deps.ctx.internal!.variables.has(key),
      }
    : undefined;

  // Build iteration context if this step is inside an iterator body
  let iterationContext: TemplateContext["iterationContext"];
  if (data.iteratorSlug && run) {
    const iterState = run.stepResults[data.iteratorSlug] as
      | { items: unknown[]; cursor: number; as: string }
      | undefined;
    if (iterState && Array.isArray(iterState.items)) {
      iterationContext = {
        item: iterState.items[iterState.cursor],
        itemIndex: iterState.cursor,
        as: iterState.as ?? "item",
      };
    }
  }

  return {
    triggerPayload,
    stepResults,
    stepConfigs: data.allStepDefs,
    workflowName,
    secretStore,
    variableStore,
    iterationContext,
  };
}

/**
 * Formats resolved skill entries into the `<available_skills>` XML block.
 */
function buildSkillsContext(skills: string[], deps: DagStepWorkerDeps): string {
  const entries = skills
    .map((name) => deps.ctx.skills.resolve(name))
    .filter((entry): entry is NonNullable<typeof entry> => !!entry);

  if (entries.length === 0) return "";

  const skillBlocks = entries.map((e) => {
    const fm = e.frontmatter;
    const lines = [`<name>${fm.name}</name>`, `<description>${fm.description}</description>`];
    for (const [key, value] of Object.entries(fm)) {
      if (key !== "name" && key !== "description") lines.push(`${key}: ${value}`);
    }
    return `<skill>\n${lines.join("\n")}\n</skill>`;
  });

  return `<available_skills>\n${skillBlocks.join("\n")}\n</available_skills>`;
}

/**
 * Builds the system prompt for a DAG workflow agent step.
 */
function buildDagStepSystemPrompt(skills: string[] | undefined, deps: DagStepWorkerDeps): string {
  let prompt = ["You are a very knowledgeable expert acting as a workflow step processor."];

  if (skills && skills.length > 0) {
    const skillsContext = buildSkillsContext(skills, deps);

    prompt = prompt.concat([
      "",
      "The following skills provide specialized instructions.",
      "",
      skillsContext,
      "",
      "Always use the most precise skill for the job. Do not ask questions. Do not mention which skills or tools are available to you or which skills or tools you are going to use when responding.",
      "Use the exec tool to read the skill's full file. Example: \n ```sh\nskill read <skill-name>\n```",
      "",
      "You may only perform actions that correspond to available tools or skills. If a requested action has no matching tool or skill, state clearly that it cannot be done and explain what's actually possible.",
      "BEFORE attempting any multi-step operation:",
      "1. List the tools you'll need",
      "2. Verify each one is in your available_skills list or available as tool call",
      "3. Only proceed if ALL required capabilities exist",
      "",
      "When you execute a command, you will receive its output. Analyze the output carefully before responding.",
      "",
    ]);
  }

  prompt.push("Execute the task described in the prompt precisely.", "");
  return prompt.join("\n");
}

/**
 * Creates the DAG step processor function for the workflows:steps queue.
 *
 * @param deps - Worker dependencies
 * @returns A job processor that handles agent and custom extension step types
 */
export function createDagStepProcessor(deps: DagStepWorkerDeps) {
  return async (job: QueueJob<DagStepJobData>): Promise<unknown> => {
    const { stepDef, stepSlug, workflowName } = job.data;

    await job.log(`[${workflowName}] DAG step: ${stepSlug} (${stepDef.type})`);

    const tmplCtx = await buildDagTemplateContext(job.data, deps);
    let value: unknown;

    try {
      if (stepDef.type === "agent") {
        const agentDef = stepDef as { type: "agent"; prompt: string | string[]; tools?: string[]; skills?: string[] };
        value = await executeDagAgentStep(job, normalizePrompt(agentDef.prompt), agentDef, tmplCtx, deps);
      } else {
        // Custom step type handler
        const handler = deps.getStepHandler?.(stepDef.type);
        if (!handler) {
          throw new Error(`No handler registered for step type "${stepDef.type}"`);
        }

        // Pass the RAW step definition to the handler; do NOT pre-resolve its
        // string fields here. Handlers resolve the fields they consume via
        // `ctx.resolveTemplate(...)` themselves (see the built-in and external
        // step types). Pre-resolving would (a) double-resolve every field a
        // handler already resolves, and (b) break handlers that depend on
        // receiving raw `{{...}}` expressions - most importantly sandbox-exec,
        // which binds each expression to a shell env var for injection safety.
        // Inlining the resolved value before that binder runs lets shell
        // metacharacters (e.g. the braces/quotes in a JSON payload) reach the
        // shell unquoted, corrupting the command. Handing over the raw stepDef
        // also matches the documented contract ("the full step definition
        // object from the workflow JSON5").
        const context = {
          resolveTemplate: async (template: string) => resolveTemplates(template, tmplCtx),
          log: deps.log,
          workDir: deps.ctx.paths.work,
          jobLog: async (msg: string) => job.log(msg),
          workflowRunId: job.data.workflowRunId,
          stepResults: tmplCtx.stepResults,
          triggerPayload: tmplCtx.triggerPayload,
        };

        value = await handler.execute(stepDef as unknown as Record<string, unknown>, context);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await job.log(`Step "${stepSlug}" failed: ${errorMsg}`);
      throw err;
    }

    return value;
  };
}

/**
 * Executes a DAG agent step.
 */
async function executeDagAgentStep(
  job: QueueJob<DagStepJobData>,
  prompt: string,
  agentDef: { tools?: string[]; skills?: string[] },
  tmplCtx: TemplateContext,
  deps: DagStepWorkerDeps,
): Promise<string> {
  const { resolved, warnings } = await resolveTemplates(prompt, tmplCtx);
  for (const w of warnings) await job.log(`Template warning: ${w}`);
  if (warnings.length > 0) {
    throw new Error(warnings[0]);
  }

  const skills = agentDef.skills;
  const systemPrompt = buildDagStepSystemPrompt(skills, deps);

  // Resolve tool names
  const tools: string[] = agentDef.tools ? [...agentDef.tools] : [];
  if (skills && skills.length > 0 && !tools.includes("exec")) {
    tools.unshift("exec");
  }

  // Validate tools availability
  const availableTools = new Set([...deps.ctx.tools.names(), ...SANDBOX_TOOL_NAMES]);
  const missingTools = tools.filter((t) => !availableTools.has(t));
  if (missingTools.length > 0) {
    throw new Error(`Unavailable tools: ${missingTools.join(", ")}`);
  }

  // Validate skills availability
  if (skills && skills.length > 0) {
    const availableSkills = new Set(deps.ctx.skills.names());
    const missingSkills = skills.filter((s) => !availableSkills.has(s));
    if (missingSkills.length > 0) {
      throw new Error(`Unavailable skills: ${missingSkills.join(", ")}`);
    }
  }

  // Append prompt to session
  deps.ctx.sessions.append(job.data.sessionId, {
    role: "user",
    content: resolved,
    timestamp: Date.now(),
  });

  const result = await deps.ctx.agent.run(job, {
    systemPrompt,
    tools,
    skills,
    thinkingLevel: "low",
    sessionId: job.data.sessionId,
    onAgentEvent: (event) => deps.emitEvent(event, job.id, job.data),
  });

  return result.answer;
}
