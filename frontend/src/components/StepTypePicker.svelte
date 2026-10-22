<script lang="ts">
/**
 * Shared step type picker menu content.
 * Renders a filter field, the available step types grouped by category (Steps +
 * Control Flow), and a detail pane describing the highlighted type. Keyboard:
 * typing filters, ArrowUp/ArrowDown/Home/End move, Enter picks, Escape closes.
 * Used by both AddStepNode (the dashed circle menu) and the edge insert popup.
 */
import MagnifyingGlassIcon from "phosphor-svelte/lib/MagnifyingGlassIcon";
import { onMount } from "svelte";
import { t } from "$lib/i18n.svelte";
import { identity } from "$lib/identity.svelte";
import { visualForStepType } from "$lib/nodeVisuals";
import {
  buildPickerSections,
  filterPickerSections,
  movePickerIndex,
  type PickerSection,
  type PickerStepType,
} from "$lib/stepTypePicker";

interface Props {
  /** Custom step types from extensions. */
  customStepTypes: PickerStepType[];
  /** Called when a type is selected. */
  onselect: (type: string) => void;
  /** Called when the picker is dismissed with Escape. */
  onclose: () => void;
  /** Whether to include control-flow types (iterator, if, case, etc.). Default: true. */
  includeControlFlow?: boolean;
}

let { customStepTypes, onselect, onclose, includeControlFlow = true }: Props = $props();

const uid = $props.id();

const builtinTypes = $derived<PickerStepType[]>([
  { type: "agent", label: t("stepType.agent"), description: t("stepType.description.agent"), category: "execution" },
  {
    type: "iterator",
    label: t("stepType.iterator"),
    description: t("stepType.description.iterator"),
    category: "control-flow",
  },
  { type: "if", label: t("stepType.ifCondition"), description: t("stepType.description.if"), category: "control-flow" },
  {
    type: "case",
    label: t("stepType.caseSwitch"),
    description: t("stepType.description.case"),
    category: "control-flow",
  },
  {
    type: "waitFor",
    label: t("stepType.waitForSignal"),
    description: t("stepType.description.waitFor"),
    category: "control-flow",
  },
  {
    type: "humanTask",
    label: t("stepType.humanTask"),
    description: t("stepType.description.humanTask"),
    category: "control-flow",
  },
  {
    type: "emit",
    label: t("stepType.emitSignal"),
    description: t("stepType.description.emit"),
    category: "control-flow",
  },
]);

const SECTION_TITLE_KEYS = {
  steps: "stepType.sectionSteps",
  "control-flow": "stepType.sectionControlFlow",
} as const satisfies Record<PickerSection["id"], string>;

let query = $state("");
let activeIndex = $state(0);
let inputEl = $state<HTMLInputElement | null>(null);
let listEl = $state<HTMLDivElement | null>(null);

let sections = $derived(
  filterPickerSections(
    buildPickerSections(builtinTypes, customStepTypes, { includeControlFlow, hitlEnabled: identity.hitlEnabled }),
    query,
  ),
);
/** Sections with the flat index of their first item, for keyboard navigation. */
let rows = $derived.by(() => {
  let offset = 0;
  return sections.map((section) => {
    const start = offset;
    offset += section.items.length;
    return { section, start };
  });
});
let flatItems = $derived(sections.flatMap((s) => s.items));
let activeItem = $derived(flatItems[activeIndex] as PickerStepType | undefined);
let activeVisual = $derived(
  activeItem ? visualForStepType(activeItem.type, { iconId: activeItem.icon, category: activeItem.category }) : null,
);

onMount(() => {
  inputEl?.focus({ preventScroll: true });
});

// Keep the highlighted entry visible while moving through the list by keyboard.
$effect(() => {
  listEl?.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
});

function optionId(index: number): string {
  return `${uid}-option-${index}`;
}

