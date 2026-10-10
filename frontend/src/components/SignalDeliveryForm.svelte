<!--
  Signal delivery form for workflow waitFor steps.

  Renders a schema-driven form (via StepConfigForm pattern) when the waitFor step
  defines an inputSchema, or a freeform JSON textarea otherwise.
  Submits signal payload via POST to the signal delivery endpoint.
-->
<script lang="ts">
import PaperPlaneTiltIcon from "phosphor-svelte/lib/PaperPlaneTiltIcon";
import { authFetch } from "$lib/auth";
import { Button } from "$lib/components/ui/button";
import { t } from "$lib/i18n.svelte";
import { buildInitialValues, getProperties } from "$lib/schemaForm";
import StepConfigForm from "./StepConfigForm.svelte";

interface Props {
  /** The workflow run ID. */
  runId: string;
  /** The signal event name to deliver. */
  event: string;
  /** Optional JSON Schema for structured payload input. */
  inputSchema?: Record<string, unknown> | null;
}

let { runId, event, inputSchema }: Props = $props();

/** Whether the schema has actual properties (use structured form). */
let hasSchemaFields = $derived(
  inputSchema != null &&
    typeof inputSchema === "object" &&
    "properties" in inputSchema &&
    Object.keys(getProperties(inputSchema)).length > 0,
);

/** Form values for schema-driven mode. */
let formValues = $state<Record<string, unknown>>({});

/** Raw JSON text for freeform mode. */
let rawJson = $state("{}");

/** Whether a submission is in progress or was successful. */
let submitting = $state(false);
/** Whether the signal was successfully delivered (button stays disabled). */
let submitted = $state(false);
/** Inline error message from a failed submission. */
let errorMessage = $state<string | null>(null);

/** Initialize form values when schema changes. */
$effect(() => {
  if (hasSchemaFields && inputSchema) {
    formValues = buildInitialValues(inputSchema);
  }
});

/** Handle schema form field changes. */
function handleFormChange(values: Record<string, unknown>) {
  formValues = values;
  errorMessage = null;
}

/** Build the payload to submit. */
function buildPayload(): unknown {
  if (hasSchemaFields) {
    return formValues;
  }
  try {
    return JSON.parse(rawJson);
  } catch {
    return null;
  }
}

/** Submit the signal delivery request. */
async function handleSubmit() {
  errorMessage = null;

  const payload = buildPayload();
  if (payload === null) {
    errorMessage = t("signal.invalidJson");
    return;
  }

  submitting = true;
  try {
    const res = await authFetch(`/ext/workflows/runs/${runId}/signal/${event}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      submitted = true;
    } else {
      const data = await res.json().catch(() => null);
      errorMessage = data?.error ?? t("signal.failed", { status: res.status });
      submitting = false;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : t("signal.networkError");
    submitting = false;
  }
}
</script>

<div class="border-t border-border pt-3 mt-3 space-y-3">
  <h4 class="text-xs font-medium text-muted-foreground uppercase tracking-wide">{t("signal.title")}</h4>
  <p class="text-xs text-muted-foreground">
    {t("signal.waitingFor")} <span class="font-mono text-foreground">{event}</span>
  </p>

  {#if hasSchemaFields && inputSchema}
    <StepConfigForm
      schema={inputSchema}
      values={formValues}
      onchange={handleFormChange}
      readonly={submitting || submitted}
    />
  {:else}
    <div class="space-y-1">
      <label class="text-xs font-medium text-muted-foreground" for="signal-payload">{t("signal.payload")}</label>
      <textarea
        id="signal-payload"
        class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring resize-y min-h-20"
        rows={4}
        disabled={submitting || submitted}
        bind:value={rawJson}
        oninput={() => {
          errorMessage = null;
        }}
      ></textarea>
    </div>
  {/if}

  {#if errorMessage}
    <p class="text-xs text-destructive">{errorMessage}</p>
  {/if}

  <Button size="sm" variant="default" onclick={handleSubmit} disabled={submitting || submitted}>
    <PaperPlaneTiltIcon size={14} class="mr-1.5" aria-hidden="true" />
    {#if submitted}
      {t("signal.delivered")}
    {:else if submitting}
      {t("signal.sending")}
    {:else}
      {t("signal.send")}
    {/if}
  </Button>
</div>
