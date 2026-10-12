<script lang="ts">
/**
 * Edit form of a built-in control-flow step: the condition form for `if`, a
 * schema-driven form for the others, or the raw JSON config.
 */
import { genericFormSchema } from "$lib/builtinStepSchemas";
import { t } from "$lib/i18n.svelte";
import {
  applyCfValues,
  cfStepConfig,
  revalidateCfStep,
  type StepTemplateContext,
  stepFieldErrors,
  withoutError,
} from "$lib/stepConfig";
import type { StepDraft } from "$lib/workflowValidation";
import ConditionForm from "../ConditionForm.svelte";
import FieldListEditor from "../FieldListEditor.svelte";
import InfoTip from "../InfoTip.svelte";
import StepConfigForm from "../StepConfigForm.svelte";

interface Props {
  /** Index of the step in the draft. */
  index: number;
  /** The draft step. */
  step: StepDraft;
  /** Whether to show the raw JSON editor instead of the form. */
  editAsJson: boolean;
  validationErrors: Map<string, string>;
  template: StepTemplateContext;
  onUpdateDraftStep: (index: number, updater: (step: StepDraft) => void) => void;
  onValidationErrorsChange: (errors: Map<string, string>) => void;
}

let { index, step, editAsJson, validationErrors, template, onUpdateDraftStep, onValidationErrorsChange }: Props =
  $props();

let cfSchema = $derived(genericFormSchema(step.type));

/** Writes the humanTask form, or records why the edited form is invalid (blocks saving). */
function setForm(form: Record<string, unknown> | undefined) {
  onUpdateDraftStep(index, (s) => {
    if (form) s.form = form;
    else delete s.form;
  });
}

function setFormError(error: string | null) {
  onUpdateDraftStep(index, (s) => {
    if (error) s.editorFormError = error;
    else delete s.editorFormError;
  });
  const next = withoutError(validationErrors, `steps[${index}].form`);
  if (next !== validationErrors) onValidationErrorsChange(next);
}
let branchLabels = $derived((step.branchLabels as { then?: string; else?: string } | undefined) ?? {});

/** Writes one display-only branch label override of an `if` step. */
function setBranchLabel(branch: "then" | "else", value: string) {
  onUpdateDraftStep(index, (s) => {
    const next = { ...(s.branchLabels ?? {}) };
    next[branch] = value;
    s.branchLabels = next;
  });
}
</script>

<div class="flex flex-col flex-1 min-h-0 gap-4">
  {#if !editAsJson && step.type === "if"}
    <!-- `if`: dedicated condition form (nested ref + operator) -->
    <ConditionForm
      condition={(step.condition as Record<string, unknown>) ?? { ref: "" }}
      refError={validationErrors.get(`steps[${index}].condition`)}
      {...template}
      onchange={(cond) => {
        onUpdateDraftStep(index, (s) => {
          s.condition = cond;
        });
        const next = withoutError(validationErrors, `steps[${index}].condition`);
        if (next !== validationErrors) onValidationErrorsChange(next);
      }}
    />

    <!-- Optional branch edge label overrides. Display-only: the branch
         routing keys stay "then"/"else"; these just relabel the edges. -->
    <div class="flex flex-col gap-3">
      <span class="text-xs font-medium text-muted-foreground">{t("stepSidebar.branchLabelsOptional")}</span>
      <div class="flex flex-col gap-1">
        <label for="if-then-label" class="text-[11px] text-muted-foreground">{t("stepSidebar.thenLabel")}</label>
        <input
          id="if-then-label"
          type="text"
          class="px-2 py-1 text-xs border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          maxlength={64}
          value={branchLabels.then ?? ""}
          placeholder="then"
          oninput={(e) => setBranchLabel("then", (e.target as HTMLInputElement).value)}
        >
      </div>
      <div class="flex flex-col gap-1">
        <label for="if-else-label" class="text-[11px] text-muted-foreground">{t("stepSidebar.elseLabel")}</label>
        <input
          id="if-else-label"
          type="text"
          class="px-2 py-1 text-xs border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          maxlength={64}
          value={branchLabels.else ?? ""}
          placeholder="else"
          oninput={(e) => setBranchLabel("else", (e.target as HTMLInputElement).value)}
        >
      </div>
    </div>
  {:else if !editAsJson && cfSchema}
    <!-- `waitFor` / `emit` / `case` / ...: schema-driven form on flat fields -->
    {@const schema = cfSchema}
    <StepConfigForm
      {schema}
      i18nScope={{ prefix: `builtinSteps.${step.type}` }}
      values={cfStepConfig(step)}
      onchange={(vals) => {
        // Keep the fields the generic form does not edit (humanTask form).
        onUpdateDraftStep(index, (s) =>
          applyCfValues(s, { ...vals, form: s.form, editorFormError: s.editorFormError }),
        );
        onValidationErrorsChange(revalidateCfStep(validationErrors, index, vals, schema));
      }}
      {...template}
      fieldErrors={stepFieldErrors(validationErrors, index, "flat")}
    />
    {#if step.type === "humanTask"}
      <div class="flex flex-col gap-1">
        <span class="inline-flex items-center gap-1">
          <span id="human-task-form-label" class="text-xs font-medium text-muted-foreground"
            >{t("builtinSteps.humanTask.form.title")}</span
          >
          <InfoTip text={t("builtinSteps.humanTask.form.description")} />
        </span>
        <FieldListEditor
          id="human-task-form"
          labelledBy="human-task-form-label"
          mode="form"
          value={step.form as Record<string, unknown> | undefined}
          onChange={setForm}
          onError={setFormError}
        />
      </div>
    {/if}
  {:else}
    <!-- JSON fallback: all fields except slug/type -->
    <div class="flex flex-col gap-1.5 flex-1 min-h-0">
      <div class="flex items-center justify-between">
        <label for="step-cf-config" class="text-xs font-medium text-muted-foreground"
          >{t("stepSidebar.configJson")}</label
        >
      </div>
      <textarea
        id="step-cf-config"
        class="w-full flex-1 px-2 py-1.5 text-xs font-mono border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring resize-none"
        value={JSON.stringify(cfStepConfig(step), null, 2)}
        oninput={(e) => {
          try {
            const parsed = JSON.parse((e.target as HTMLTextAreaElement).value);
            onUpdateDraftStep(index, (s) => applyCfValues(s, parsed));
          } catch {
            // Invalid JSON - ignore until valid
          }
        }}
      ></textarea>
    </div>
  {/if}
</div>
