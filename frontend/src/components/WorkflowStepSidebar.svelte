<script lang="ts">
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import WarningIcon from "phosphor-svelte/lib/WarningIcon";
import { builtinConfigSchema } from "$lib/builtinStepSchemas";
import { t } from "$lib/i18n.svelte";
import { CF_TYPES, type PanelStep, type PanelStepType, type StepTemplateContext } from "$lib/stepConfig";
import type { OutputSchemas } from "$lib/templateScope";
import { variablePicker } from "$lib/variablePicker.svelte";
import type { StepDraft, WorkflowDraft } from "$lib/workflowValidation";
import { edgesToSlugEdges } from "$lib/workflowValidation";
import OutputSchemaEditor from "./OutputSchemaEditor.svelte";
import StepPanelHeader from "./StepPanelHeader.svelte";
import StepAgentEditor from "./stepPanel/StepAgentEditor.svelte";
import StepAgentView from "./stepPanel/StepAgentView.svelte";
import StepConfigView from "./stepPanel/StepConfigView.svelte";
import StepControlFlowEditor from "./stepPanel/StepControlFlowEditor.svelte";
import StepCustomEditor from "./stepPanel/StepCustomEditor.svelte";
import VariablePickerPanel from "./VariablePickerPanel.svelte";

interface Props {
  /** Saved workflow name (for inferring the result schema from past runs). */
  workflowName?: string;
  /** The step currently displayed (source-of-truth in view mode). */
  selectedStep: PanelStep;
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
  customStepTypes: PanelStepType[];
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
  workflowName,
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

/**
 * Template autocomplete context for the edit forms. The editor tracks edges by
 * synthetic id, but the preceding-step rule works in slug space, so the draft's
 * edges are converted here.
 */
let template = $derived<StepTemplateContext>({
  steps: editDraft?.steps ?? [],
  currentStepIndex: selectedStepIndex,
  secretKeys: cachedSecretKeys,
  variableKeys: cachedVariableKeys,
  outputSchemas,
  edges: editDraft ? edgesToSlugEdges(editDraft.steps, editDraft.edges) : [],
});

/**
 * Whether the edited step has successors. Only descendants can reference a
 * step's result, so a terminal step needs no output schema.
 */
/** The panel's root element (the variable picker docks beside it). */
let panelElement = $state<HTMLElement | null>(null);

let hasSuccessors = $derived(
  !!editDraft && !!editDraftStep && editDraft.edges.some((e) => e.from === (editDraftStep.id ?? editDraftStep.slug)),
);
</script>

<div class="w-95 h-full flex flex-col" bind:this={panelElement}>
  {#if editMode}
    <VariablePickerPanel anchor={panelElement} />
  {/if}
  <StepPanelHeader
    type={currentType}
    subtitle={editMode ? undefined : selectedStep.slug}
    jsonView={jsonActive}
    variablesOpen={variablePicker.open}
    onToggleVariables={editMode ? () => variablePicker.toggle() : undefined}
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
          >{t("stepSidebar.slug")} <span class="text-destructive">*</span></label
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
    <!-- Step content fills the panel but never shrinks below its own height:
         its branches use `flex-1 min-h-0`, which would otherwise let the
         content overflow onto the output schema section that follows. -->
    <div class="flex flex-col flex-1 shrink-0">
      {#if editMode && editDraftStep}
        {#if editDraftStep.type === "agent"}
          <StepAgentEditor
            index={selectedStepIndex}
            step={editDraftStep}
            {validationErrors}
            {availableTools}
            {availableSkills}
            {metaLoading}
            {template}
            {onUpdateDraftStep}
            {onValidationErrorsChange}
          />
        {:else if CF_TYPES.has(editDraftStep.type)}
          <StepControlFlowEditor
            index={selectedStepIndex}
            step={editDraftStep}
            {editAsJson}
            {validationErrors}
            {template}
            {onUpdateDraftStep}
            {onValidationErrorsChange}
          />
        {:else}
          <StepCustomEditor
            index={selectedStepIndex}
            step={editDraftStep}
            stepType={customStepTypes.find((st) => st.type === editDraftStep.type)}
            {editAsJson}
            {validationErrors}
            {availableSkills}
            {template}
            {onUpdateDraftStep}
            {onValidationErrorsChange}
          />
        {/if}
      {:else if !editMode && selectedStep.type === "agent" && selectedStep.prompt}
        <StepAgentView step={selectedStep} />
      {:else if !editMode && selectedStep.type !== "agent"}
        <StepConfigView step={selectedStep} {viewAsJson} {customStepTypes} {availableSkills} />
      {:else}
        <p class="text-sm text-muted-foreground">{t("stepSidebar.noDetails")}</p>
      {/if}
    </div>

    <!-- Hand-authored result shape: agent and custom steps only (control-flow
         nodes have fixed, built-in result shapes). Hidden for terminal steps,
         whose result nothing can reference, unless one is already declared. -->
    {#if !CF_TYPES.has(currentType) && (!editMode || hasSuccessors || editDraftStep?.outputSchema)}
      {@const slug = editDraftStep?.slug ?? selectedStep.slug}
      <div class="mt-4 shrink-0">
        {#if editMode && editDraftStep}
          <OutputSchemaEditor
            value={editDraftStep.outputSchema}
            {workflowName}
            source={{ kind: "step", slug }}
            onChange={(outputSchema) =>
              onUpdateDraftStep(selectedStepIndex, (step) => {
                if (outputSchema) step.outputSchema = outputSchema;
                else delete step.outputSchema;
              })}
          />
        {:else}
          <OutputSchemaEditor value={selectedStep.outputSchema} readonly source={{ kind: "step", slug }} />
        {/if}
      </div>
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
          ? t("validation.stepRequired")
          : t("stepSidebar.removeStepNamed", { slug: editDraftStep?.slug || t("validation.unnamed") })}
      >
        <TrashIcon size={14} aria-hidden="true" />
        {t("stepSidebar.removeStep")}
      </button>
    </div>
  {/if}
</div>
