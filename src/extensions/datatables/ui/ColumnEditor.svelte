<script lang="ts">
import { useI18n } from "@ext/ui";
/**
 * Editable column list: label, key, type, flags, default, key column, order.
 * With `headers`, each column also picks its source column from an imported file.
 */
import { Button, Checkbox, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@palim/ui";
import ArrowDownIcon from "phosphor-svelte/lib/ArrowDownIcon";
import ArrowUpIcon from "phosphor-svelte/lib/ArrowUpIcon";
import PlusIcon from "phosphor-svelte/lib/PlusIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { COLUMN_TYPE_LABELS, COLUMN_TYPES, MAX_COLUMNS, slugify } from "../types";
import { type EditableColumn, INPUT_CLASS, nextUid } from "./api";

let {
  columns = $bindable(),
  keyColumn = $bindable(),
  headers,
}: {
  columns: EditableColumn[];
  keyColumn: string;
  /** File headers (import mode): adds a "Source" column. */
  headers?: string[];
} = $props();

const i18n = useI18n();

const keyOf = (label: string, index: number) => {
  const base = slugify(label);
  return /^[a-z]/.test(base) ? base : base ? `c_${base}` : `column_${index + 1}`;
};

function setLabel(col: EditableColumn, index: number, label: string) {
  const wasKey = keyColumn === col.key;
  col.label = label;
  if (col.autoKey) {
    col.key = keyOf(label, index);
    if (wasKey) keyColumn = col.key;
  }
}

function setKey(col: EditableColumn, key: string) {
  const wasKey = keyColumn === col.key;
  col.key = key;
  col.autoKey = false;
  if (wasKey) keyColumn = key;
}

function add() {
  const index = columns.length;
  columns.push({ uid: nextUid(), key: `column_${index + 1}`, label: "", type: "text", autoKey: true, source: null });
}

function remove(index: number) {
  const [removed] = columns.splice(index, 1);
  if (removed && removed.key === keyColumn) keyColumn = "";
}

function move(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= columns.length) return;
  const [col] = columns.splice(index, 1);
  if (col) columns.splice(target, 0, col);
}

const duplicateKeys = $derived(new Set(columns.map((c) => c.key).filter((key, i, all) => all.indexOf(key) !== i)));
</script>

