<script lang="ts">
/**
 * Edits a trigger's or step's `outputSchema` shorthand: a JSON textarea plus an
 * "Infer from last run" action that fills it from the newest run's data. The
 * schema drives template autocomplete and path validation for references to
 * this node. Empty means the built-in (trigger type / step handler) schema.
 */
import MagicWandIcon from "phosphor-svelte/lib/MagicWandIcon";
import { Button } from "$lib/components/ui/button";
import { formatShorthand, type InferSource, parseShorthand } from "$lib/outputSchemaShorthand";
import { fetchInferredSchema } from "$lib/workflowEditorMeta";
import type { OutputSchemaShorthand } from "$shared/workflows";

interface Props {
  /** The current shorthand (undefined = none declared). */
  value: OutputSchemaShorthand | undefined;
  /** Read-only display (view mode). */
  readonly?: boolean;
  /** Saved workflow name; inference is unavailable for unsaved workflows. */
  workflowName?: string;
  /** Where to infer the schema from. */
  source: InferSource;
  /** Called with the new shorthand when the text is valid. */
  onChange?: (value: OutputSchemaShorthand | undefined) => void;
}

let { value, readonly = false, workflowName, source, onChange }: Props = $props();

let text = $state("");
let parseError = $state<string | null>(null);
let inferStatus = $state<{ kind: "info" | "error"; message: string } | null>(null);
let inferring = $state(false);
/** Serialized value last applied to the textarea or emitted, to detect external changes (undo/redo). */
let lastSynced: string | undefined;

$effect(() => {
  const serialized = JSON.stringify(value ?? null);
  if (serialized === lastSynced) return;
  lastSynced = serialized;
  text = formatShorthand(value);
  parseError = null;
});

/** Applies new textarea content: emits it when valid, else shows the error. */
function apply(next: string) {
  text = next;
  const result = parseShorthand(next);
  if (!result.ok) {
    parseError = result.error;
    return;
  }
  parseError = null;
  lastSynced = JSON.stringify(result.value ?? null);
  onChange?.(result.value);
}

async function infer() {
  if (!workflowName) return;
  inferring = true;
  inferStatus = null;
  try {
    const inferred = await fetchInferredSchema(workflowName, source);
    apply(formatShorthand(inferred.shorthand));
    inferStatus = {
      kind: "info",
      message: `Inferred from run ${inferred.runId.slice(0, 8)} (${new Date(inferred.runCreatedAt).toLocaleString()})`,
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
      <span class="text-xs font-medium text-muted-foreground">Output schema</span>
      <pre
        class="text-xs font-mono whitespace-pre-wrap wrap-break-word bg-muted p-3 rounded max-h-64 overflow-y-auto"
      >{formatShorthand(value)}</pre>
    </div>
  {/if}
{:else}
  <div class="flex flex-col gap-1">
    <div class="flex items-center justify-between gap-2">
      <label for="output-schema-editor" class="text-xs font-medium text-muted-foreground">Output schema</label>
      <div class="flex items-center gap-1">
        {#if text}
          <Button variant="ghost" size="xs" class="text-xs" onclick={() => apply("")}>Clear</Button>
        {/if}
        <Button
          variant="outline"
          size="xs"
          class="text-xs gap-1"
          disabled={!workflowName || inferring}
          title={workflowName ? "Fill from the newest run's data" : "Save the workflow and run it first"}
          onclick={infer}
        >
          <MagicWandIcon size={12} aria-hidden="true" />
          {inferring ? "Inferring..." : "Infer from last run"}
        </Button>
      </div>
    </div>
    <textarea
      id="output-schema-editor"
      class="min-h-24 max-h-80 px-2 py-1.5 text-xs font-mono border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
      placeholder={'{ "id": "string", "tags": ["string"], "meta": { "size": "number" } }'}
      spellcheck="false"
      value={text}
      oninput={(e) => apply((e.target as HTMLTextAreaElement).value)}
    ></textarea>
    {#if parseError}
      <span class="text-xs text-destructive">{parseError}</span>
    {:else if inferStatus}
      <span class="text-xs {inferStatus.kind === "error" ? "text-destructive" : "text-muted-foreground"}"
        >{inferStatus.message}</span
      >
    {:else}
      <span class="text-xs text-muted-foreground"
        >Describes the data for autocomplete and validation. Types: "string", "number", "boolean", "object", "any",
        nested objects, [item] arrays. Empty uses the built-in schema.</span
      >
    {/if}
  </div>
{/if}
