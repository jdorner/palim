<!--
  Row editor for a flat form schema (portal fields, humanTask form): one
  collapsible card per field with name, input type, and required flag; the
  details hold label, help text, default, select options, and reordering.
  Rows are mutated in place; `onchange` is called after every edit.
-->
<script lang="ts" module>
import type { FormFieldRow } from "$lib/fieldBuilder";

/** A row plus editor-only state. */
export type FormRowState = FormFieldRow & { uid: number; open: boolean };
</script>

<script lang="ts">
import ArrowDownIcon from "phosphor-svelte/lib/ArrowDownIcon";
import ArrowUpIcon from "phosphor-svelte/lib/ArrowUpIcon";
import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { FORM_FIELD_TYPES, isPlainKey } from "$lib/fieldBuilder";
import { t } from "$lib/i18n.svelte";

interface Props {
  /** The rows (mutated in place). */
  rows: FormRowState[];
  /** Prefix for element ids. */
  idPrefix: string;
  /** Called after any change. */
  onchange: () => void;
}

let { rows = $bindable(), idPrefix, onchange }: Props = $props();

const inputClass =
  "min-w-0 px-2 py-1 text-xs border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring";
const iconButton =
  "shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40";

function update(row: FormRowState, patch: Partial<FormFieldRow>) {
  Object.assign(row, patch);
  onchange();
}

function setType(row: FormRowState, type: FormFieldRow["type"]) {
  // A default only carries over between the text-like types.
  const textLike = (k: string) => k === "text" || k === "textarea" || k === "date";
  const keepDefault = textLike(row.type) && textLike(type);
  update(row, {
    type,
    default: keepDefault ? row.default : "",
    options: type === "select" && row.options.length === 0 ? [{ value: "", label: "" }] : row.options,
  });
  if (type === "select") row.open = true;
}

function move(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= rows.length) return;
  const next = [...rows];
  [next[index], next[target]] = [next[target]!, next[index]!];
  rows = next;
  onchange();
}

function remove(index: number) {
  rows = rows.filter((_, i) => i !== index);
  onchange();
}
</script>

