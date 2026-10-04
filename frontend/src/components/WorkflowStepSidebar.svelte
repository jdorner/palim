<script lang="ts">
import ArrowsOutSimpleIcon from "phosphor-svelte/lib/ArrowsOutSimpleIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import WarningIcon from "phosphor-svelte/lib/WarningIcon";
import { builtinConfigSchema } from "$lib/builtinStepSchemas";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Dialog } from "$lib/components/ui/dialog";
import type { OutputSchemas } from "$lib/templateScope";
import type { StepDraft, WorkflowDraft } from "$lib/workflowValidation";
import { edgesToSlugEdges, validateStepConfig } from "$lib/workflowValidation";
import ChatMarkdown from "./ChatMarkdown.svelte";
import ConditionForm from "./ConditionForm.svelte";
import MultiSelect from "./MultiSelect.svelte";
import StepConfigForm from "./StepConfigForm.svelte";
import StepPanelHeader from "./StepPanelHeader.svelte";
import TemplateAutocomplete from "./TemplateAutocomplete.svelte";

interface StepTypeInfo {
  type: string;
  label: string;
  icon?: string;
  configSchema?: Record<string, unknown>;
}

interface StepDef {
  /** Stable synthetic node id (matches the parent's StepDef), used for removal. */
  id: string;
  slug: string;
  type: string;
  prompt?: string;
  tools?: string[];
  skills?: string[];
  url?: string;
  method?: string;
  body?: string;
  input?: string;
  output?: string;
}

interface Props {
  /** The step currently displayed (source-of-truth in view mode). */
  selectedStep: StepDef;
  /** Index of the selected step. */
  selectedStepIndex: number;
  /** Whether the page is in edit mode. */
  editMode: boolean;
  /** The draft step being edited (derived from editDraft). */
  editDraftStep: StepDraft | null;
  /** Full edit draft (needed for step count check, step list for autocomplete). */
  editDraft: WorkflowDraft | null;
  /** Whether to show JSON editor in edit mode for custom steps. */
  editAsJson: boolean;
  /** Whether to show JSON view in read-only mode for custom steps. */
  viewAsJson: boolean;
  /** Validation errors map. */
  validationErrors: Map<string, string>;
  /** Available tools for multi-select. */
  availableTools: string[];
  /** Available skills for multi-select. */
  availableSkills: string[];
  /** Whether meta (tools/skills) is loading. */
  metaLoading: boolean;
  /** Cached secret keys for template autocomplete. */
  cachedSecretKeys: string[];
  /** Cached variable keys for template autocomplete. */
  cachedVariableKeys: string[];
  /** Custom step types from extensions. */
  customStepTypes: StepTypeInfo[];
  /** Output schemas for template autocomplete. */
  outputSchemas?: OutputSchemas;
  /** Callback to close the sidebar. */
  onclose: () => void;
  /** Callback when slug input changes. */
  onSlugInput: (index: number, value: string) => void;
  /** Callback to remove a step, identified by its stable synthetic node id. */
  onRemoveStep: (id: string) => void;
  /** Callback to update a draft step field. */
  onUpdateDraftStep: (index: number, updater: (step: StepDraft) => void) => void;
  /** Callback to change validation errors. */
  onValidationErrorsChange: (errors: Map<string, string>) => void;
  /** Callback to toggle editAsJson. */
  onEditAsJsonChange: (value: boolean) => void;
  /** Callback to toggle viewAsJson. */
  onViewAsJsonChange: (value: boolean) => void;
}

let {
  selectedStep,
  selectedStepIndex,
  editMode,
  editDraftStep,
  editDraft,
  editAsJson,
  viewAsJson,
  validationErrors,
  availableTools,
  availableSkills,
  metaLoading,
  cachedSecretKeys,
  cachedVariableKeys,
  customStepTypes,
  outputSchemas,
  onclose,
  onSlugInput,
  onRemoveStep,
  onUpdateDraftStep,
  onValidationErrorsChange,
  onEditAsJsonChange,
  onViewAsJsonChange,
}: Props = $props();

/**
 * Built-in control-flow step types. Their config lives in flat fields on the
 * step (not under `config`) and is edited against a built-in schema.
 */
const CF_TYPES = new Set(["if", "case", "iterator", "aggregator", "waitFor", "emit"]);

