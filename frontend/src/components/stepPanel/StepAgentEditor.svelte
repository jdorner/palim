<script lang="ts">
/**
 * Edit form of an agent step: tools, skills, and the prompt (with template
 * autocomplete and a large editor dialog).
 */
import ArrowsOutSimpleIcon from "phosphor-svelte/lib/ArrowsOutSimpleIcon";
import { t } from "$lib/i18n.svelte";
import { type StepTemplateContext, withoutError } from "$lib/stepConfig";
import type { StepDraft } from "$lib/workflowValidation";
import ExpandedTextEditor from "../ExpandedTextEditor.svelte";
import MultiSelect from "../MultiSelect.svelte";
import TemplateAutocomplete from "../TemplateAutocomplete.svelte";

interface Props {
  /** Index of the step in the draft. */
  index: number;
  /** The draft step. */
  step: StepDraft;
  validationErrors: Map<string, string>;
  availableTools: string[];
  availableSkills: string[];
  /** Whether tools/skills are still loading. */
  metaLoading: boolean;
  template: StepTemplateContext;
  onUpdateDraftStep: (index: number, updater: (step: StepDraft) => void) => void;
  onValidationErrorsChange: (errors: Map<string, string>) => void;
}

let {
  index,
  step,
  validationErrors,
  availableTools,
  availableSkills,
  metaLoading,
  template,
  onUpdateDraftStep,
  onValidationErrorsChange,
}: Props = $props();

let promptEl = $state<HTMLTextAreaElement | null>(null);

/** Whether the prompt is open in the large editor dialog. */
let promptExpanded = $state(false);

// Close the large prompt editor when the panel switches to another step.
$effect(() => {
  index;
  promptExpanded = false;
});

/** Write the prompt to the draft and clear its validation error. */
function setPrompt(value: string) {
  onUpdateDraftStep(index, (s) => {
    s.prompt = value;
  });
  const next = withoutError(validationErrors, `steps[${index}].prompt`);
  if (next !== validationErrors) onValidationErrorsChange(next);
}
</script>

<!-- Fills the panel height (flex-1, not h-full, so the scroll area's padding is
     not added on top); the prompt textarea takes the remaining space and never
     shrinks below its minimum. -->
<div class="flex flex-col gap-4 flex-1">
  <div class="flex flex-col gap-1.5 shrink-0">
    <span class="text-xs font-medium text-muted-foreground">{t("stepSidebar.tools")}</span>
    <MultiSelect
      size="xs"
      items={availableTools}
      selected={step.tools ?? []}
      placeholder={t("stepSidebar.searchTools")}
      disabled={metaLoading || availableTools.length === 0}
      onchange={(newSelected) =>
        onUpdateDraftStep(index, (s) => {
          s.tools = newSelected;
        })}
    />
  </div>

  <div class="flex flex-col gap-1.5 shrink-0">
    <span class="text-xs font-medium text-muted-foreground">{t("stepSidebar.skills")}</span>
    <MultiSelect
      size="xs"
      items={availableSkills}
      selected={step.skills ?? []}
      placeholder={t("stepSidebar.searchSkills")}
      disabled={metaLoading || availableSkills.length === 0}
      onchange={(newSelected) =>
        onUpdateDraftStep(index, (s) => {
          s.skills = newSelected;
        })}
    />
  </div>

  <div class="flex flex-col gap-1.5 flex-1">
    <div class="flex items-center justify-between shrink-0">
      <label for="step-prompt" class="text-xs font-medium text-muted-foreground">{t("stepSidebar.prompt")}</label>
      <div class="flex items-center gap-1.5">
        <span class="text-xs text-muted-foreground">{(step.prompt ?? "").length}/ 10000</span>
        <button
          type="button"
          class="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          onclick={() => (promptExpanded = true)}
          aria-label={t("stepSidebar.expandPrompt")}
          title={t("stepSidebar.expand")}
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
      value={step.prompt ?? ""}
      oninput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
      placeholder={t("stepSidebar.promptPlaceholder")}
    ></textarea>
    {#if validationErrors.get(`steps[${index}].prompt`)}
      <span class="text-xs text-destructive shrink-0">{validationErrors.get(`steps[${index}].prompt`)}</span>
    {/if}
    <TemplateAutocomplete targetElement={promptEl} {...template} onChange={setPrompt} />
  </div>
</div>

{#if promptExpanded}
  <ExpandedTextEditor
    title={t("stepSidebar.prompt")}
    description={step.slug}
    value={step.prompt ?? ""}
    oninput={setPrompt}
    onClose={() => (promptExpanded = false)}
    maxlength={10000}
    placeholder={t("stepSidebar.promptPlaceholder")}
    {template}
  />
{/if}
