/**
 * Workflow step worker - processes step jobs on the `workflows:steps` queue.
 *
 * Routes execution by step type: agent steps use {@link ExtensionContext.runAgent},
 * and all other step types are dispatched to registered {@link StepTypeHandler}s.
 *
 * Each step's result is wrapped in a {@link StepResult} that carries
 * accumulated results from all previous steps, enabling `{{steps.<slug>.result}}`
 * template resolution for any earlier step in the chain.
 */

import type {
  ExtensionContext,
  Logger,
  QueueJob,
  StepExecutionContext,
  StepInputValidation,
  StepTypeHandler,
} from "@ext/types";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { Value } from "@sinclair/typebox/value";
import { SANDBOX_TOOL_NAMES } from "@src/tools/file";
import { formatValidationErrors } from "@src/utils/validation";
import type { FlowProducer } from "bunqueue/client";
import { normalizePrompt } from "./schemas";
import type { TemplateContext, TemplateSecretResolver } from "./template";
import { resolveTemplates } from "./template";
import type { WorkflowStepJobData } from "./types";

/** Dependencies injected into the step worker at creation time. */
export interface StepWorkerDeps {
  /** The extension context for running agents and OCR. */
  ctx: ExtensionContext;
  /** The shared FlowProducer for reading parent results. */
  flowProducer: FlowProducer;
  /** Emits an agent event onto the shared event bus. */
  emitEvent: (event: AgentEvent, jobId: string, jobData: WorkflowStepJobData) => void;
  /** Logger instance. */
  log: Logger;
  /**
   * Looks up a registered custom step type handler by type name.
   * Returns `undefined` if no handler is registered for the given type.
   */
  getStepHandler?: (type: string) => StepTypeHandler | undefined;
}

/** Wrapper around a step's output that carries accumulated context. */
export interface StepResult {
  /** This step's own output value. */
  value: unknown;
  /** Accumulated results from all steps so far, keyed by slug. */
  _stepResults: Record<string, unknown>;
  /** The original trigger payload, propagated through the entire chain. */
  _triggerPayload?: unknown;
}

/**
 * Formats resolved skill entries into the `<available_skills>` XML block
 * used by agent system prompts.
 *
 * @param skills - Skill names to include
 * @param deps - Worker dependencies (for skill resolution via ctx)
 * @returns XML string with skill metadata, or empty string if no skills resolve
 */
