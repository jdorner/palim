<script lang="ts">
/**
 * Edit form of a custom (extension-registered) step: a form generated from the
 * step type's config schema, or the raw JSON config.
 */
import { t } from "$lib/i18n.svelte";
import {
  type PanelStepType,
  revalidateCustomConfig,
  type StepTemplateContext,
  stepFieldErrors,
  withoutError,
} from "$lib/stepConfig";
import type { StepDraft } from "$lib/workflowValidation";
import StepConfigForm from "../StepConfigForm.svelte";

interface Props {
  /** Index of the step in the draft. */
  index: number;
  /** The draft step. */
  step: StepDraft;
  /** The step's type, if its extension is loaded. */
  stepType: PanelStepType | undefined;
  /** Whether to show the raw JSON editor instead of the form. */
  editAsJson: boolean;
  validationErrors: Map<string, string>;
  availableSkills: string[];
  template: StepTemplateContext;
  onUpdateDraftStep: (index: number, updater: (step: StepDraft) => void) => void;
  onValidationErrorsChange: (errors: Map<string, string>) => void;
}

let {
  index,
  step,
  stepType,
  editAsJson,
  validationErrors,
  availableSkills,
  template,
  onUpdateDraftStep,
  onValidationErrorsChange,
}: Props = $props();

/** Applies the JSON editor's text: the parsed config, or an "Invalid JSON" error. */
function onJsonInput(raw: string) {
  const key = `steps[${index}].config`;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    onValidationErrorsChange(new Map(validationErrors).set(key, "Invalid JSON"));
    return;
  }
  onUpdateDraftStep(index, (s) => {
    s.config = parsed;
  });
  onValidationErrorsChange(
    revalidateCustomConfig(withoutError(validationErrors, key), index, parsed, stepType?.configSchema),
  );
}
</script>

<div class="flex flex-col flex-1 min-h-0 gap-4">
  {#if stepType?.configSchema && !editAsJson}
    {@const schema = stepType.configSchema}
    <StepConfigForm
      {schema}
      i18nScope={stepType.extensionName
        ? { extension: stepType.extensionName, prefix: `steps.${stepType.type}.config` }
        : undefined}
      values={step.config ?? {}}
      onchange={(vals) => {
        onUpdateDraftStep(index, (s) => {
          s.config = vals;
        });
        onValidationErrorsChange(revalidateCustomConfig(validationErrors, index, vals ?? {}, schema));
      }}
      {...template}
      itemOptions={{ skills: availableSkills }}
      fieldErrors={stepFieldErrors(validationErrors, index, "config")}
    />
  {:else}
    <div class="flex flex-col gap-1.5 flex-1 min-h-0">
      <div class="flex items-center justify-between">
        <label for="step-config" class="text-xs font-medium text-muted-foreground">{t("stepSidebar.configJson")}</label>
      </div>
      <textarea
        id="step-config"
        class="w-full flex-1 px-2 py-1.5 text-xs font-mono border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-none"
        value={JSON.stringify(step.config ?? {}, null, 2)}
        oninput={(e) => onJsonInput((e.target as HTMLTextAreaElement).value)}
      ></textarea>
      {#if validationErrors.get(`steps[${index}].config`)}
        <span class="text-xs text-destructive">{validationErrors.get(`steps[${index}].config`)}</span>
      {/if}
    </div>
  {/if}
</div>
