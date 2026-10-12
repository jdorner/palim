<!--
  Row editor for an output-schema shorthand: name, type, and a "list" flag per
  property; `object` rows nest their own property list (recursively). Rows are
  mutated in place; `onchange` is called after every edit.
-->
<script lang="ts">
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { emptyShapeRow, isPlainKey, SHAPE_FIELD_TYPES, type ShapeFieldRow } from "$lib/fieldBuilder";
import { t } from "$lib/i18n.svelte";
import ShapeFieldRows from "./ShapeFieldRows.svelte";

interface Props {
  /** The rows of this level (mutated in place). */
  rows: ShapeFieldRow[];
  /** Called after any change. */
  onchange: () => void;
}

let { rows = $bindable(), onchange }: Props = $props();

const inputClass =
  "min-w-0 px-2 py-1 text-xs border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring";

function remove(index: number) {
  rows = rows.filter((_, i) => i !== index);
  onchange();
}
</script>

{#each rows as row, i (i)}
  <div class="flex flex-col gap-1">
    <div class="flex items-center gap-1">
      <input
        class="{inputClass} flex-1 font-mono"
        aria-label={t("fieldBuilder.key")}
        placeholder={t("fieldBuilder.key")}
        autocomplete="off"
        spellcheck="false"
        value={row.key}
        oninput={(e) => {
          row.key = e.currentTarget.value;
          onchange();
        }}
      >
      <select
        class="{inputClass} w-24"
        aria-label={t("fieldBuilder.type")}
        value={row.type}
        onchange={(e) => {
          row.type = e.currentTarget.value as ShapeFieldRow["type"];
          if (row.type !== "object") row.children = [];
          onchange();
        }}
      >
        {#each SHAPE_FIELD_TYPES as type (type)}
          <option value={type}>{t(`fieldBuilder.shapeTypes.${type}`)}</option>
        {/each}
      </select>
      <label
        class="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0"
        title={t("fieldBuilder.listTitle")}
      >
        <input
          type="checkbox"
          checked={row.array}
          onchange={(e) => {
            row.array = e.currentTarget.checked;
            onchange();
          }}
        >
        {t("fieldBuilder.list")}
      </label>
      <button
        type="button"
        class="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive hover:bg-muted"
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
    {#if row.type === "object"}
      <div class="ml-2 pl-2 border-l border-border flex flex-col gap-1">
        <ShapeFieldRows bind:rows={row.children} {onchange} />
        <button
          type="button"
          class="self-start inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          onclick={() => {
            row.children = [...row.children, emptyShapeRow()];
            onchange();
          }}
        >
          <PlusIcon size={12} aria-hidden="true" />
          {t("fieldBuilder.addChild")}
        </button>
      </div>
    {/if}
  </div>
{/each}
