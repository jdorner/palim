<!--
  Field builder for the schemas the workflow editor used to take as raw JSON:
  `mode="form"` edits a flat JSON Schema object (portal trigger fields,
  humanTask form), `mode="shape"` an output-schema shorthand. An "Edit as
  JSON" toggle keeps the raw view; values the rows cannot represent exactly
  open in it automatically, so no keyword is dropped. Only valid values are
  emitted; the current error (or null) is reported through `onError`.
-->
<script lang="ts">
import BracketsCurlyIcon from "phosphor-svelte/lib/BracketsCurlyIcon";
import ListBulletsIcon from "phosphor-svelte/lib/ListBulletsIcon";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import { untrack } from "svelte";
import {
  emptyFormRow,
  emptyShapeRow,
  type FormFieldRow,
  formRowsToSchema,
  type RowsResult,
  type ShapeFieldRow,
  schemaToFormRows,
  shapeRowsToShorthand,
  shorthandToShapeRows,
  validateFormRows,
  validateShapeRows,
} from "$lib/fieldBuilder";
import { t } from "$lib/i18n.svelte";
import { formatShorthand, parseShorthand } from "$lib/outputSchemaShorthand";
import type { OutputSchemaShorthand } from "$shared/workflows";
import ExpandButton from "./ExpandButton.svelte";
import ExpandedTextEditor from "./ExpandedTextEditor.svelte";
import FormFieldRows, { type FormRowState } from "./fieldBuilder/FormFieldRows.svelte";
import ShapeFieldRows from "./fieldBuilder/ShapeFieldRows.svelte";

type Value = Record<string, unknown> | undefined;

interface Props {
  /** `form`: flat JSON Schema object; `shape`: output-schema shorthand. */
  mode: "form" | "shape";
  /** The current value (undefined = none). */
  value: Value;
  /** Prefix for element ids. */
  id: string;
  /** Id of the caller's caption element, naming the field list for assistive tech. */
  labelledBy?: string;
  /** Read-only display. */
  readonly?: boolean;
  /** Placeholder of the JSON view. */
  jsonPlaceholder?: string;
  /** Called with each new valid value. */
  onChange?: (value: Value) => void;
  /** Called when the error state changes (null = valid). */
  onError?: (error: string | null) => void;
}

let { mode, value, id, labelledBy, readonly = false, jsonPlaceholder, onChange, onError }: Props = $props();

let formRows = $state<FormRowState[]>([]);
let shapeRows = $state<ShapeFieldRow[]>([]);
let jsonMode = $state(false);
let jsonText = $state("");

/** Whether the JSON text is open in the large editor dialog. */
let jsonExpanded = $state(false);
let jsonError = $state<string | null>(null);
let rowError = $state<string | null>(null);
/** Why the current value cannot be edited as rows (null = it can). */
let fallbackReason = $state<string | null>(null);

/** The last valid value received or emitted. */
let current: Value;
/** Serialized {@link current}, to tell external changes (undo) from our own. */
let lastSynced: string | undefined;
/** The error last reported through `onError`. */
let lastReported: string | null = null;
let nextUid = 0;

function toRows(v: Value): RowsResult<FormFieldRow | ShapeFieldRow> {
  return mode === "form" ? schemaToFormRows(v) : shorthandToShapeRows(v as OutputSchemaShorthand | undefined);
}

function format(v: Value): string {
  if (mode === "shape") return formatShorthand(v as OutputSchemaShorthand | undefined);
  return v ? JSON.stringify(v, null, 2) : "";
}

/** Loads rows from a value; returns false (and records why) when it cannot be represented. */
function loadRows(v: Value): boolean {
  const result = toRows(v);
  if (!result.ok) {
    fallbackReason = result.reason;
    return false;
  }
  fallbackReason = null;
  if (mode === "form") {
    formRows = (result.rows as FormFieldRow[]).map((row) => ({ ...row, uid: nextUid++, open: false }));
  } else {
    shapeRows = result.rows as ShapeFieldRow[];
  }
  return true;
}

function report(error: string | null) {
  if (error === lastReported) return;
  lastReported = error;
  onError?.(error);
}

function commit(next: Value) {
  current = next;
  lastSynced = JSON.stringify(next ?? null);
  onChange?.(next);
}

$effect(() => {
  const serialized = JSON.stringify(value ?? null);
  if (serialized === lastSynced) return;
  lastSynced = serialized;
  untrack(() => {
    current = value;
    jsonText = format(value);
    jsonError = null;
    rowError = null;
    if (!loadRows(value)) jsonMode = true;
    report(null);
  });
});

function emitRows() {
  const error = mode === "form" ? validateFormRows(formRows) : validateShapeRows(shapeRows);
  rowError = error;
  report(error);
  if (error) return;
  commit(mode === "form" ? formRowsToSchema(formRows) : shapeRowsToShorthand(shapeRows));
}

