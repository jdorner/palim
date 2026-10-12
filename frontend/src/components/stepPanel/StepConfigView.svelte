<script lang="ts">
/**
 * Read-only config of a control-flow or custom step: a read-only form, or the
 * raw JSON when `viewAsJson` is set (or the type has no config schema).
 */
import { genericFormSchema } from "$lib/builtinStepSchemas";
import { Badge } from "$lib/components/ui/badge";
import { t } from "$lib/i18n.svelte";
import { CF_TYPES, cfStepConfig, type PanelStep, type PanelStepType } from "$lib/stepConfig";
import type { StepDraft } from "$lib/workflowValidation";
import ConditionForm from "../ConditionForm.svelte";
import FieldListEditor from "../FieldListEditor.svelte";
import StepConfigForm from "../StepConfigForm.svelte";

interface Props {
  step: PanelStep;
  viewAsJson: boolean;
  customStepTypes: PanelStepType[];
  availableSkills: string[];
}

let { step, viewAsJson, customStepTypes, availableSkills }: Props = $props();

/** The step's fields as a draft (control-flow config lives in flat fields). */
let asDraft = $derived(step as unknown as StepDraft);

/** A custom step's config: every field except slug and type. */
let customConfig = $derived.by(() => {
  const { slug: _s, type: _t, ...rest } = step;
  return rest;
});
</script>

{#if CF_TYPES.has(step.type)}
  {@const cfSchema = genericFormSchema(step.type)}
  {#if viewAsJson}
    <div class="flex flex-col gap-1.5 flex-1 min-h-0">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-muted-foreground">{t("stepSidebar.configJson")}</span>
      </div>
      <pre
        class="text-xs font-mono whitespace-pre-wrap wrap-break-word bg-muted p-3 rounded flex-1 overflow-y-auto"
      >{JSON.stringify(cfStepConfig(asDraft), null, 2)}</pre>
    </div>
  {:else if step.type === "if"}
    <ConditionForm condition={(asDraft.condition as Record<string, unknown>) ?? { ref: "" }} readonly={true} />
    {@const labels = asDraft.branchLabels}
    {#if labels && (labels.then || labels.else)}
      <div class="flex flex-col gap-1.5 mt-3">
        <span class="text-xs font-medium text-muted-foreground">{t("stepSidebar.branchLabels")}</span>
        <div class="flex items-center gap-2">
          <span class="text-[11px] text-muted-foreground w-10">then:</span>
          <Badge variant="outline" class="text-xs">{labels.then || "then"}</Badge>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[11px] text-muted-foreground w-10">else:</span>
          <Badge variant="outline" class="text-xs">{labels.else || "else"}</Badge>
        </div>
      </div>
    {/if}
  {:else if cfSchema}
    <StepConfigForm
      schema={cfSchema}
      i18nScope={{ prefix: `builtinSteps.${step.type}` }}
      values={cfStepConfig(asDraft)}
      readonly={true}
    />
    {#if step.type === "humanTask" && asDraft.form}
      <div class="flex flex-col gap-1 mt-3">
        <span class="text-xs font-medium text-muted-foreground">{t("builtinSteps.humanTask.form.title")}</span>
        <FieldListEditor
          id="human-task-form-view"
          mode="form"
          value={asDraft.form as Record<string, unknown>}
          readonly
        />
      </div>
    {/if}
  {/if}
{:else}
  {@const stepType = customStepTypes.find((st) => st.type === step.type)}
  {#if viewAsJson}
    <div class="flex flex-col gap-1.5 flex-1 min-h-0">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-muted-foreground">{t("stepSidebar.configJson")}</span>
      </div>
      <pre
        class="text-xs font-mono whitespace-pre-wrap wrap-break-word bg-muted p-3 rounded flex-1 overflow-y-auto"
      >{JSON.stringify(step, null, 2)}</pre>
    </div>
  {:else if stepType?.configSchema}
    <StepConfigForm
      schema={stepType.configSchema}
      i18nScope={stepType.extensionName
        ? { extension: stepType.extensionName, prefix: `steps.${stepType.type}.config` }
        : undefined}
      values={customConfig}
      readonly={true}
      itemOptions={{ skills: availableSkills }}
    />
  {:else}
    <div class="space-y-3">
      <div>
        <span class="text-xs font-medium text-muted-foreground">{t("stepSidebar.configuration")}</span>
        <pre
          class="text-xs font-mono whitespace-pre-wrap wrap-break-word bg-muted p-3 rounded max-h-64 overflow-y-auto mt-0.5"
        >{JSON.stringify(customConfig, null, 2)}</pre>
      </div>
    </div>
  {/if}
{/if}