function buildSkillsContext(skills: string[], deps: StepWorkerDeps): string {
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
 * Builds the system prompt for a workflow agent step.
 *
 * When skills are specified, includes the full skill context XML block
 * (same structure as the core agent system prompt). Falls back to a
 * minimal prompt when no skills are configured.
 *
 * @param skills - Skill names from the step definition (may be undefined)
 * @param deps - Worker dependencies (for skill resolution via ctx)
 * @returns The assembled system prompt string
 */
function buildStepSystemPrompt(skills: string[] | undefined, deps: StepWorkerDeps): string {
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
 * Build the template context for a step by reading accumulated
 * results from the parent's {@link StepResult}.
 *
 * @param job - The current step job
 * @param deps - Worker dependencies (FlowProducer for parent result access)
 * @returns Template context with trigger payload and all previous step results
 */
async function buildTemplateContext(
  job: QueueJob<WorkflowStepJobData>,
  deps: StepWorkerDeps,
): Promise<TemplateContext> {
  const data = job.data;
  let stepResults: Record<string, unknown> = {};
  let triggerPayload: unknown = data.triggerPayload;

  if (data.__flowParentId) {
    const parentResult = await deps.flowProducer.getParentResult<StepResult>(data.__flowParentId);
    if (parentResult?._stepResults) {
      stepResults = { ...parentResult._stepResults };
    }
    if (triggerPayload === undefined && parentResult?._triggerPayload !== undefined) {
      triggerPayload = parentResult._triggerPayload;
    }
  }

  // Build a secret resolver that uses SecretVault with the workflow's
  // consumer identity (workflow:{name}) for proper ACL enforcement.
  const workflowName = data.workflowName;
  const secretStore: TemplateSecretResolver = {
    async resolve(name: string, consumer: string) {
      // Use internal.secrets.resolveAs when available (SecretVault-backed) to search across
      // all scopes with the correct workflow consumer identity.
      if (deps.ctx.internal?.secrets) {
        const value = await deps.ctx.internal.secrets.resolveAs(name, consumer);
        return { value, granted: value !== null, reason: value === null ? "denied or not found" : undefined };
      }
      // Vault unavailable: log warning and return empty string per requirement 8.6
      deps.log.warn(`Secret "${name}" cannot be resolved: vault is not configured`);
      return { value: "", granted: true };
    },
  };

  return { triggerPayload, stepResults, stepConfigs: data.allStepDefs, workflowName, secretStore };
}

/**
 * Execute an agent step - resolves templates in the prompt and runs the agent
 * via {@link ExtensionContext.runAgent}.
 *
 * Builds a full system prompt with skill context when skills are configured,
 * and ensures the tool list includes extension tools when no explicit tools
 * are specified in the step definition.
 *
 * @param job - The step job
 * @param prompt - The raw prompt template from the step definition
 * @param tmplCtx - Resolved template context
 * @param deps - Worker dependencies
 * @returns The agent's response text
 */
async function executeAgentStep(
  job: QueueJob<WorkflowStepJobData>,
  prompt: string,
  tmplCtx: TemplateContext,
  deps: StepWorkerDeps,
): Promise<string> {
  const { resolved, warnings } = await resolveTemplates(prompt, tmplCtx);
  for (const w of warnings) await job.log(`⚠ Template: ${w}`);
  if (warnings.length > 0) {
    throw new Error(warnings[0]);
  }

  const stepDef = job.data.stepDef;
  const agentDef = stepDef as import("./schemas").AgentStep;
  const skills = agentDef.skills;
  const systemPrompt = buildStepSystemPrompt(skills, deps);

  // Resolve tool names: use explicit tools from the step definition.
  // When none are specified, the step runs with no tools (LLM-only).
  // When skills are present, ensure "exec" is included so the agent can read them.
  let tools: string[] | undefined;
  if (agentDef.tools) {
    tools = [...agentDef.tools];
  } else {
    tools = [];
  }

  if (skills && skills.length > 0 && !tools.includes("exec")) {
    tools.unshift("exec");
  }

  // Validate that all referenced tools and skills are currently available.
  // Throws immediately so the step (and workflow) ends up in a failed state
  // with a clear error message rather than silently skipping missing capabilities.
  const availableTools = new Set([...deps.ctx.tools.names(), ...SANDBOX_TOOL_NAMES]);
  const missingTools = tools.filter((t) => !availableTools.has(t));
  if (missingTools.length > 0) {
    throw new Error(`Unavailable tools: ${missingTools.join(", ")}`);
  }

  if (skills && skills.length > 0) {
    const availableSkills = new Set(deps.ctx.skills.names());
    const missingSkills = skills.filter((s) => !availableSkills.has(s));
    if (missingSkills.length > 0) {
      throw new Error(`Unavailable skills: ${missingSkills.join(", ")}`);
    }
  }

  // Append the prompt to the session so the agent processor picks it up
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

/** Maximum number of repair attempts when input validation fails. */
const MAX_VALIDATION_RETRIES = 2;

/**
 * Runs the next step's input validation against the current step's output.
 *
 * If the next step's handler provides a `validateInput` method, that is called.
 * Otherwise, if `inputSchema` is defined, TypeBox `Value.Check` / `Value.Errors`
 * is used for structural validation.
 *
 * @param output - The current step's output value
 * @param nextStepDef - The next step's definition object
 * @param handler - The next step's registered handler
 * @returns Validation result, or `{ valid: true }` if no validation is configured
 */
async function runInputValidation(
  output: unknown,
  nextStepDef: Record<string, unknown>,
  handler: StepTypeHandler,
): Promise<StepInputValidation> {
  // Prefer explicit validateInput method (domain-specific checks)
  if (handler.validateInput) {
    return handler.validateInput(output, nextStepDef);
  }

  // Fall back to TypeBox inputSchema validation
  if (handler.inputSchema) {
    if (Value.Check(handler.inputSchema, output)) {
      return { valid: true };
    }
    const diagnostics = formatValidationErrors(handler.inputSchema, output, "\n")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    return { valid: false, diagnostics };
  }

  // No validation configured — pass through
  return { valid: true };
}

/**
 * Creates the step processor function for the workflows queue.
 *
 * @param deps - Worker dependencies
 * @returns A job processor that handles agent and custom extension step types
 */
export function createStepProcessor(deps: StepWorkerDeps) {
  return async (job: QueueJob<WorkflowStepJobData>): Promise<StepResult> => {
    const { stepDef, stepSlug, stepIndex, totalSteps, workflowName } = job.data;

    await job.log(`[${workflowName}] Step ${stepIndex + 1}/${totalSteps}: ${stepSlug} (${stepDef.type})`);

    const tmplCtx = await buildTemplateContext(job, deps);
    let value: unknown;

    try {
      if (stepDef.type === "agent") {
        const agentStepDef = stepDef as import("./schemas").AgentStep;
        value = await executeAgentStep(job, normalizePrompt(agentStepDef.prompt), tmplCtx, deps);

        // --- Input validation for the next step (agent repair loop) ---
        const nextStepSlug = job.data.stepOrder?.[stepIndex + 1];
        const nextStepDef = nextStepSlug
          ? (job.data.allStepDefs?.[nextStepSlug] as Record<string, unknown> | undefined)
          : undefined;

        if (nextStepDef) {
          const nextType = nextStepDef.type as string | undefined;
          const nextHandler = nextType ? deps.getStepHandler?.(nextType) : undefined;

          if (nextHandler && (nextHandler.validateInput || nextHandler.inputSchema)) {
            let validation = await runInputValidation(value, nextStepDef, nextHandler);
            let attempt = 0;

            while (!validation.valid && attempt < MAX_VALIDATION_RETRIES) {
              attempt++;
              const diagnosticText =
                validation.diagnostics?.join("\n- ") ?? "Output does not match the expected format.";
              const repairPrompt = [
                "Your output does not conform to what the next workflow step expects.",
                "Please fix the following issues and respond with corrected output only:",
                "",
                `- ${diagnosticText}`,
              ].join("\n");

              await job.log(
                `Input validation failed (attempt ${attempt}/${MAX_VALIDATION_RETRIES}): ${diagnosticText}`,
              );
              value = await executeAgentStep(job, repairPrompt, tmplCtx, deps);
              validation = await runInputValidation(value, nextStepDef, nextHandler);
            }

            if (!validation.valid) {
              const finalDiagnostics = validation.diagnostics?.join("; ") ?? "Unknown validation error";
              const errMsg = `Input validation for next step "${nextStepSlug}" failed after ${MAX_VALIDATION_RETRIES} repair attempts: ${finalDiagnostics}`;
              await job.log(errMsg);
              throw new Error(errMsg);
            }
          }
        }
      } else {
        // Look up a registered custom step type handler
        const stepType = (stepDef as unknown as { type: string }).type;
        const handler = deps.getStepHandler?.(stepType);
        if (!handler) {
          const errMsg = `Step type "${stepType}" is not available. The extension providing this step type may be disabled or not installed.`;
          await job.log(errMsg);
          throw new Error(errMsg);
        }

        // Build a StepExecutionContext for the custom handler
        const stepExecCtx: StepExecutionContext = {
          resolveTemplate: (template: string) => resolveTemplates(template, tmplCtx),
          log: deps.log,
          workDir: deps.ctx.paths.work,
          jobLog: (message: string) => job.log(message),
          workflowRunId: job.data.workflowRunId,
        };

        value = await handler.execute(stepDef as unknown as Record<string, unknown>, stepExecCtx);
      }
    } catch (e) {
      // Agent steps already log errors via the runAgent catch block.
      // Only log here for non-agent step types to avoid duplicate entries.
      if (stepDef.type !== "agent") {
        await job.log(String(e));
      }
      throw e;
    }

    await job.log(`Step "${stepSlug}" completed`);

    const accumulated = { ...tmplCtx.stepResults, [stepSlug]: value };

    return { value, _stepResults: accumulated, _triggerPayload: tmplCtx.triggerPayload };
  };
}
