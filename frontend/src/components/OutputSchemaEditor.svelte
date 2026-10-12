<script lang="ts">
import MagicWandIcon from "phosphor-svelte/lib/MagicWandIcon";
import { untrack } from "svelte";
import { Button } from "$lib/components/ui/button";
/**
 * Edits a trigger's or step's `outputSchema` shorthand with the field builder
 * (or as JSON), plus an "Infer from last run" action that fills it from the
 * newest run's data. The schema drives template autocomplete and path
 * validation for references to this node. Empty means the built-in (trigger
 * type / step handler) schema.
 */
import { i18n, t } from "$lib/i18n.svelte";
import type { InferSource } from "$lib/outputSchemaShorthand";
import { fetchInferredSchema } from "$lib/workflowEditorMeta";
import type { OutputSchemaShorthand } from "$shared/workflows";
import FieldListEditor from "./FieldListEditor.svelte";
import InfoTip from "./InfoTip.svelte";

interface Props {
  /** The current shorthand (undefined = none declared). */
  value: OutputSchemaShorthand | undefined;
  /** Read-only display (view mode). */
  readonly?: boolean;
  /** Saved workflow name; inference is unavailable for unsaved workflows. */
  workflowName?: string;
  /** Where to infer the schema from. */
  source: InferSource;
  /** Called with the new shorthand when it is valid. */
  onChange?: (value: OutputSchemaShorthand | undefined) => void;
}

let { value, readonly = false, workflowName, source, onChange }: Props = $props();

let inferStatus = $state<{ kind: "info" | "error"; message: string } | null>(null);
let inferring = $state(false);
let editorError = $state<string | null>(null);

// "Inferred from run …" no longer applies once the schema is cleared (Clear, last field removed, undo).
$effect(() => {
  if (value !== undefined) return;
  untrack(() => {
    if (inferStatus?.kind === "info") inferStatus = null;
  });
});

async function infer() {
  if (!workflowName) return;
  inferring = true;
  inferStatus = null;
  try {
    const inferred = await fetchInferredSchema(workflowName, source);
    onChange?.(inferred.shorthand);
    inferStatus = {
      kind: "info",
      message: t("outputSchema.inferredFrom", {
        id: inferred.runId.slice(0, 8),
        time: i18n.format.date(inferred.runCreatedAt),
      }),
    };
  } catch (err) {
    inferStatus = { kind: "error", message: err instanceof Error ? err.message : String(err) };
  } finally {
    inferring = false;
  }
}
</script>

{#if readonly}
  {#if value}
    <div class="flex flex-col gap-1">
      <span class="text-xs font-medium text-muted-foreground">{t("outputSchema.label")}</span>
      <FieldListEditor id="output-schema-view" mode="shape" {value} readonly />
    </div>
  {/if}
{:else}
  <div class="flex flex-col gap-1">
    <div class="flex items-center justify-between gap-2">
      <span class="inline-flex items-center gap-1">
        <span id="output-schema-editor-label" class="text-xs font-medium text-muted-foreground"
          >{t("outputSchema.label")}</span
        >
        <InfoTip text={t("outputSchema.hint")} />
      </span>
      <div class="flex items-center gap-1">
        {#if value}
          <Button variant="ghost" size="xs" class="text-xs" onclick={() => onChange?.(undefined)}
            >{t("outputSchema.clear")}</Button
          >
        {/if}
        <Button
          variant="outline"
          size="xs"
          class="text-xs gap-1"
          disabled={!workflowName || inferring}
          title={workflowName ? t("outputSchema.inferTitle") : t("outputSchema.inferDisabled")}
          onclick={infer}
        >
          <MagicWandIcon size={12} aria-hidden="true" />
          {inferring ? t("outputSchema.inferring") : t("outputSchema.infer")}
        </Button>
      </div>
    </div>
    <FieldListEditor
      id="output-schema-editor"
      labelledBy="output-schema-editor-label"
      mode="shape"
      {value}
      jsonPlaceholder={'{ "id": "string", "tags": ["string"], "meta": { "size": "number" } }'}
      onChange={(next) => onChange?.(next as OutputSchemaShorthand | undefined)}
      onError={(error) => (editorError = error)}
    />
    {#if inferStatus && !editorError}
      <span class="text-xs {inferStatus.kind === "error" ? "text-destructive" : "text-muted-foreground"}"
        >{inferStatus.message}</span
      >
    {/if}
  </div>
{/if}
