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
  /** Optional callback fired when the selection changes. */
  onchange?: (selected: string[]) => void;
}

let {
  id,
  items,
  selected = $bindable(),
  placeholder = "Search...",
  disabled = false,
  maxDisplay = 50,
  onchange,
}: Props = $props();

let search = $state("");
let open = $state(false);
let inputEl: HTMLInputElement | undefined = $state();
let highlightIndex = $state(-1);

let isDisabled = $derived(disabled || items.length === 0);

let filtered = $derived.by(() => filterMultiSelectItems(items, selected, search, maxDisplay));

let hasNoResults = $derived(search.length > 0 && filtered.length === 0);

// Reset highlight when filtered list changes
$effect(() => {
  filtered;
  highlightIndex = -1;
});

function select(item: string) {
  selected = [...selected, item];
  search = "";
  highlightIndex = -1;
  inputEl?.focus();
  onchange?.(selected);
}

function remove(item: string) {
  selected = selected.filter((s) => s !== item);
  onchange?.(selected);
}

function handleKeydown(event: KeyboardEvent) {
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
  } else if (event.key === "Enter" && open && highlightIndex >= 0 && highlightIndex < filtered.length) {
    event.preventDefault();
    select(filtered[highlightIndex]);
  } else if (event.key === "Backspace" && search === "" && selected.length > 0) {
    selected = selected.slice(0, -1);
    onchange?.(selected);
  } else if (event.key === "Escape") {
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
      class="flex h-9 w-full items-center rounded-md border border-border bg-muted px-3 text-sm text-muted-foreground cursor-not-allowed"
    >
      No items available
    </div>
  {:else}
    <div
      class="flex flex-wrap items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm  transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1"
    >
      {#each selected as item (item)}
        <span
          class="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground"
        >
          {item}
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
        class="flex-1 min-w-[80px] bg-transparent outline-none text-sm py-0.5"
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
        data-multiselect-dropdown
        class="absolute z-50 mt-1 w-full rounded-md border border-border bg-background shadow-md"
        tabindex="-1"
        role="listbox"
        id="multiselect-listbox"
      >
        <div class="max-h-60 overflow-y-auto p-1">
          {#if hasNoResults}
            <div class="px-3 py-2 text-sm text-muted-foreground">No results found</div>
          {:else}
            {#each filtered as item, i (item)}
              <button
                type="button"
                id="multiselect-option-{i}"
                role="option"
                tabindex="-1"
                aria-selected={i === highlightIndex}
                class="w-full cursor-pointer rounded-sm px-3 py-1.5 text-left text-sm text-foreground transition-colors"
                class:bg-accent={i === highlightIndex}
                class:text-accent-foreground={i === highlightIndex}
                class:hover:bg-accent={i !== highlightIndex}
                class:hover:text-accent-foreground={i !== highlightIndex}
                data-highlighted={i === highlightIndex ? "" : undefined}
                onmousedown={(e) => { e.preventDefault(); select(item); }}
                onmouseenter={() => { highlightIndex = i; }}
              >
                {item}
              </button>
            {/each}
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>
