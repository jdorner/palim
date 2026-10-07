<script lang="ts">
import { filterMultiSelectItems } from "./multiSelectFilter";

interface Props {
  id?: string;
  /** Full list of available options. */
  items: string[];
  /** Currently selected items (bindable). */
  selected: string[];
  /** Search input placeholder text. */
  placeholder?: string;
  /** Disable the entire control. */
  disabled?: boolean;
  /** Maximum options shown in the dropdown list (default 50). */
  maxDisplay?: number;
  /**
   * When true, the user may add a typed value that is not in `items`
   * (via Enter or the "Add" row). The control also stays enabled when
   * `items` is empty, acting as a free-form tag input with suggestions.
   */
  allowCustom?: boolean;
  /**
   * Optional display-label mapping. Given a raw item value, returns the text
   * to render (e.g. prefixing an emoji to a shortcode). The stored/selected
   * value is always the raw item; only the rendered label changes. Falls back
   * to the raw item when omitted or when it returns undefined.
   */
  labelFor?: (item: string) => string | undefined;
  /** Optional callback fired when the selection changes. */
  onchange?: (selected: string[]) => void;
  /** Text size of the control and its dropdown (default "sm"). */
  size?: "sm" | "xs";
}

let {
  id,
  items,
  selected = $bindable(),
  placeholder = "Search...",
  disabled = false,
  maxDisplay = 50,
  allowCustom = false,
  labelFor,
  onchange,
  size = "sm",
}: Props = $props();

const textSize = $derived(size === "xs" ? "text-xs" : "text-sm");

/**
 * Resolve the display label for an item, falling back to the raw value.
 *
 * @param item - The raw item value
 * @returns The text to render for the item
 */
function displayLabel(item: string): string {
  return labelFor?.(item) ?? item;
}

let search = $state("");
let open = $state(false);
let inputEl: HTMLInputElement | undefined = $state();
let highlightIndex = $state(-1);
/** The visible control box the dropdown is anchored to. */
let controlEl: HTMLDivElement | undefined = $state();
/** Fixed-position placement of the portaled dropdown (viewport coordinates). */
let dropdownPos = $state<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number }>({
  left: 0,
  width: 0,
  maxHeight: 240,
});

/** Default dropdown list height cap (matches the former max-h-60). */
const DROPDOWN_MAX_HEIGHT = 240;
/** Gap between the control and the dropdown, and minimum distance to the viewport edge. */
const DROPDOWN_GAP = 4;
const VIEWPORT_MARGIN = 8;

// With allowCustom the control is always usable (free-form entry), even when
// there are no suggestion items.
let isDisabled = $derived(disabled || (items.length === 0 && !allowCustom));

let filtered = $derived.by(() => filterMultiSelectItems(items, selected, search, maxDisplay));

let hasNoResults = $derived(search.length > 0 && filtered.length === 0);

/** Trimmed search term. */
let trimmedSearch = $derived(search.trim());

/**
 * Whether the current input represents a custom value that can be added:
 * only when allowCustom is on, the term is non-empty, not already selected,
 * and not an exact match of an existing suggestion (which the list handles).
 */
let canAddCustom = $derived(
  allowCustom && trimmedSearch.length > 0 && !selected.includes(trimmedSearch) && !filtered.includes(trimmedSearch),
);

// Reset highlight when filtered list changes
$effect(() => {
  filtered;
  highlightIndex = -1;
});

function select(item: string) {
  if (selected.includes(item)) {
    search = "";
    highlightIndex = -1;
    inputEl?.focus();
    return;
  }
  selected = [...selected, item];
  search = "";
  highlightIndex = -1;
  inputEl?.focus();
  onchange?.(selected);
}

/** Add the current trimmed search term as a custom value. */
function addCustom() {
  if (!canAddCustom) return;
  select(trimmedSearch);
}

function remove(item: string) {
  selected = selected.filter((s) => s !== item);
  onchange?.(selected);
}

function handleKeydown(event: KeyboardEvent) {
  const highlighted = open && highlightIndex >= 0 ? filtered[highlightIndex] : undefined;
  if (event.key === "ArrowDown" && open && filtered.length > 0) {
    event.preventDefault();
    highlightIndex = highlightIndex < filtered.length - 1 ? highlightIndex + 1 : 0;
    scrollHighlightedIntoView();
  } else if (event.key === "ArrowUp" && open && filtered.length > 0) {
    event.preventDefault();
    highlightIndex = highlightIndex > 0 ? highlightIndex - 1 : filtered.length - 1;
    scrollHighlightedIntoView();
  } else if (event.key === "ArrowDown" && event.altKey === true) {
    event.preventDefault();
    open = true;
    highlightIndex = filtered.length > 0 ? 0 : -1;
  } else if (event.key === "Enter" && highlighted !== undefined) {
    event.preventDefault();
    select(highlighted);
  } else if (event.key === "Enter" && canAddCustom) {
    // No highlighted suggestion but a custom value is typed: add it.
    event.preventDefault();
    addCustom();
  } else if (event.key === "Backspace" && search === "" && selected.length > 0) {
    selected = selected.slice(0, -1);
    onchange?.(selected);
  } else if (event.key === "Escape" && open) {
    event.stopPropagation();
    open = false;
    highlightIndex = -1;
  }
}

function scrollHighlightedIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector("[data-multiselect-dropdown] [data-highlighted]");
    el?.scrollIntoView({ block: "nearest" });
  });
}