/** Type of the displayed step (draft wins in edit mode). The type is fixed once placed. */
let currentType = $derived(editDraftStep?.type ?? selectedStep.type);

/**
 * Whether the step has a form view to toggle against JSON. Agent steps have a
 * dedicated form and no JSON view; custom types without a config schema are
 * JSON-only.
 */
let hasForm = $derived.by(() => {
  if (currentType === "agent") return false;
  if (CF_TYPES.has(currentType)) return currentType === "if" || builtinConfigSchema(currentType) !== undefined;
  return customStepTypes.some((st) => st.type === currentType && st.configSchema);
});

/** Whether the JSON view is active for the current mode. */
let jsonActive = $derived(hasForm && (editMode ? editAsJson : viewAsJson));

// Edges in slug space for template autocomplete precedence. The editor tracks
// edges by synthetic id, but the preceding-step rule works in slug space, so
// convert the draft's id-based edges here before passing them to children.
let slugEdges = $derived(editDraft ? edgesToSlugEdges(editDraft.steps, editDraft.edges) : []);

// Element references for template autocomplete
let promptEl = $state<HTMLTextAreaElement | null>(null);
let expandedPromptEl = $state<HTMLTextAreaElement | null>(null);

/** Whether the agent prompt is open in the large editor dialog. */
let promptExpanded = $state(false);

// Close the large prompt editor when the panel switches to another step.
$effect(() => {
  selectedStepIndex;
  promptExpanded = false;
});

/** Write the agent prompt to the draft and clear its validation error. */
function setPrompt(value: string) {
  onUpdateDraftStep(selectedStepIndex, (s) => {
    s.prompt = value;
  });
  const key = `steps[${selectedStepIndex}].prompt`;
  if (!validationErrors.has(key)) return;
  const newErrors = new Map(validationErrors);
  newErrors.delete(key);
  onValidationErrorsChange(newErrors);
}

/** Svelte action that portals the element to document.body. */
function portal(node: HTMLElement) {
  document.body.appendChild(node);
  return {
    destroy() {
      node.remove();
    },
  };
}

/**
 * Extracts the editable config from a CF step (everything except slug and type).
 */
function cfStepConfig(step: StepDraft): Record<string, unknown> {
  const { slug: _s, type: _t, id: _i, ...rest } = step;
  return rest as Record<string, unknown>;
}

/**
 * Applies form values back onto a built-in control-flow step. Built-in CF types
 * store their config as flat fields on the step (e.g. `step.event`), so this
 * removes any previous config fields (all keys except slug/type/id) and copies
 * the provided values in their place.
 */
function applyCfValues(index: number, values: Record<string, unknown>) {
  onUpdateDraftStep(index, (s) => {
    for (const key of Object.keys(s)) {
      if (key !== "slug" && key !== "type" && key !== "id") delete s[key];
    }
    for (const [k, v] of Object.entries(values)) {
      // Skip empty optional values the form renderer synthesizes (e.g. an unset
      // numeric `timeout` becomes 0, empty strings, empty arrays/objects). These
      // would otherwise be persisted and fail backend range/pattern validation.
      if (v === "" || v === null || v === undefined) continue;
      if (typeof v === "number" && v === 0) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
      s[k] = v;
    }
  });
}

/**
 * Re-runs schema validation for a built-in CF step against its config schema and
 * updates the shared validation error map (keyed by `steps[i].<field>`).
 */
function revalidateCf(index: number, values: Record<string, unknown>, schema: Record<string, unknown>) {
  const prefix = `steps[${index}].`;
  const newErrors = new Map(validationErrors);
  // Clear prior field-level errors for this step (built-in CF validators key on
  // `steps[i].event`, `steps[i].match`, `steps[i].condition`, plus schema fields).
  const props = (schema.properties ?? {}) as Record<string, unknown>;
  for (const field of ["event", "match", "condition", "config", ...Object.keys(props)]) {
    newErrors.delete(`${prefix}${field}`);
  }
  // Validate against the effective (empty-stripped) config so synthesized empty
  // optionals (e.g. `timeout: 0`) don't produce spurious range errors.
  const effective: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === "" || v === null || v === undefined) continue;
    if (typeof v === "number" && v === 0) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
    effective[k] = v;
  }
  const configErrors = validateStepConfig(effective, schema);
  for (const [field, msg] of configErrors) {
    newErrors.set(`${prefix}${field}`, msg);
  }
  onValidationErrorsChange(newErrors);
}

