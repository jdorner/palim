<script lang="ts">
import PlayIcon from "phosphor-svelte/lib/PlayIcon";
import { untrack } from "svelte";
import { Button } from "$lib/components/ui/button";
import { Dialog } from "$lib/components/ui/dialog";
/**
 * Dialog that starts a workflow run with a JSON payload. Prefilled with a
 * skeleton of the trigger's `outputSchema`; invalid JSON is rejected here.
 */
import { t } from "$lib/i18n.svelte";
import { parsePayloadText, payloadSkeleton } from "$lib/payloadSkeleton";
import type { OutputSchemaShorthand } from "$shared/workflows";

interface Props {
  /** Whether the dialog is open. */
  open: boolean;
  /** The trigger's payload shape, when declared. */
  outputSchema?: OutputSchemaShorthand;
  /** Starts the run with the parsed payload. */
  onRun: (payload: unknown) => void;
  /** Closes the dialog without running. */
  onClose: () => void;
}

let { open, outputSchema, onRun, onClose }: Props = $props();

let text = $state("");
let invalid = $state(false);

// Refill from the schema each time the dialog opens. Only `open` is tracked:
// the page reassigns its workflow on every run event, and re-running on that
// would replace what the user has typed.
$effect(() => {
  if (!open) return;
  untrack(() => {
    text = JSON.stringify(payloadSkeleton(outputSchema), null, 2);
    invalid = false;
  });
});

function submit() {
  const parsed = parsePayloadText(text);
  if (!parsed.ok) {
    invalid = true;
    return;
  }
  onRun(parsed.value);
}
</script>

<Dialog {open} title={t("workflows.runWithPayload")} class="max-w-lg" {onClose} onSave={submit}>
  <div class="space-y-1">
    <label class="text-xs font-medium text-muted-foreground" for="run-payload">{t("workflows.payloadLabel")}</label>
    <textarea
      id="run-payload"
      class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring resize-y min-h-40"
      rows={10}
      spellcheck="false"
      aria-invalid={invalid}
      bind:value={text}
      oninput={() => {
        invalid = false;
      }}
    ></textarea>
    {#if invalid}
      <p class="text-xs text-destructive">{t("workflows.payloadInvalid")}</p>
    {:else}
      <p class="text-xs text-muted-foreground">{t("workflows.payloadHint")}</p>
    {/if}
  </div>
  {#snippet footer()}
    <Button size="sm" variant="outline" onclick={onClose}>{t("common.cancel")}</Button>
    <Button size="sm" variant="default" onclick={submit}>
      <PlayIcon size={14} class="mr-1.5" aria-hidden="true" />
      {t("workflows.runWorkflow")}
    </Button>
  {/snippet}
</Dialog>