/**
 * Place the dropdown below the control, or above it when there is not enough
 * room below and more room above. The dropdown is portaled to the body so a
 * scrolling or clipping ancestor (e.g. a side panel) cannot cut it off.
 */
function positionDropdown() {
  if (!controlEl) return;
  const rect = controlEl.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom - DROPDOWN_GAP - VIEWPORT_MARGIN;
  const spaceAbove = rect.top - DROPDOWN_GAP - VIEWPORT_MARGIN;
  const above = spaceBelow < DROPDOWN_MAX_HEIGHT && spaceAbove > spaceBelow;
  dropdownPos = above
    ? {
        left: rect.left,
        width: rect.width,
        bottom: window.innerHeight - rect.top + DROPDOWN_GAP,
        maxHeight: Math.min(DROPDOWN_MAX_HEIGHT, spaceAbove),
      }
    : {
        left: rect.left,
        width: rect.width,
        top: rect.bottom + DROPDOWN_GAP,
        maxHeight: Math.min(DROPDOWN_MAX_HEIGHT, spaceBelow),
      };
}

// Keep the dropdown attached to the control while open: the control can grow
// (chips added), and ancestors can scroll or the window resize.
$effect(() => {
  if (!open || !controlEl) return;
  positionDropdown();
  const observer = new ResizeObserver(positionDropdown);
  observer.observe(controlEl);
  window.addEventListener("scroll", positionDropdown, true);
  window.addEventListener("resize", positionDropdown);
  return () => {
    observer.disconnect();
    window.removeEventListener("scroll", positionDropdown, true);
    window.removeEventListener("resize", positionDropdown);
  };
});

/** Svelte action that portals the element to document.body. */
function portal(node: HTMLElement) {
  document.body.appendChild(node);
  return {
    destroy() {
      node.remove();
    },
  };
}

function handleFocus() {
  if (!isDisabled) open = true;
}

function handleBlur(event: FocusEvent) {
  const related = event.relatedTarget as HTMLElement | null;
  if (related?.closest("[data-multiselect-dropdown]")) return;
  open = false;
  highlightIndex = -1;
}
</script>

<div class="relative w-full" data-multiselect>
  {#if isDisabled}
    <div
      class="{textSize} flex h-9 w-full items-center rounded-md border border-border bg-muted px-3 text-muted-foreground cursor-not-allowed"
    >
      No items available
    </div>
  {:else}
    <div
      bind:this={controlEl}
      class="{textSize} flex flex-wrap items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1"
    >
      {#each selected as item (item)}
        <span
          class="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground"
        >
          {displayLabel(item)}
          <button
            type="button"
            tabindex="-1"
            class="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            onclick={() => remove(item)}
            aria-label="Remove {item}"
          >
            <svg
              class="h-2.5 w-2.5"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              aria-hidden="true"
            >
              <title>Remove</title>
              <path d="M2 2l6 6M8 2l-6 6" />
            </svg>
          </button>
        </span>
      {/each}
      <input
        bind:this={inputEl}
        {id}
        type="text"
        class="{textSize} flex-1 min-w-20 bg-transparent outline-none py-0.5"
        {placeholder}
        bind:value={search}
        onfocus={handleFocus}
        onblur={handleBlur}
        onkeydown={handleKeydown}
        aria-label="Search items"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls="multiselect-listbox"
        aria-activedescendant={highlightIndex >= 0 ? `multiselect-option-${highlightIndex}` : undefined}
      >
    </div>

    {#if open}
      <div
        use:portal
        data-multiselect-dropdown
        class="fixed z-9999 rounded-md border border-border bg-background shadow-md"
        style:left="{dropdownPos.left}px"
        style:width="{dropdownPos.width}px"
        style:top={dropdownPos.top !== undefined ? `${dropdownPos.top}px` : undefined}
        style:bottom={dropdownPos.bottom !== undefined ? `${dropdownPos.bottom}px` : undefined}
        tabindex="-1"
        role="listbox"
        id="multiselect-listbox"
      >
        <div class="overflow-y-auto p-1" style:max-height="{dropdownPos.maxHeight}px">
          {#if hasNoResults && !canAddCustom}
            <div class="{textSize} px-3 py-2 text-muted-foreground">No results found</div>
          {:else}
            {#each filtered as item, i (item)}
              <button
                type="button"
                id="multiselect-option-{i}"
                role="option"
                tabindex="-1"
                aria-selected={i === highlightIndex}
                class="{textSize} w-full cursor-pointer rounded-sm px-3 py-1.5 text-left text-foreground transition-colors"
                class:bg-accent={i === highlightIndex}
                class:text-accent-foreground={i === highlightIndex}
                class:hover:bg-accent={i !== highlightIndex}
                class:hover:text-accent-foreground={i !== highlightIndex}
                data-highlighted={i === highlightIndex ? "" : undefined}
                onmousedown={(e) => {
                  e.preventDefault();
                  select(item);
                }}
                onmouseenter={() => {
                  highlightIndex = i;
                }}
              >
                {displayLabel(item)}
              </button>
            {/each}
            {#if canAddCustom}
              <button
                type="button"
                role="option"
                tabindex="-1"
                aria-selected={false}
                class="{textSize} w-full cursor-pointer rounded-sm px-3 py-1.5 text-left text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                onmousedown={(e) => {
                  e.preventDefault();
                  addCustom();
                }}
              >
                Add "{trimmedSearch}"
              </button>
            {/if}
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>