<div class="rounded-md border border-border">
  <Table>
    <TableHeader class="bg-muted/30">
      <TableRow class="hover:bg-transparent">
        {#if headers}
          <TableHead>{$i18n.t("columns.source")}</TableHead>
        {/if}
        <TableHead>{$i18n.t("columns.label")}</TableHead>
        <TableHead>{$i18n.t("columns.key")}</TableHead>
        <TableHead>{$i18n.t("columns.type")}</TableHead>
        <TableHead class="text-center" title={$i18n.t("columns.requiredTitle")}
          >{$i18n.t("columns.required")}</TableHead
        >
        <TableHead class="text-center" title={$i18n.t("columns.uniqueTitle")}>{$i18n.t("columns.unique")}</TableHead>
        <TableHead class="text-center" title={$i18n.t("columns.keyTitle")}>{$i18n.t("columns.key")}</TableHead>
        <TableHead>{$i18n.t("columns.default")}</TableHead>
        <TableHead><span class="sr-only">{$i18n.t("columns.actions")}</span></TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each columns as col, i (col.uid)}
        <TableRow class="hover:bg-transparent">
          {#if headers}
            <TableCell class="px-2 py-2">
              <select
                class={INPUT_CLASS}
                aria-label={$i18n.t("columns.sourceColumn")}
                value={col.source ?? ""}
                onchange={(e) => (col.source = e.currentTarget.value === "" ? null : Number(e.currentTarget.value))}
              >
                <option value="">{$i18n.t("columns.empty")}</option>
                {#each headers as header, h (h)}
                  <option value={h}>{header}</option>
                {/each}
              </select>
            </TableCell>
          {/if}
          <TableCell class="px-2 py-2">
            <input
              class={INPUT_CLASS}
              aria-label={$i18n.t("columns.columnLabel")}
              placeholder={$i18n.t("columns.label")}
              value={col.label}
              oninput={(e) => setLabel(col, i, e.currentTarget.value)}
            >
          </TableCell>
          <TableCell class="px-2 py-2">
            <input
              class="{INPUT_CLASS} font-mono {duplicateKeys.has(col.key) || !/^[a-z][a-z0-9_]*$/.test(col.key)
                ? "border-destructive"
                : ""}"
              aria-label={$i18n.t("columns.columnKey")}
              value={col.key}
              title={col.originalKey && col.originalKey !== col.key
                ? $i18n.t("columns.renamedFrom", { key: col.originalKey })
                : undefined}
              oninput={(e) => setKey(col, e.currentTarget.value)}
            >
          </TableCell>
          <TableCell class="px-2 py-2">
            <select class={INPUT_CLASS} aria-label={$i18n.t("columns.columnType")} bind:value={col.type}>
              {#each COLUMN_TYPES as type (type)}
                <option value={type}>{$i18n.t(`columnTypes.${type}`, { default: COLUMN_TYPE_LABELS[type] })}</option>
              {/each}
            </select>
          </TableCell>
          <TableCell class="px-2 py-2"
            ><div class="flex justify-center">
              <Checkbox
                aria-label={$i18n.t("columns.requiredAria")}
                checked={col.required === true || keyColumn === col.key}
                disabled={keyColumn === col.key}
                onCheckedChange={(v) => (col.required = v === true)}
              />
            </div></TableCell
          >
          <TableCell class="px-2 py-2"
            ><div class="flex justify-center">
              <Checkbox
                aria-label={$i18n.t("columns.uniqueAria")}
                checked={col.unique === true || keyColumn === col.key}
                disabled={keyColumn === col.key}
                onCheckedChange={(v) => (col.unique = v === true)}
              />
            </div></TableCell
          >
          <TableCell class="px-2 py-2"
            ><div class="flex justify-center">
              <input
                type="radio"
                class="h-4 w-4 accent-primary"
                name="key-column"
                aria-label={$i18n.t("columns.keyColumn")}
                checked={keyColumn === col.key}
                onclick={() => (keyColumn = keyColumn === col.key ? "" : col.key)}
              >
            </div></TableCell
          >
          <TableCell class="px-2 py-2">
            <input
              class={INPUT_CLASS}
              aria-label={$i18n.t("columns.defaultValue")}
              placeholder={col.type === "boolean" ? "true / false" : ""}
              value={col.default === undefined || col.default === null ? "" : String(col.default)}
              oninput={(e) => (col.default = e.currentTarget.value === "" ? undefined : e.currentTarget.value)}
            >
          </TableCell>
          <TableCell class="whitespace-nowrap px-2 py-2 text-right">
            <button
              type="button"
              class="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30"
              aria-label={$i18n.t("columns.moveUp")}
              disabled={i === 0}
              onclick={() => move(i, -1)}
            >
              <ArrowUpIcon size={14} />
            </button>
            <button
              type="button"
              class="rounded p-1 text-muted-foreground hover:bg-accent disabled:opacity-30"
              aria-label={$i18n.t("columns.moveDown")}
              disabled={i === columns.length - 1}
              onclick={() => move(i, 1)}
            >
              <ArrowDownIcon size={14} />
            </button>
            <button
              type="button"
              class="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              aria-label={$i18n.t("columns.removeColumn")}
              onclick={() => remove(i)}
            >
              <TrashIcon size={14} />
            </button>
          </TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
</div>
<div class="flex items-center justify-between">
  <Button size="sm" variant="outline" disabled={columns.length >= MAX_COLUMNS} onclick={add}>
    <PlusIcon size={14} class="mr-1.5" aria-hidden="true" />{$i18n.t("columns.addColumn")}
  </Button>
  {#if duplicateKeys.size > 0}
    <span class="text-sm text-destructive"
      >{$i18n.t("columns.duplicateKeys", { keys: [...duplicateKeys].join(", ") })}</span
    >
  {/if}
</div>
