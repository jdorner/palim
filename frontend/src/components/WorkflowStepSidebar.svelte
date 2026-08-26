<script lang="ts">
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import WarningIcon from "phosphor-svelte/lib/WarningIcon";
import { builtinConfigSchema } from "$lib/builtinStepSchemas";
import { Badge } from "$lib/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger } from "$lib/components/ui/select";
import { visualForStepType } from "$lib/nodeVisuals";
import { categoryForType, iconIdForType, labelForStepType } from "$lib/stepTypes";
import type { OutputSchemas } from "$lib/templateScope";
import type { StepDraft, WorkflowDraft } from "$lib/workflowValidation";
import { validateStepConfig } from "$lib/workflowValidation";
import ChatMarkdown from "./ChatMarkdown.svelte";
import ConditionForm from "./ConditionForm.svelte";
import MultiSelect from "./MultiSelect.svelte";
import StepConfigForm from "./StepConfigForm.svelte";
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
  /** Callback to change step type. */
  onStepTypeChange: (index: number, type: string) => void;
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
  onStepTypeChange,
  onEditAsJsonChange,
  onViewAsJsonChange,
}: Props = $props();

/**
 * Built-in control-flow step types. These are created via the "Add Step"
 * palette (Control Flow section) and are not type-changeable once placed, so
 * they are excluded from the step-type change dropdown to avoid converting a
 * step into a non-editable state.
 */
const CF_TYPES = new Set(["if", "case", "waitFor", "emit"]);

/** Custom step types offered in the change-type dropdown (excludes control-flow types). */
let selectableCustomTypes = $derived(customStepTypes.filter((st) => !CF_TYPES.has(st.type)));

// Element references for template autocomplete
let promptEl = $state<HTMLTextAreaElement | null>(null);

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

<!--
  Renders a step type's icon tile (colored per category) followed by its label.
  Custom extension icons are resolved from the extensions store via iconIdForType;
  built-in types resolve their icon directly in visualForStepType.