{#each rows as row, i (row.uid)}
  {@const id = `${idPrefix}-${row.uid}`}
  <div class="rounded-md border border-border p-1.5 flex flex-col gap-1.5">
    <div class="flex items-center gap-1">
      <button
        type="button"
        class={iconButton}
        aria-expanded={row.open}
        aria-controls="{id}-details"
        aria-label={t("fieldBuilder.details")}
        title={t("fieldBuilder.details")}
        onclick={() => (row.open = !row.open)}
      >
        <CaretRightIcon size={12} aria-hidden="true" class="transition-transform {row.open ? "rotate-90" : ""}" />
      </button>
      <input
        class="{inputClass} flex-1 font-mono"
        aria-label={t("fieldBuilder.key")}
        placeholder={t("fieldBuilder.key")}
        autocomplete="off"
        spellcheck="false"
        value={row.key}
        oninput={(e) => update(row, { key: e.currentTarget.value })}
      >
      <select
        class="{inputClass} w-28"
        aria-label={t("fieldBuilder.type")}
        value={row.type}
        onchange={(e) => setType(row, e.currentTarget.value as FormFieldRow["type"])}
      >
        {#each FORM_FIELD_TYPES as type (type)}
          <option value={type}>{t(`fieldBuilder.types.${type}`)}</option>
        {/each}
      </select>
      <button
        type="button"
        class="shrink-0 w-6 h-6 rounded-md border text-sm font-semibold leading-none {row.required
          ? "border-destructive/50 bg-destructive/10 text-destructive"
          : "border-border text-muted-foreground hover:text-foreground"}"
        aria-pressed={row.required}
        aria-label={t("fieldBuilder.required")}
        title={t("fieldBuilder.required")}
        onclick={() => update(row, { required: !row.required })}
      >
        *
      </button>
      <button
        type="button"
        class="{iconButton} hover:text-destructive"
        aria-label={t("fieldBuilder.removeField")}
        title={t("fieldBuilder.removeField")}
        onclick={() => remove(i)}
      >
        <TrashIcon size={12} aria-hidden="true" />
      </button>
    </div>
    {#if row.key && !isPlainKey(row.key.trim())}
      <span class="text-[11px] text-muted-foreground px-1">{t("fieldBuilder.keyHint")}</span>
    {/if}

    {#if row.open}
      <div id="{id}-details" class="flex flex-col gap-1.5 pl-6">
        <div class="grid grid-cols-[5.5rem_1fr] items-center gap-x-2 gap-y-1.5">
          <label for="{id}-label" class="text-[11px] text-muted-foreground">{t("fieldBuilder.label")}</label>
          <input
            id="{id}-label"
            class={inputClass}
            placeholder={row.key}
            value={row.label}
            oninput={(e) => update(row, { label: e.currentTarget.value })}
          >
          <label for="{id}-description" class="text-[11px] text-muted-foreground"
            >{t("fieldBuilder.description")}</label
          >
          <input
            id="{id}-description"
            class={inputClass}
            value={row.description}
            oninput={(e) => update(row, { description: e.currentTarget.value })}
          >
          <label for="{id}-default" class="text-[11px] text-muted-foreground">{t("fieldBuilder.default")}</label>
          {#if row.type === "boolean"}
            <select
              id="{id}-default"
              class={inputClass}
              value={row.default}
              onchange={(e) => update(row, { default: e.currentTarget.value })}
            >
              <option value="">{t("fieldBuilder.defaultNone")}</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          {:else if row.type === "select"}
            <select
              id="{id}-default"
              class={inputClass}
              value={row.default}
              onchange={(e) => update(row, { default: e.currentTarget.value })}
            >
              <option value="">{t("fieldBuilder.defaultNone")}</option>
              {#each row.options.filter((o) => o.value !== "") as option (option.value)}
                <option value={option.value}>{option.label || option.value}</option>
              {/each}
            </select>
          {:else}
            <input
              id="{id}-default"
              class={inputClass}
              type={row.type === "date" ? "date" : row.type === "number" || row.type === "integer" ? "number" : "text"}
              step={row.type === "integer" ? "1" : "any"}
              value={row.default}
              oninput={(e) => update(row, { default: e.currentTarget.value })}
            >
          {/if}
        </div>

        {#if row.type === "select"}
          <div class="flex flex-col gap-1">
            <span class="text-[11px] text-muted-foreground">{t("fieldBuilder.options")}</span>
            {#each row.options as option, oi (oi)}
              <div class="flex items-center gap-1">
                <input
                  class="{inputClass} flex-1 font-mono"
                  aria-label={t("fieldBuilder.optionValue")}
                  placeholder={t("fieldBuilder.optionValue")}
                  value={option.value}
                  oninput={(e) => {
                    option.value = e.currentTarget.value;
                    onchange();
                  }}
                >
                <input
                  class="{inputClass} flex-1"
                  aria-label={t("fieldBuilder.optionLabel")}
                  placeholder={t("fieldBuilder.optionLabel")}
                  value={option.label}
                  oninput={(e) => {
                    option.label = e.currentTarget.value;
                    onchange();
                  }}
                >
                <button
                  type="button"
                  class="{iconButton} hover:text-destructive"
                  aria-label={t("fieldBuilder.removeOption")}
                  title={t("fieldBuilder.removeOption")}
                  onclick={() => update(row, { options: row.options.filter((_, j) => j !== oi) })}
                >
                  <TrashIcon size={12} aria-hidden="true" />
                </button>
              </div>
            {/each}
            <button
              type="button"
              class="self-start inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              onclick={() => update(row, { options: [...row.options, { value: "", label: "" }] })}
            >
              <PlusIcon size={12} aria-hidden="true" />
              {t("fieldBuilder.addOption")}
            </button>
          </div>
        {/if}

        <div class="flex items-center gap-1">
          <button
            type="button"
            class={iconButton}
            disabled={i === 0}
            aria-label={t("fieldBuilder.moveUp")}
            title={t("fieldBuilder.moveUp")}
            onclick={() => move(i, -1)}
          >
            <ArrowUpIcon size={12} aria-hidden="true" />
          </button>
          <button
            type="button"
            class={iconButton}
            disabled={i === rows.length - 1}
            aria-label={t("fieldBuilder.moveDown")}
            title={t("fieldBuilder.moveDown")}
            onclick={() => move(i, 1)}
          >
            <ArrowDownIcon size={12} aria-hidden="true" />
          </button>
        </div>
      </div>
    {/if}
  </div>
{/each}