function onJsonInput(text: string) {
  jsonText = text;
  let next: Value;
  if (mode === "shape") {
    const result = parseShorthand(text);
    if (!result.ok) {
      jsonError = result.error;
      report(result.error);
      return;
    }
    next = result.value;
  } else if (text.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      jsonError = t("fieldBuilder.invalidJson", { error: err instanceof Error ? err.message : String(err) });
      report(jsonError);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      jsonError = t("fieldBuilder.mustBeObject");
      report(jsonError);
      return;
    }
    next = parsed as Record<string, unknown>;
  }
  jsonError = null;
  report(null);
  const result = toRows(next);
  fallbackReason = result.ok ? null : result.reason;
  commit(next);
}

function showJson() {
  jsonText = format(current);
  jsonError = null;
  rowError = null;
  report(null);
  jsonMode = true;
}

function showRows() {
  if (jsonError || !loadRows(current)) return;
  rowError = null;
  jsonMode = false;
}

function addRow() {
  if (mode === "form") formRows = [...formRows, { ...emptyFormRow(), uid: nextUid++, open: false }];
  else shapeRows = [...shapeRows, emptyShapeRow()];
}

/** Rows for the read-only view (null when the value cannot be shown as rows). */
let viewRows = $derived(readonly ? toRows(value) : null);
let formViewRows = $derived(viewRows?.ok && mode === "form" ? (viewRows.rows as FormFieldRow[]) : null);
let shapeViewRows = $derived(viewRows?.ok && mode === "shape" ? (viewRows.rows as ShapeFieldRow[]) : null);
</script>

{#snippet shapeView(
  rows: ShapeFieldRow[],
)}
  <ul class="flex flex-col gap-0.5">
    {#each rows as row, i (i)}
      <li class="text-xs">
        <span class="font-mono">{row.key}</span>
        <span class="text-muted-foreground"
          >{t(`fieldBuilder.shapeTypes.${row.type}`)}{row.array ? ` (${t("fieldBuilder.list")})` : ""}</span
        >
        {#if row.children.length > 0}
          <div class="ml-2 pl-2 border-l border-border">{@render shapeView(row.children)}</div>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

{#if readonly}
  {#if formViewRows}
    <ul class="flex flex-col gap-0.5">
      {#each formViewRows as row (row.key)}
        <li class="text-xs">
          <span class="font-mono">{row.key}</span>{row.required ? " *" : ""}
          <span class="text-muted-foreground">{t(`fieldBuilder.types.${row.type}`)}</span>
          {#if row.label}
            <span class="text-muted-foreground">· {row.label}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if shapeViewRows}
    {@render shapeView(shapeViewRows)}
  {:else}
    <pre
      class="text-xs font-mono whitespace-pre-wrap wrap-break-word bg-muted p-3 rounded max-h-64 overflow-y-auto"
    >{format(value)}</pre>
  {/if}
{:else}
  <fieldset class="flex flex-col gap-1.5 min-w-0" aria-labelledby={labelledBy}>
    {#if jsonMode}
      {#if fallbackReason}
        <span class="text-xs text-muted-foreground">{t("fieldBuilder.jsonFallback", { reason: fallbackReason })}</span>
      {/if}
      <textarea
        aria-label={t("fieldBuilder.editAsJson")}
        class="min-h-24 max-h-80 px-2 py-1.5 text-xs font-mono border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
        rows="6"
        spellcheck="false"
        placeholder={jsonPlaceholder}
        value={jsonText}
        oninput={(e) => onJsonInput(e.currentTarget.value)}
      ></textarea>
    {:else if mode === "form"}
      <FormFieldRows bind:rows={formRows} idPrefix={id} onchange={emitRows} />
    {:else}
      <ShapeFieldRows bind:rows={shapeRows} onchange={emitRows} />
    {/if}

    <div class="flex items-center justify-between gap-2">
      {#if jsonMode}
        <ExpandButton label={t("fieldBuilder.editAsJson")} onclick={() => (jsonExpanded = true)} />
      {:else}
        <button
          type="button"
          class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onclick={addRow}
        >
          <PlusIcon size={12} aria-hidden="true" />
          {t("fieldBuilder.addField")}
        </button>
      {/if}
      {#if jsonMode}
        <button
          type="button"
          class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:pointer-events-none"
          disabled={!!jsonError || !!fallbackReason}
          onclick={showRows}
        >
          <ListBulletsIcon size={12} aria-hidden="true" />
          {t("fieldBuilder.editAsRows")}
        </button>
      {:else}
        <button
          type="button"
          class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onclick={showJson}
        >
          <BracketsCurlyIcon size={12} aria-hidden="true" />
          {t("fieldBuilder.editAsJson")}
        </button>
      {/if}
    </div>

    {#if jsonMode ? jsonError : rowError}
      <span class="text-xs text-destructive">{jsonMode ? jsonError : rowError}</span>
    {/if}
  </fieldset>
  {#if jsonMode && jsonExpanded}
    <ExpandedTextEditor
      title={t("fieldBuilder.editAsJson")}
      value={jsonText}
      oninput={onJsonInput}
      onClose={() => (jsonExpanded = false)}
      placeholder={jsonPlaceholder}
    />
  {/if}
{/if}