function handleKeydown(e: KeyboardEvent) {
  switch (e.key) {
    case "ArrowDown":
    case "ArrowUp":
      e.preventDefault();
      activeIndex = movePickerIndex(activeIndex, e.key === "ArrowDown" ? 1 : -1, flatItems.length);
      break;
    case "Home":
    case "End":
      if (flatItems.length === 0) return;
      e.preventDefault();
      activeIndex = e.key === "Home" ? 0 : flatItems.length - 1;
      break;
    case "Enter":
      e.preventDefault();
      if (activeItem) onselect(activeItem.type);
      break;
    case "Escape":
      // Keep the page from treating this Escape as "leave edit mode".
      e.preventDefault();
      e.stopPropagation();
      onclose();
      break;
  }
}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex gap-1.5" onkeydown={handleKeydown}>
  <div class="flex w-56 flex-col">
    <div class="relative mb-1">
      <MagnifyingGlassIcon
        size={14}
        class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <input
        bind:this={inputEl}
        bind:value={query}
        oninput={() => (activeIndex = 0)}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="{uid}-listbox"
        aria-activedescendant={activeItem ? optionId(activeIndex) : undefined}
        aria-autocomplete="list"
        autocomplete="off"
        spellcheck="false"
        placeholder={t("stepType.filterPlaceholder")}
        class="w-full rounded-lg border border-border bg-background py-1.5 pl-8 pr-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
    </div>

    <div bind:this={listEl} id="{uid}-listbox" role="listbox" class="max-h-72 overflow-y-auto">
      {#each rows as { section, start }, sectionIndex (section.id)}
        {#if sectionIndex > 0}
          <div class="border-t border-border my-1"></div>
        {/if}
        <div
          role="presentation"
          class="px-2 pt-1 pb-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide"
        >
          {t(SECTION_TITLE_KEYS[section.id])}
        </div>
        {#each section.items as item, i (item.type)}
          {@const index = start + i}
          {@const visual = visualForStepType(item.type, { iconId: item.icon, category: item.category })}
          <button
            type="button"
            id={optionId(index)}
            data-index={index}
            role="option"
            aria-selected={index === activeIndex}
            tabindex="-1"
            class="w-full text-left px-2 py-1.5 rounded-lg transition-colors flex items-center gap-2.5 {index ===
            activeIndex
              ? "bg-muted"
              : ""}"
            onmousemove={() => (activeIndex = index)}
            onclick={() => onselect(item.type)}
          >
            <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-white {visual.tileClass}">
              <visual.icon size={15} weight="bold" aria-hidden="true" />
            </span>
            <span class="min-w-0">
              <span class="block font-medium text-foreground">{item.label}</span>
              {#if item.description}
                <!-- Narrow screens have no detail pane, so show the description inline. -->
                <span class="line-clamp-2 text-xs text-muted-foreground sm:hidden">{item.description}</span>
              {/if}
            </span>
          </button>
        {/each}
      {:else}
        <div class="px-2 py-3 text-center text-xs text-muted-foreground">{t("stepType.noMatches")}</div>
      {/each}
    </div>
  </div>

  {#if activeItem && activeVisual}
    <div class="hidden w-56 flex-col gap-2 border-l border-border py-1 pl-3 pr-1.5 sm:flex" aria-live="polite">
      <div class="flex items-center gap-2.5">
        <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white {activeVisual.tileClass}">
          <activeVisual.icon size={18} weight="bold" aria-hidden="true" />
        </span>
        <div class="min-w-0">
          <div class="font-semibold text-foreground">{activeItem.label}</div>
          <div class="truncate font-mono text-[11px] text-muted-foreground">{activeItem.type}</div>
        </div>
      </div>
      <p
        class="text-xs leading-relaxed {activeItem.description ? "text-foreground/80" : "text-muted-foreground italic"}"
      >
        {activeItem.description ?? t("stepType.noDescription")}
      </p>
    </div>
  {/if}
</div>