/** Clears the `steps[i].condition` validation error (used by the if ConditionForm). */
function clearConditionError(index: number) {
  const key = `steps[${index}].condition`;
  if (!validationErrors.has(key)) return;
  const newErrors = new Map(validationErrors);
  newErrors.delete(key);
  onValidationErrorsChange(newErrors);
}
</script>

<div class="w-95 h-full flex flex-col">
  <StepPanelHeader
    type={currentType}
    subtitle={editMode ? undefined : selectedStep.slug}
    jsonView={jsonActive}
    onToggleJson={hasForm
      ? () => (editMode ? onEditAsJsonChange(!editAsJson) : onViewAsJsonChange(!viewAsJson))
      : undefined}
    {onclose}
  />

  {#if editMode}
    <!-- Same reserved scrollbar gutter as the scroll area below, so the slug input
         lines up with the form fields. -->
    <div
      class="px-4 pt-4 pb-3 flex flex-col gap-2 shrink-0 border-b border-border overflow-hidden [scrollbar-gutter:stable]"
    >
      {#if validationErrors.get("steps.removeWarning")}
        <div class="warning-banner">
          <WarningIcon size={12} class="shrink-0" aria-hidden="true" />
          <span class="text-xs">{validationErrors.get("steps.removeWarning")}</span>
        </div>
      {/if}
      <div class="flex flex-col gap-1">
        <label for="step-slug" class="text-xs font-medium text-muted-foreground"
          >Slug <span class="text-destructive">*</span></label
        >
        <input
          id="step-slug"
          type="text"
          class="w-full px-2 py-1.5 text-xs font-mono border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          value={editDraftStep?.slug ?? selectedStep.slug}
          maxlength={64}
          oninput={(e) => onSlugInput(selectedStepIndex, (e.target as HTMLInputElement).value)}
          placeholder="step-slug"
        >
        {#if validationErrors.get(`steps[${selectedStepIndex}].slug`)}
          <span class="text-xs text-destructive">{validationErrors.get(`steps[${selectedStepIndex}].slug`)}</span>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Sidebar content -->
  <div class="flex-1 overflow-y-auto min-h-0 p-4 flex flex-col [scrollbar-gutter:stable]">
    {#if editMode && editDraftStep && (editDraftStep.type ?? selectedStep?.type) === "agent"}
      <!-- Edit mode: agent step. Fills the panel height (flex-1, not h-full, so
           the scroll area's padding is not added on top); the prompt textarea
           takes the remaining space and never shrinks below its minimum. -->
      <div class="flex flex-col gap-4 flex-1">
        <div class="flex flex-col gap-1.5 shrink-0">
          <span class="text-xs font-medium text-muted-foreground">Tools</span>
          <MultiSelect
            size="xs"
            items={availableTools}
            selected={editDraftStep.tools ?? []}
            placeholder="Search tools..."
            disabled={metaLoading || availableTools.length === 0}
            onchange={(newSelected) =>
              onUpdateDraftStep(selectedStepIndex, (s) => {
                s.tools = newSelected;
              })}
          />
        </div>

        <div class="flex flex-col gap-1.5 shrink-0">
          <span class="text-xs font-medium text-muted-foreground">Skills</span>
          <MultiSelect
            size="xs"
            items={availableSkills}
            selected={editDraftStep.skills ?? []}
            placeholder="Search skills..."
            disabled={metaLoading || availableSkills.length === 0}
            onchange={(newSelected) =>
              onUpdateDraftStep(selectedStepIndex, (s) => {
                s.skills = newSelected;
              })}
          />
        </div>

        <div class="flex flex-col gap-1.5 flex-1">
          <div class="flex items-center justify-between shrink-0">
            <label for="step-prompt" class="text-xs font-medium text-muted-foreground">Prompt</label>
            <div class="flex items-center gap-1.5">
              <span class="text-xs text-muted-foreground">{(editDraftStep.prompt ?? "").length}/ 10000</span>
              <button
                type="button"
                class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                onclick={() => (promptExpanded = true)}
                aria-label="Expand prompt editor"
                title="Expand"
              >
                <ArrowsOutSimpleIcon size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
          <textarea
            id="step-prompt"
            bind:this={promptEl}
            class="w-full flex-1 min-h-20 px-2 py-1.5 text-xs font-mono border border-border rounded-md bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring"
            maxlength={10000}
            value={editDraftStep.prompt ?? ""}
            oninput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
            placeholder="Enter step prompt..."
          ></textarea>
          {#if validationErrors.get(`steps[${selectedStepIndex}].prompt`)}
            <span class="text-xs text-destructive shrink-0"
              >{validationErrors.get(`steps[${selectedStepIndex}].prompt`)}</span
            >
          {/if}
          <TemplateAutocomplete
            targetElement={promptEl}
            steps={editDraft?.steps ?? []}
            currentStepIndex={selectedStepIndex}
            secretKeys={cachedSecretKeys}
            variableKeys={cachedVariableKeys}
            {outputSchemas}
            edges={slugEdges}
            onChange={setPrompt}
          />
        </div>
      </div>

      {#if promptExpanded}
        <!-- Portaled so the fixed overlay escapes the floating panel (which can
             sit inside the graph's transformed viewport). Escape is marked as
             handled so the page does not also close the panel or leave edit mode. -->
        <div
          use:portal
          role="presentation"
          onkeydown={(e) => {
            if (e.key === "Escape") e.preventDefault();
          }}
        >
          <Dialog
            open
            title="Prompt"
            description={editDraftStep.slug}
            class="max-w-4xl"
            onClose={() => (promptExpanded = false)}
          >
            <!-- Single child of the dialog body: its space-y spacing would otherwise
                 add a margin under the textarea while the autocomplete popup is open. -->
            <div>
              <textarea
                bind:this={expandedPromptEl}
                aria-label="Prompt"
                class="block w-full h-[60vh] px-3 py-2 text-sm font-mono border border-border rounded-md bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                maxlength={10000}
                value={editDraftStep.prompt ?? ""}
                oninput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
                placeholder="Enter step prompt..."
              ></textarea>
              <TemplateAutocomplete
                targetElement={expandedPromptEl}
                steps={editDraft?.steps ?? []}
                currentStepIndex={selectedStepIndex}
                secretKeys={cachedSecretKeys}
                variableKeys={cachedVariableKeys}
                {outputSchemas}
                edges={slugEdges}
                onChange={setPrompt}
              />
            </div>
            {#snippet footer()}
              <span class="mr-auto self-center text-xs text-muted-foreground"
                >{(editDraftStep.prompt ?? "").length}/ 10000</span
              >
              <Button size="sm" onclick={() => (promptExpanded = false)}>Done</Button>
            {/snippet}
          </Dialog>
        </div>
      {/if}
    {:else if !editMode && selectedStep?.type === "agent" && selectedStep.prompt}
      <div class="space-y-3">
        <div class="flex items-center gap-1.5 flex-wrap">
          <span class="text-xs font-medium text-muted-foreground">Tools:</span>
          {#if selectedStep.tools?.length}
            {#each selectedStep.tools as tool}
              <Badge variant="outline" class="text-xs">{tool}</Badge>
            {/each}
          {:else}
            <Badge variant="outline" class="text-xs">none</Badge>
          {/if}
        </div>

        <div class="flex items-center gap-1.5 flex-wrap">
          <span class="text-xs font-medium text-muted-foreground">Skills:</span>
          {#if selectedStep.skills?.length}
            {#each selectedStep.skills as skill}
              <Badge variant="outline" class="text-xs">{skill}</Badge>
            {/each}
          {:else}
            <Badge variant="outline" class="text-xs">none</Badge>
          {/if}
        </div>

        <div>
          <span class="text-xs font-medium text-muted-foreground">Prompt:</span>
          <div class="text-xs whitespace-pre-wrap wrap-break-word bg-muted p-3 rounded mt-1">
            <ChatMarkdown content={selectedStep.prompt} />
          </div>
        </div>
      </div>
    {:else if editMode && editDraftStep && (editDraftStep.type ?? selectedStep?.type) !== "agent"}
      <!-- Edit mode: control flow or custom step type -->
      {@const stepType = editDraftStep.type ?? selectedStep?.type}
      {@const isCFStep = CF_TYPES.has(stepType)}
      {#if isCFStep}
        <!-- Built-in control-flow step: form-based config with a JSON fallback -->
        {@const cfSchema = builtinConfigSchema(stepType)}
        <div class="flex flex-col flex-1 min-h-0 gap-4">
          {#if !editAsJson && stepType === "if"}
            <!-- `if`: dedicated condition form (nested ref + operator) -->
            <ConditionForm
              condition={(editDraftStep.condition as Record<string, unknown>) ?? { ref: "" }}
              refError={validationErrors.get(`steps[${selectedStepIndex}].condition`)}
              steps={editDraft?.steps ?? []}
              currentStepIndex={selectedStepIndex}
              secretKeys={cachedSecretKeys}
              variableKeys={cachedVariableKeys}
              {outputSchemas}
              edges={slugEdges}
              onchange={(cond) => {
                onUpdateDraftStep(selectedStepIndex, (s) => {
                  s.condition = cond;
                });
                clearConditionError(selectedStepIndex);
              }}
            />

            <!-- Optional branch edge label overrides. Display-only: the branch
                 routing keys stay "then"/"else"; these just relabel the edges. -->
            {@const bl = (editDraftStep.branchLabels as { then?: string; else?: string } | undefined) ?? {}}
            <div class="flex flex-col gap-3">
              <span class="text-xs font-medium text-muted-foreground">Branch edge labels (optional)</span>
              <div class="flex flex-col gap-1">
                <label for="if-then-label" class="text-[11px] text-muted-foreground">Then edge label</label>
                <input
                  id="if-then-label"
                  type="text"
                  class="px-2 py-1 text-xs border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                  maxlength={64}
                  value={bl.then ?? ""}
                  placeholder="then"
                  oninput={(e) => {
                    const v = (e.target as HTMLInputElement).value;
                    onUpdateDraftStep(selectedStepIndex, (s) => {
                      const next = { ...(s.branchLabels ?? {}) };
                      // biome-ignore lint/suspicious/noThenProperty: "then" is the workflow branch keyword, not a thenable
                      next.then = v;
                      s.branchLabels = next;
                    });
                  }}
                >
              </div>
              <div class="flex flex-col gap-1">
                <label for="if-else-label" class="text-[11px] text-muted-foreground">Else edge label</label>
                <input
                  id="if-else-label"
                  type="text"
                  class="px-2 py-1 text-xs border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                  maxlength={64}
                  value={bl.else ?? ""}
                  placeholder="else"
                  oninput={(e) => {
                    const v = (e.target as HTMLInputElement).value;
                    onUpdateDraftStep(selectedStepIndex, (s) => {
                      const next = { ...(s.branchLabels ?? {}) };
                      next.else = v;
                      s.branchLabels = next;
                    });
                  }}
                >
              </div>
            </div>
          {:else if !editAsJson && cfSchema}
            <!-- `waitFor` / `emit` / `case`: schema-driven form on flat fields -->
            <StepConfigForm
              schema={cfSchema}
              values={cfStepConfig(editDraftStep)}
              onchange={(vals) => {
                applyCfValues(selectedStepIndex, vals);
                revalidateCf(selectedStepIndex, vals, cfSchema);
              }}
              steps={editDraft?.steps ?? []}
              currentStepIndex={selectedStepIndex}
              secretKeys={cachedSecretKeys}
              variableKeys={cachedVariableKeys}
              {outputSchemas}
              edges={slugEdges}
              fieldErrors={(() => {
                const prefix = `steps[${selectedStepIndex}].`;
                const m = new Map<string, string>();
                for (const [k, v] of validationErrors) {
                  if (k.startsWith(prefix)) {
                    const field = k.slice(prefix.length);
                    if (!field.includes(".")) m.set(field, v);
                  }
                }
                return m;
              })()}
            />
          {:else}
            <!-- JSON fallback: all fields except slug/type -->
            <div class="flex flex-col gap-1.5 flex-1 min-h-0">
              <div class="flex items-center justify-between">
                <label for="step-cf-config" class="text-xs font-medium text-muted-foreground"
                  >Configuration (JSON)</label
                >
              </div>
              <textarea
                id="step-cf-config"
                class="w-full flex-1 px-2 py-1.5 text-xs font-mono border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                value={JSON.stringify(cfStepConfig(editDraftStep), null, 2)}
                oninput={(e) => {
                  const raw = (e.target as HTMLTextAreaElement).value;
                  try {
                    const parsed = JSON.parse(raw);
                    applyCfValues(selectedStepIndex, parsed);
                  } catch {
                    // Invalid JSON - ignore until valid
                  }
                }}
              ></textarea>
            </div>
          {/if}
        </div>
      {:else}
        <!-- Custom step type - schema-driven form or JSON fallback -->
        {@const stepTypeInfo = customStepTypes.find((st) => st.type === stepType)}
        <div class="flex flex-col flex-1 min-h-0 gap-4">
          {#if stepTypeInfo?.configSchema && !editAsJson}
            <StepConfigForm
              schema={stepTypeInfo.configSchema}
              values={editDraftStep.config ?? {}}
              onchange={(vals) => {
                onUpdateDraftStep(selectedStepIndex, (s) => {
                  s.config = vals;
                });
                // Live validation: re-check config against schema and update errors
                const prefix = `steps[${selectedStepIndex}].config.`;
                const newErrors = new Map(validationErrors);
                // Remove old config errors for this step
                for (const k of [...newErrors.keys()]) {
                  if (k.startsWith(prefix)) newErrors.delete(k);
                }
                // Run validation and add fresh errors
                const configErrors = validateStepConfig(vals ?? {}, stepTypeInfo.configSchema!);
                for (const [field, msg] of configErrors) {
                  newErrors.set(`${prefix}${field}`, msg);
                }
                onValidationErrorsChange(newErrors);
              }}
              steps={editDraft?.steps ?? []}
              currentStepIndex={selectedStepIndex}
              secretKeys={cachedSecretKeys}
              variableKeys={cachedVariableKeys}
              {outputSchemas}
              edges={slugEdges}
              itemOptions={{ skills: availableSkills }}
              fieldErrors={(() => {
                const prefix = `steps[${selectedStepIndex}].config.`;
                const m = new Map<string, string>();
                for (const [k, v] of validationErrors) {
                  if (k.startsWith(prefix)) m.set(k.slice(prefix.length), v);
                }
                return m;
              })()}
            />
          {:else}
            <div class="flex flex-col gap-1.5 flex-1 min-h-0">
              <div class="flex items-center justify-between">
                <label for="step-config" class="text-xs font-medium text-muted-foreground">Configuration (JSON)</label>
              </div>
              <textarea
                id="step-config"
                class="w-full flex-1 px-2 py-1.5 text-xs font-mono border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                value={JSON.stringify(editDraftStep.config ?? {}, null, 2)}
                oninput={(e) => {
                  const raw = (e.target as HTMLTextAreaElement).value;
                  try {
                    const parsed = JSON.parse(raw);
                    onUpdateDraftStep(selectedStepIndex, (s) => {
                      s.config = parsed;
                    });
                    const newErrors = new Map(validationErrors);
                    newErrors.delete(`steps[${selectedStepIndex}].config`);
                    // Live schema validation for JSON editor
                    const prefix = `steps[${selectedStepIndex}].config.`;
                    for (const k of [...newErrors.keys()]) {
                      if (k.startsWith(prefix)) newErrors.delete(k);
                    }
                    if (stepTypeInfo?.configSchema) {
                      const configErrors = validateStepConfig(parsed, stepTypeInfo.configSchema);
                      for (const [field, msg] of configErrors) {
                        newErrors.set(`${prefix}${field}`, msg);
                      }
                    }
                    onValidationErrorsChange(newErrors);
                  } catch {
                    const newErrors = new Map(validationErrors);
                    newErrors.set(`steps[${selectedStepIndex}].config`, "Invalid JSON");
                    onValidationErrorsChange(newErrors);
                  }
                }}
              ></textarea>
              {#if validationErrors.get(`steps[${selectedStepIndex}].config`)}
                <span class="text-xs text-destructive"
                  >{validationErrors.get(`steps[${selectedStepIndex}].config`)}</span
                >
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    {:else if !editMode &&
      (selectedStep.type === "if" ||
        selectedStep.type === "case" ||
        selectedStep.type === "waitFor" ||
        selectedStep.type === "emit" ||
        selectedStep.type === "iterator" ||
        selectedStep.type === "aggregator")}
      <!-- Read-only: built-in control-flow step config -->
      {@const roCfType = selectedStep.type}
      {@const roCfSchema = builtinConfigSchema(roCfType)}
      {#if viewAsJson}
        <div class="flex flex-col gap-1.5 flex-1 min-h-0">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-muted-foreground">Configuration (JSON)</span>
          </div>
          <pre
            class="text-xs font-mono whitespace-pre-wrap wrap-break-word bg-muted p-3 rounded flex-1 overflow-y-auto"
          >{JSON.stringify(cfStepConfig(selectedStep as unknown as StepDraft), null, 2)}</pre>
        </div>
      {:else if roCfType === "if"}
        <ConditionForm
          condition={((selectedStep as unknown as StepDraft).condition as Record<string, unknown>) ?? { ref: "" }}
          readonly={true}
        />
        {@const roBl = (selectedStep as unknown as StepDraft).branchLabels as
          | { then?: string; else?: string }
          | undefined}
        {#if roBl && (roBl.then || roBl.else)}
          <div class="flex flex-col gap-1.5 mt-3">
            <span class="text-xs font-medium text-muted-foreground">Branch edge labels</span>
            <div class="flex items-center gap-2">
              <span class="text-[11px] text-muted-foreground w-10">then:</span>
              <Badge variant="outline" class="text-xs">{roBl.then || "then"}</Badge>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-[11px] text-muted-foreground w-10">else:</span>
              <Badge variant="outline" class="text-xs">{roBl.else || "else"}</Badge>
            </div>
          </div>
        {/if}
      {:else if roCfSchema}
        <StepConfigForm
          schema={roCfSchema}
          values={cfStepConfig(selectedStep as unknown as StepDraft)}
          readonly={true}
        />
      {/if}
    {:else if !editMode && selectedStep.type !== "agent"}
      <!-- Read-only: custom step type config -->
      {@const roStepType = selectedStep.type}
      {@const roStepTypeInfo = customStepTypes.find((st) => st.type === roStepType)}
      {#if viewAsJson}
        <div class="flex flex-col gap-1.5 flex-1 min-h-0">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-muted-foreground">Configuration (JSON)</span>
          </div>
          <pre
            class="text-xs font-mono whitespace-pre-wrap wrap-break-word bg-muted p-3 rounded flex-1 overflow-y-auto"
          >{JSON.stringify(selectedStep, null, 2)}</pre>
        </div>
      {:else if roStepTypeInfo?.configSchema}
        {@const roConfig = (() => {
          const { slug: _s, type: _t, ...rest } = selectedStep;
          return rest;
        })()}
        <StepConfigForm
          schema={roStepTypeInfo.configSchema}
          values={roConfig}
          readonly={true}
          itemOptions={{ skills: availableSkills }}
        />
      {:else}
        <div class="space-y-3">
          <div>
            <span class="text-xs font-medium text-muted-foreground">Configuration</span>
            <pre
              class="text-xs font-mono whitespace-pre-wrap wrap-break-word bg-muted p-3 rounded max-h-64 overflow-y-auto mt-0.5"
            >{JSON.stringify(
  (() => {
    const { slug: _s, type: _t, ...rest } = selectedStep;
    return rest;
  })(),
  null,
  2,
)}</pre>
          </div>
        </div>
      {/if}
    {:else}
      <p class="text-sm text-muted-foreground">No details available for this step type.</p>
    {/if}
  </div>

  {#if editMode}
    <div class="shrink-0 flex items-center justify-end gap-2 border-t border-border px-4 py-2">
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
        disabled={!editDraft || editDraft.steps.length <= 1}
        onclick={() => {
          onRemoveStep(editDraftStep?.id ?? selectedStep.id);
          onclose();
        }}
        title={!editDraft || editDraft.steps.length <= 1
          ? "At least one step is required"
          : `Remove step ${editDraftStep?.slug || "(unnamed)"}`}
      >
        <TrashIcon size={14} aria-hidden="true" />
        Remove step
      </button>
    </div>
  {/if}
</div>
