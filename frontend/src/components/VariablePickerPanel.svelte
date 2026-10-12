<!--
  Variable picker of the workflow editor: a panel docked beside the step panel
  that lists everything the focused template field may reference (trigger
  payload, results of preceding steps, loop variable, variables, secrets, env,
  run fields, functions) as a searchable tree. Clicking an entry inserts it at
  the field's cursor. The panel follows whichever template field has focus.
-->
<script lang="ts">
import CaretRightIcon from "phosphor-svelte/lib/CaretRightIcon";
import MagnifyingGlassIcon from "phosphor-svelte/lib/MagnifyingGlassIcon";
import XIcon from "phosphor-svelte/lib/XIcon";
import { t } from "$lib/i18n.svelte";
import { visualForStepType } from "$lib/nodeVisuals";
import { categoryForType, iconIdForType } from "$lib/stepTypes";
import { buildScopeTree, filterScopeTree, type ScopeTreeGroupId, type ScopeTreeNode } from "$lib/templateScope";
import { variablePicker } from "$lib/variablePicker.svelte";

interface Props {
  /** The step panel the picker docks to (placed to its left). */
  anchor: HTMLElement | null;
}

let { anchor }: Props = $props();

const WIDTH = 288;
const GAP = 8;
const MIN_HEIGHT = 360;
const TABS: ScopeTreeGroupId[] = ["data", "variables", "functions"];

let tab = $state<ScopeTreeGroupId>("data");
let query = $state("");
/** Expanded nodes, keyed by dotted path. */
let expanded = $state(new Set<string>());
let rect = $state<{ top: number; left: number; height: number } | null>(null);

let tree = $derived(variablePicker.target ? buildScopeTree(variablePicker.target.getConfig()) : null);
let nodes = $derived(filterScopeTree(tree?.find((g) => g.id === tab)?.nodes ?? [], query));
let searching = $derived(query.trim() !== "");

/** Tracks the anchor's position while open (it moves with the graph in the floating layout). */
$effect(() => {
  if (!variablePicker.open || !variablePicker.target || !anchor) {
    rect = null;
    return;
  }
  const el = anchor;
  let frame = 0;
  const measure = () => {
    const r = el.getBoundingClientRect();
    const left =
      r.left - WIDTH - GAP >= GAP ? r.left - WIDTH - GAP : Math.min(r.right + GAP, window.innerWidth - WIDTH - GAP);
    // At least MIN_HEIGHT tall, but always inside the viewport.
    const height = Math.min(Math.max(MIN_HEIGHT, r.height), window.innerHeight - 2 * GAP);
    const top = Math.max(GAP, Math.min(r.top, window.innerHeight - height - GAP));
    const next = { top, left, height };
    if (!rect || rect.top !== next.top || rect.left !== next.left || rect.height !== next.height) rect = next;
    frame = requestAnimationFrame(measure);
  };
  measure();
  return () => cancelAnimationFrame(frame);
});

/** The panel element (focus inside it does not count as leaving the field). */
let panelElement = $state<HTMLElement | null>(null);

/** Drops the target when focus moves elsewhere (see `variablePicker.noteFocus`). */
$effect(() => {
  const onFocusIn = (e: FocusEvent) => {
    const el = e.target;
    if (!(el instanceof Element) || panelElement?.contains(el)) return;
    variablePicker.noteFocus(el);
  };
  document.addEventListener("focusin", onFocusIn);
  return () => document.removeEventListener("focusin", onFocusIn);
});

function keyOf(node: ScopeTreeNode): string {
  return `${node.kind}:${node.path.join(".")}`;
}

function toggle(node: ScopeTreeNode) {
  const key = keyOf(node);
  const next = new Set(expanded);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded = next;
}

function insert(node: ScopeTreeNode) {
  variablePicker.insert(node.kind === "function" ? node.label : node.path.join("."), node.kind);
}

function stepVisual(type: string) {
  return visualForStepType(type, { iconId: iconIdForType(type), category: categoryForType(type) });
}

/** Moves the panel to the document body, so transformed ancestors do not clip it. */
function portal(node: HTMLElement) {
  document.body.appendChild(node);
  return { destroy: () => node.remove() };
}
</script>

