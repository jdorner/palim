<script lang="ts">
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import WarningIcon from "phosphor-svelte/lib/WarningIcon";
import { Badge } from "$lib/components/ui/badge";
import { labelForStepType } from "$lib/stepTypes";
import type { OutputSchemas } from "$lib/templateScope";
import { renderMarkdown } from "$lib/utils";
import type { StepDraft, WorkflowDraft } from "$lib/workflowValidation";
import { validateStepConfig } from "$lib/workflowValidation";
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
  /** Custom step types from extensions. */
  customStepTypes: StepTypeInfo[];
  /** Output schemas for template autocomplete. */
  outputSchemas?: OutputSchemas;
  /** Callback to close the sidebar. */
  onclose: () => void;
  /** Callback when slug input changes. */
  onSlugInput: (index: number, value: string) => void;
  /** Callback to remove a step. */
  onRemoveStep: (index: number) => void;
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

// Element references for template autocomplete
let promptEl = $state<HTMLTextAreaElement | null>(null);
</script>

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
          onclick={() => { onRemoveStep(selectedStepIndex); onclose(); }}
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
      <label for="step-type" class="text-xs font-medium text-muted-foreground">Type</label>
      <select
        id="step-type"
        class="px-2 py-1 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
        value={editDraftStep?.type ?? selectedStep.type}
        onchange={(e) => {
          const newType = (e.target as HTMLSelectElement).value;
          onStepTypeChange(selectedStepIndex, newType);
        }}
      >
        <option value="agent">{labelForStepType("agent")}</option>
        {#each customStepTypes as stepType}
          <option value={stepType.type}>{stepType.icon ?? ""} {stepType.label}</option>
        {/each}
      </select>
    {:else}
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium text-muted-foreground">Type:</span>
        <Badge variant="outline" class="w-fit">{labelForStepType(selectedStep.type)}</Badge>
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
          <pre
            class="text-xs font-mono whitespace-pre-wrap wrap-break-word bg-muted p-3 rounded mt-1"
          >{@html renderMarkdown(selectedStep.prompt)}</pre>
        </div>
      </div>
    {:else if editMode && editDraftStep && (editDraftStep.type ?? selectedStep?.type) !== "agent"}
      <!-- Edit mode: custom step type - schema-driven form or JSON fallback -->
      {@const stepType = editDraftStep.type ?? selectedStep?.type}
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
              <span class="text-xs text-destructive">{validationErrors.get(`steps[${selectedStepIndex}].config`)}</span>
            {/if}
          </div>
        {/if}
      </div>
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