-->
{#snippet stepTypeChip(type: string, size: number)}
  {@const v = visualForStepType(type, { iconId: iconIdForType(type), category: categoryForType(type) })}
  <span
    class="flex shrink-0 items-center justify-center rounded text-white {v.tileClass}"
    style="width: {size}px; height: {size}px;"
  >
    <v.icon size={Math.round(size * 0.68)} weight="bold" aria-hidden="true" />
  </span>
  <span class="truncate">{labelForStepType(type)}</span>
{/snippet}

<div class="w-95 h-full flex flex-col">
  <!-- Sidebar header -->
  <div class="px-4 pb-2 pt-2 flex flex-col gap-2">
    <div class="flex items-center gap-2">
      <button
        type="button"
        class="shrink-0 p-0 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        onclick={onclose}
        aria-label="Close step detail sidebar"
      >
        &#x2715;
      </button>
      {#if editMode}
        <div class="flex-1 flex flex-col gap-0.5">
          <input
            type="text"
            class="w-full px-2 py-1 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            value={editDraftStep?.slug ?? selectedStep.slug}
            maxlength={64}
            oninput={(e) => onSlugInput(selectedStepIndex, (e.target as HTMLInputElement).value)}
            placeholder="step-slug"
          >
          {#if validationErrors.get(`steps[${selectedStepIndex}].slug`)}
            <span class="text-xs text-destructive">{validationErrors.get(`steps[${selectedStepIndex}].slug`)}</span>
          {/if}
        </div>
        <button
          type="button"
          class="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          disabled={!editDraft || editDraft.steps.length <= 1}
          onclick={() => { onRemoveStep(editDraftStep?.id ?? selectedStep.id); onclose(); }}
          aria-label="Remove step"
          title={!editDraft || editDraft.steps.length <= 1 ? "At least one step is required" : `Remove step ${editDraftStep?.slug || "(unnamed)"}`}
        >
          <TrashIcon size={14} aria-hidden="true" />
        </button>
      {:else}
        <span class="text-sm font-medium truncate">{selectedStep.slug}</span>
      {/if}
    </div>
    {#if editMode}
      {#if validationErrors.get("steps.removeWarning")}
        <div class="warning-banner">
          <WarningIcon size={12} class="shrink-0" aria-hidden="true" />
          <span class="text-xs">{validationErrors.get("steps.removeWarning")}</span>
        </div>
      {/if}
      {@const currentType = editDraftStep?.type ?? selectedStep.type}
      {@const isCFType = CF_TYPES.has(currentType)}
      {#if isCFType}
        <!-- CF nodes: type is not changeable -->
        <div class="flex items-center gap-2">
          <span class="text-xs font-medium text-muted-foreground">Type:</span>
          <Badge variant="outline" class="w-fit gap-1.5"> {@render stepTypeChip(currentType, 16)} </Badge>
        </div>
      {:else}
        <label for="step-type" class="text-xs font-medium text-muted-foreground">Type</label>
        <Select
          type="single"
          value={currentType}
          onValueChange={(newType) => {
            if (newType) onStepTypeChange(selectedStepIndex, newType);
          }}
        >
          <SelectTrigger id="step-type" aria-label="Step type" class="gap-1.5">
            {@render stepTypeChip(currentType, 20)}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="agent" label={labelForStepType("agent")}>
              {@render stepTypeChip("agent", 20)}
            </SelectItem>
            {#each selectableCustomTypes as stepType (stepType.type)}
              <SelectItem value={stepType.type} label={stepType.label}>
                {@render stepTypeChip(stepType.type, 20)}
              </SelectItem>
            {/each}
          </SelectContent>
        </Select>
      {/if}
    {:else}
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium text-muted-foreground">Type:</span>
        <Badge variant="outline" class="w-fit gap-1.5"> {@render stepTypeChip(selectedStep.type, 16)} </Badge>
      </div>
    {/if}
  </div>

  <!-- Sidebar content -->
  <div class="flex-1 overflow-y-auto min-h-0 p-4 flex flex-col">
    {#if editMode && editDraftStep && (editDraftStep.type ?? selectedStep?.type) === "agent"}
      <!-- Edit mode: agent step -->
      <div class="flex flex-col gap-4 h-full">
        <div class="flex flex-col gap-1.5 shrink-0">
          <span class="text-xs font-medium text-muted-foreground">Tools</span>
          <MultiSelect
            items={availableTools}
            selected={editDraftStep.tools ?? []}
            placeholder="Search tools..."
            disabled={metaLoading || availableTools.length === 0}
            onchange={(newSelected) => onUpdateDraftStep(selectedStepIndex, (s) => { s.tools = newSelected; })}
          />
        </div>

        <div class="flex flex-col gap-1.5 shrink-0">
          <span class="text-xs font-medium text-muted-foreground">Skills</span>
          <MultiSelect
            items={availableSkills}
            selected={editDraftStep.skills ?? []}
            placeholder="Search skills..."
            disabled={metaLoading || availableSkills.length === 0}
            onchange={(newSelected) => onUpdateDraftStep(selectedStepIndex, (s) => { s.skills = newSelected; })}
          />
        </div>

        <div class="flex flex-col gap-1.5 flex-1 min-h-0">
          <div class="flex items-center justify-between shrink-0">
            <label for="step-prompt" class="text-xs font-medium text-muted-foreground">Prompt</label>
            <span class="text-xs text-muted-foreground pr-1">{(editDraftStep.prompt ?? "").length}/ 10000</span>
          </div>
          <textarea
            id="step-prompt"
            bind:this={promptEl}
            class="w-full flex-1 min-h-24 px-2 py-1.5 text-sm font-mono border border-border rounded-md bg-background resize-y focus:outline-none focus:ring-2 focus:ring-ring"
            maxlength={10000}
            value={editDraftStep.prompt ?? ""}
            oninput={(e) => {
              onUpdateDraftStep(selectedStepIndex, (s) => { s.prompt = (e.target as HTMLTextAreaElement).value; });
              const newErrors = new Map(validationErrors);
              newErrors.delete(`steps[${selectedStepIndex}].prompt`);
              onValidationErrorsChange(newErrors);
            }}
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
            onChange={(newValue) => onUpdateDraftStep(selectedStepIndex, (s) => { s.prompt = newValue; })}
          />
        </div>
      </div>
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
              onchange={(cond) => {
                onUpdateDraftStep(selectedStepIndex, (s) => { s.condition = cond; });
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
                  class="px-2 py-1 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
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
                  class="px-2 py-1 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
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

            <button
              type="button"
              class="text-xs text-muted-foreground underline hover:text-foreground self-start"
              onclick={() => { onEditAsJsonChange(true); }}
            >
              Edit as JSON
            </button>
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
            <button
              type="button"
              class="text-xs text-muted-foreground underline hover:text-foreground self-start"
              onclick={() => { onEditAsJsonChange(true); }}
            >
              Edit as JSON
            </button>
          {:else}
            <!-- JSON fallback: all fields except slug/type -->
            <div class="flex flex-col gap-1.5 flex-1 min-h-0">
              <div class="flex items-center justify-between">
                <label for="step-cf-config" class="text-xs font-medium text-muted-foreground"
                  >Configuration (JSON)</label
                >
                <button
                  type="button"
                  class="text-xs text-muted-foreground underline hover:text-foreground"
                  onclick={() => { onEditAsJsonChange(false); }}
                >
                  Use form editor
                </button>
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
        {@const stepTypeInfo = customStepTypes.find(st => st.type === stepType)}
        <div class="flex flex-col flex-1 min-h-0 gap-4">
          {#if stepTypeInfo?.configSchema && !editAsJson}
            <StepConfigForm
              schema={stepTypeInfo.configSchema}
              values={editDraftStep.config ?? {}}
              onchange={(vals) => {
              onUpdateDraftStep(selectedStepIndex, (s) => { s.config = vals; });
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
            <button
              type="button"
              class="text-xs text-muted-foreground underline hover:text-foreground"
              onclick={() => { onEditAsJsonChange(true); }}
            >
              Edit as JSON
            </button>
          {:else}
            <div class="flex flex-col gap-1.5 flex-1 min-h-0">
              <div class="flex items-center justify-between">
                <label for="step-config" class="text-xs font-medium text-muted-foreground">Configuration (JSON)</label>
                {#if stepTypeInfo?.configSchema}
                  <button
                    type="button"
                    class="text-xs text-muted-foreground underline hover:text-foreground"
                    onclick={() => { onEditAsJsonChange(false); }}
                  >
                    Use form editor
                  </button>
                {/if}
              </div>
              <textarea
                id="step-config"
                class="w-full flex-1 px-2 py-1.5 text-xs font-mono border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                value={JSON.stringify(editDraftStep.config ?? {}, null, 2)}
                oninput={(e) => {
                const raw = (e.target as HTMLTextAreaElement).value;
                try {
                  const parsed = JSON.parse(raw);
                  onUpdateDraftStep(selectedStepIndex, (s) => { s.config = parsed; });
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
    {:else if !editMode && (selectedStep.type === "if" || selectedStep.type === "case" || selectedStep.type === "waitFor" || selectedStep.type === "emit")}
      <!-- Read-only: built-in control-flow step config -->
      {@const roCfType = selectedStep.type}
      {@const roCfSchema = builtinConfigSchema(roCfType)}
      {#if viewAsJson}
        <div class="flex flex-col gap-1.5 flex-1 min-h-0">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-muted-foreground">Configuration (JSON)</span>
            <button
              type="button"
              class="text-xs text-muted-foreground underline hover:text-foreground"
              onclick={() => { onViewAsJsonChange(false); }}
            >
              View as form
            </button>
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
        {@const roBl = (selectedStep as unknown as StepDraft).branchLabels as { then?: string; else?: string } | undefined}
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
        <button
          type="button"
          class="text-xs text-muted-foreground underline hover:text-foreground mt-3 self-start"
          onclick={() => { onViewAsJsonChange(true); }}
        >
          View as JSON
        </button>
      {:else if roCfSchema}
        <StepConfigForm
          schema={roCfSchema}
          values={cfStepConfig(selectedStep as unknown as StepDraft)}
          readonly={true}
        />
        <button
          type="button"
          class="text-xs text-muted-foreground underline hover:text-foreground mt-3 self-start"
          onclick={() => { onViewAsJsonChange(true); }}
        >
          View as JSON
        </button>
      {/if}
    {:else if !editMode && selectedStep.type !== "agent"}
      <!-- Read-only: custom step type config -->
      {@const roStepType = selectedStep.type}
      {@const roStepTypeInfo = customStepTypes.find(st => st.type === roStepType)}
      {#if viewAsJson}
        <div class="flex flex-col gap-1.5 flex-1 min-h-0">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium text-muted-foreground">Configuration (JSON)</span>
            {#if roStepTypeInfo?.configSchema}
              <button
                type="button"
                class="text-xs text-muted-foreground underline hover:text-foreground"
                onclick={() => { onViewAsJsonChange(false); }}
              >
                View as form
              </button>
            {/if}
          </div>
          <pre
            class="text-xs font-mono whitespace-pre-wrap wrap-break-word bg-muted p-3 rounded flex-1 overflow-y-auto"
          >{JSON.stringify(selectedStep, null, 2)}</pre>
        </div>
      {:else if roStepTypeInfo?.configSchema}
        {@const roConfig = (() => { const { slug: _s, type: _t, input: _i, output: _o, ...rest } = selectedStep; return rest; })()}
        <StepConfigForm
          schema={roStepTypeInfo.configSchema}
          values={roConfig}
          readonly={true}
          itemOptions={{ skills: availableSkills }}
        />
        <button
          type="button"
          class="text-xs text-muted-foreground underline hover:text-foreground mt-3"
          onclick={() => { onViewAsJsonChange(true); }}
        >
          View as JSON
        </button>
      {:else}
        <div class="space-y-3">
          <div>
            <span class="text-xs font-medium text-muted-foreground">Configuration</span>
            <pre
              class="text-xs font-mono whitespace-pre-wrap wrap-break-word bg-muted p-3 rounded max-h-64 overflow-y-auto mt-0.5"
            >{JSON.stringify(
              (() => { const { slug: _s, type: _t, input: _i, output: _o, ...rest } = selectedStep; return rest; })(),
              null, 2
            )}</pre>
          </div>
          <button
            type="button"
            class="text-xs text-muted-foreground underline hover:text-foreground"
            onclick={() => { onViewAsJsonChange(true); }}
          >
            View as JSON
          </button>
        </div>
      {/if}
    {:else}
      <p class="text-sm text-muted-foreground">No details available for this step type.</p>
    {/if}
  </div>
</div>