{#snippet treeRows(
  list: ScopeTreeNode[],
  depth: number,
)}
  {#each list as node (keyOf(node))}
    {@const open = searching || expanded.has(keyOf(node))}
    <div class="flex items-center gap-1 py-0.5 min-w-0" style="padding-left: {depth * 14}px">
      {#if node.children}
        <button
          type="button"
          class="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          aria-expanded={open}
          aria-label={node.label}
          onmousedown={(e) => e.preventDefault()}
          onclick={() => toggle(node)}
        >
          <CaretRightIcon size={11} aria-hidden="true" class="transition-transform {open ? "rotate-90" : ""}" />
        </button>
      {:else}
        <span class="w-4 shrink-0"></span>
      {/if}
      {#if node.stepType}
        {@const v = stepVisual(node.stepType)}
        <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-white {v.tileClass}">
          <v.icon size={10} weight="bold" aria-hidden="true" />
        </span>
      {:else if depth === 0 && node.label === "trigger"}
        {@const v = visualForStepType("trigger")}
        <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-white {v.tileClass}">
          <v.icon size={10} weight="bold" aria-hidden="true" />
        </span>
      {/if}
      <button
        type="button"
        class="min-w-0 truncate rounded px-1.5 py-0.5 font-mono text-[11px] bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground transition-colors"
        title={node.description ?? (node.kind === "function" ? node.label : `{{${node.path.join(".")}}}`)}
        onmousedown={(e) => e.preventDefault()}
        onclick={() => insert(node)}
      >
        {node.kind === "function" ? `${node.label}()` : node.label}
      </button>
      {#if node.kind === "function" && node.signature}
        <span class="truncate text-[10px] text-muted-foreground font-mono">{node.signature}</span>
      {:else if node.schemaType}
        <span class="shrink-0 text-[10px] text-muted-foreground"
          >{node.schemaType === "array" ? "[ ]" : node.schemaType}</span
        >
      {/if}
    </div>
    {#if node.children && open}
      {@render treeRows(node.children, depth + 1)}
    {/if}
  {/each}
{/snippet}

{#if variablePicker.open && variablePicker.target && rect}
  <div
    use:portal
    bind:this={panelElement}
    class="fixed z-50 flex flex-col rounded-lg border border-border bg-background shadow-xl"
    style="top: {rect.top}px; left: {rect.left}px; width: {WIDTH}px; height: {rect.height}px;"
    role="dialog"
    aria-label={t("variablePicker.title")}
    tabindex="-1"
    onkeydown={(e) => {
      if (e.key === "Escape") variablePicker.open = false;
    }}
  >
    <div class="flex items-center gap-2 border-b border-border px-3 py-2">
      <span class="flex-1 text-sm font-semibold">{t("variablePicker.title")}</span>
      <button
        type="button"
        class="text-[11px] text-muted-foreground hover:text-foreground"
        onmousedown={(e) => e.preventDefault()}
        onclick={() => (expanded = new Set())}
      >
        {t("variablePicker.collapseAll")}
      </button>
      <button
        type="button"
        class="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted"
        aria-label={t("common.close")}
        onclick={() => (variablePicker.open = false)}
      >
        <XIcon size={14} aria-hidden="true" />
      </button>
    </div>

    <div class="px-3 pt-2 flex flex-col gap-2">
      <label class="relative block">
        <MagnifyingGlassIcon
          size={13}
          class="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          type="search"
          class="w-full rounded-md border border-border bg-background py-1 pl-7 pr-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          placeholder={t("variablePicker.search")}
          aria-label={t("variablePicker.search")}
          bind:value={query}
        >
      </label>
      <div class="flex gap-1 border-b border-border" role="tablist">
        {#each TABS as id (id)}
          <button
            type="button"
            role="tab"
            aria-selected={tab === id}
            class="-mb-px border-b-2 px-2 py-1 text-xs {tab === id
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"}"
            onmousedown={(e) => e.preventDefault()}
            onclick={() => (tab = id)}
          >
            {t(`variablePicker.tabs.${id}`)}
          </button>
        {/each}
      </div>
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto px-2 py-2" role="tabpanel">
      {#if nodes.length === 0}
        <p class="px-1 text-xs text-muted-foreground">
          {searching ? t("variablePicker.noMatches") : t("variablePicker.empty")}
        </p>
      {:else}
        {@render treeRows(nodes, 0)}
      {/if}
    </div>
    <p class="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">{t("variablePicker.hint")}</p>
  </div>
{/if}
