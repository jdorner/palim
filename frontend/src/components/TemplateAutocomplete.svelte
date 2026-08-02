<script lang="ts">
import { computeInsertion, detectTrigger, navigateHighlight, type TriggerContext } from "../lib/autocompleteEngine";
import { getSuggestions as querySuggestions, type ScopeConfig, type Suggestion } from "../lib/templateScope";

interface Props {
  /** Reference to the target input/textarea element */
  targetElement: HTMLTextAreaElement | HTMLInputElement | null;
  /** Workflow steps for scope computation */
  steps: Array<{ slug: string }>;
  /** Current step index (zero-based) */
  currentStepIndex: number;
  /** Prefetched secret key names */
  secretKeys: string[];
  /** Optional env allowlist override */
  envAllowlist?: string[];
  /** Callback invoked with the new field value after insertion */
  onChange: (newValue: string) => void;
}

let { targetElement, steps, currentStepIndex, secretKeys, envAllowlist, onChange }: Props = $props();

/** Whether the popup is currently visible */
let visible = $state(false);
/** Current suggestions list */
let suggestions = $state<Suggestion[]>([]);
/** Currently highlighted index */
let highlightIndex = $state(0);
/** Pixel position for popup placement */
let position = $state({ top: 0, left: 0, bottom: 0 });
/** Whether popup should flip above the trigger */
let flipAbove = $state(false);
/** The active trigger context */
let context = $state<TriggerContext | null>(null);

/** Unique ID for the popup element (for aria-activedescendant linking) */
const popupId = "template-autocomplete-popup";

/**
 * Computes the pixel position of the trigger offset within the target element
 * using the mirror-div technique. Creates a hidden div replicating the textarea's
 * CSS, sets its text content up to the trigger offset, and measures a marker span.
 *
 * When flipping above the cursor (viewport overflow), returns a `bottom` value
 * instead of `top` so the popup's bottom edge anchors to the cursor line regardless
 * of the popup's actual rendered height.
 *
 * @param element - The textarea or input element
 * @param triggerOffset - The character offset of the `{{` in the text
 * @returns Pixel coordinates and whether to flip above (includes bottom for CSS anchoring)
 */
function computePosition(
  element: HTMLTextAreaElement | HTMLInputElement,
  triggerOffset: number,
): { top: number; left: number; flipAbove: boolean; bottom: number } {
  const text = element.value;
  const computedStyle = window.getComputedStyle(element);

  // Create mirror div replicating the textarea's styling
  const mirror = document.createElement("div");
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordWrap = "break-word";
  mirror.style.overflowWrap = computedStyle.overflowWrap;
  mirror.style.fontFamily = computedStyle.fontFamily;
  mirror.style.fontSize = computedStyle.fontSize;
  mirror.style.lineHeight = computedStyle.lineHeight;
  mirror.style.padding = computedStyle.padding;
  mirror.style.borderWidth = computedStyle.borderWidth;
  mirror.style.borderStyle = computedStyle.borderStyle;
  mirror.style.width = computedStyle.width;
  mirror.style.boxSizing = computedStyle.boxSizing;
  mirror.style.letterSpacing = computedStyle.letterSpacing;
  mirror.style.wordSpacing = computedStyle.wordSpacing;
  mirror.style.textIndent = computedStyle.textIndent;
  mirror.style.textTransform = computedStyle.textTransform;

  // Set text content up to the trigger offset
  const textBeforeTrigger = text.slice(0, triggerOffset);
  mirror.textContent = textBeforeTrigger;

  // Append a zero-width marker span
  const marker = document.createElement("span");
  marker.textContent = "\u200B"; // zero-width space
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  // Read marker position relative to mirror
  const markerTop = marker.offsetTop;
  const markerLeft = marker.offsetLeft;

  // Clean up the mirror div
  document.body.removeChild(mirror);

  // Get element bounding rect for page-absolute positioning
  const rect = element.getBoundingClientRect();

  // Subtract element scroll offsets
  const scrollTop = element.scrollTop;
  const scrollLeft = element.scrollLeft;

  // Compute position (using viewport-relative coords for position: fixed)
  const lineHeight = Number.parseFloat(computedStyle.lineHeight) || Number.parseFloat(computedStyle.fontSize) * 1.2;
  const cursorLineTop = rect.top + window.scrollY + markerTop - scrollTop;
  let top = cursorLineTop + lineHeight + 4;
  let bottom = 0;
  let left = rect.left + window.scrollX + markerLeft - scrollLeft;

  // Viewport boundary: flip above if popup would overflow bottom
  const popupEstimatedHeight = 200;
  let shouldFlipAbove = false;
  if (top + popupEstimatedHeight > window.innerHeight + window.scrollY) {
    // Use bottom-anchoring: popup bottom edge sits just above the cursor line
    bottom = window.innerHeight + window.scrollY - cursorLineTop + 4;
    shouldFlipAbove = true;
  }

  // Viewport boundary: shift left if would overflow right edge
  const popupEstimatedWidth = 240;
  const viewportRight = window.innerWidth + window.scrollX;
  if (left + popupEstimatedWidth > viewportRight - 8) {
    left = viewportRight - popupEstimatedWidth - 8;
  }

  return { top, left, flipAbove: shouldFlipAbove, bottom };
}

/**
 * Updates the popup position based on the current trigger context.
 * Called when the popup becomes visible or when scroll/resize events occur.
 */
export function updatePosition(): void {
  if (!targetElement || !context?.active) return;
  const pos = computePosition(targetElement, context.triggerOffset);
  position = { top: pos.top, left: pos.left, bottom: pos.bottom };
  flipAbove = pos.flipAbove;
}

/**
 * Shows the popup with the given suggestions and context.
 * Used by event handlers (tasks 4.2/4.3) to display the popup.
 */
export function show(newSuggestions: Suggestion[], newContext: TriggerContext): void {
  suggestions = newSuggestions;
  context = newContext;
  highlightIndex = 0;
  visible = true;
  updatePosition();
}

/**
 * Hides the popup and resets state.
 */
export function hide(): void {
  visible = false;
  suggestions = [];
  highlightIndex = 0;
  context = null;
}

/**
 * Returns whether the popup is currently visible.
 */
export function isVisible(): boolean {
  return visible;
}

/**
 * Returns the current highlight index.
 */
export function getHighlightIndex(): number {
  return highlightIndex;
}

/**
 * Sets the highlight index.
 */
export function setHighlightIndex(index: number): void {
  highlightIndex = index;
}

/**
 * Returns the current suggestions list.
 */
export function getSuggestions(): Suggestion[] {
  return suggestions;
}

/**
 * Returns the current trigger context.
 */
export function getContext(): TriggerContext | null {
  return context;
}

/**
 * Returns a suggestion option ID for aria-activedescendant linking.
 */
function getOptionId(index: number): string {
  return `${popupId}-option-${index}`;
}

/**
 * Accepts the currently highlighted suggestion (or a specific index if provided).
 * Computes the insertion text, updates the target element value, dispatches a
 * synthetic InputEvent, invokes the onChange callback, and either re-queries
 * suggestions (non-terminal) or closes the popup (terminal).
 */
function acceptSuggestion(index?: number): void {
  if (!targetElement || !context?.active) return;

  const suggestion = suggestions[index ?? highlightIndex];
  if (!suggestion) return;

  const cursorPos = targetElement.selectionStart ?? targetElement.value.length;
  const result = computeInsertion(
    targetElement.value,
    cursorPos,
    context.triggerOffset,
    suggestion,
    context.path,
    context.prefix,
  );

  // Update element value and cursor position
  targetElement.value = result.newText;
  targetElement.selectionStart = result.newCursorPos;
  targetElement.selectionEnd = result.newCursorPos;

  // Dispatch synthetic InputEvent so frameworks detect the change
  targetElement.dispatchEvent(new InputEvent("input", { bubbles: true }));

  // Invoke onChange callback with the new value
  onChange(result.newText);

  if (result.keepOpen) {
    // Non-terminal: re-detect trigger and query next-segment suggestions
    const newTrigger = detectTrigger(result.newText, result.newCursorPos);
    if (newTrigger.active) {
      const config: ScopeConfig = { steps, currentStepIndex, secretKeys, envAllowlist };
      const newSuggestions = querySuggestions(config, newTrigger.path, newTrigger.prefix);
      if (newSuggestions.length > 0) {
        show(newSuggestions, newTrigger);
      } else {
        hide();
      }
    } else {
      hide();
    }
  } else {
    hide();
  }
}

/**
 * Handles input events on the target element.
 * Detects trigger context and shows/hides the popup with appropriate suggestions.
 */
function handleInput(): void {
  if (!targetElement) return;
  const text = targetElement.value;
  const cursorPos = targetElement.selectionStart ?? text.length;
  const trigger = detectTrigger(text, cursorPos);

  if (trigger.active) {
    const config: ScopeConfig = { steps, currentStepIndex, secretKeys, envAllowlist };
    const newSuggestions = querySuggestions(config, trigger.path, trigger.prefix);
    if (newSuggestions.length > 0) {
      show(newSuggestions, trigger);
    } else {
      hide();
    }
  } else {
    hide();
  }
}

/**
 * Handles keydown events on the target element.
 * Intercepts navigation and selection keys while popup is visible.
 * Also handles Ctrl+Space to force-open the popup.
 */
function handleKeydown(event: KeyboardEvent): void {
  // Ctrl+Space: force-open autocomplete regardless of popup state
  if (event.code === "Space" && event.ctrlKey) {
    event.preventDefault();
    event.stopPropagation();
    handleInput();
    return;
  }

  if (!visible) return;

  switch (event.key) {
    case "ArrowDown": {
      event.preventDefault();
      event.stopPropagation();
      highlightIndex = navigateHighlight(highlightIndex, 1, suggestions.length);
      break;
    }
    case "ArrowUp": {
      event.preventDefault();
      event.stopPropagation();
      highlightIndex = navigateHighlight(highlightIndex, -1, suggestions.length);
      break;
    }
    case "Tab":
    case "Enter": {
      event.preventDefault();
      event.stopPropagation();
      acceptSuggestion();
      break;
    }
    case "Escape": {
      event.preventDefault();
      event.stopPropagation();
      hide();
      break;
    }
  }
}

/**
 * Handles blur events on the target element.
 * Closes the popup without modifying content.
 */
function handleBlur(): void {
  hide();
}

/**
 * Handles scroll events on the target element.
 * Recalculates popup position to account for scroll offset changes.
 */
function handleScroll(): void {
  updatePosition();
}

/**
 * Effect that attaches event listeners and ResizeObserver to the target element.
 * Cleans up on target change or component destruction.
 */
$effect(() => {
  const el = targetElement;
  if (!el) return;

  el.addEventListener("input", handleInput);
  el.addEventListener("keydown", handleKeydown as EventListener);
  el.addEventListener("blur", handleBlur);
  el.addEventListener("scroll", handleScroll);

  const resizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(() => updatePosition());
  });
  resizeObserver.observe(el);

  return () => {
    el.removeEventListener("input", handleInput);
    el.removeEventListener("keydown", handleKeydown as EventListener);
    el.removeEventListener("blur", handleBlur);
    el.removeEventListener("scroll", handleScroll);
    resizeObserver.disconnect();
  };
});
</script>

{#if targetElement && visible}
  <div
    id={popupId}
    class="fixed z-50 min-w-45 max-w-80 rounded-md border border-border bg-background shadow-md"
    style={flipAbove
      ? `bottom: ${position.bottom}px; left: ${position.left}px;`
      : `top: ${position.top}px; left: ${position.left}px;`}
    role="listbox"
    aria-label="Template suggestions"
  >
    <div class="max-h-50 overflow-y-auto p-1">
      {#if suggestions.length === 0}
        <div class="px-3 py-2 text-sm text-muted-foreground">No suggestions</div>
      {:else}
        {#each suggestions as suggestion, i (suggestion.label)}
          <button
            type="button"
            id={getOptionId(i)}
            role="option"
            tabindex="-1"
            aria-selected={i === highlightIndex}
            class="w-full cursor-pointer rounded-sm px-3 py-1.5 text-left text-sm text-foreground transition-colors"
            class:bg-accent={i === highlightIndex}
            class:text-accent-foreground={i === highlightIndex}
            class:hover:bg-accent={i !== highlightIndex}
            class:hover:text-accent-foreground={i !== highlightIndex}
            onmousedown={(e) => { e.preventDefault(); acceptSuggestion(i); }}
            onmouseenter={() => { highlightIndex = i; }}
          >
            <span class="font-mono">{suggestion.label}</span>
            {#if suggestion.description}
              <span class="ml-2 text-xs text-muted-foreground">{suggestion.description}</span>
            {/if}
            {#if !suggestion.terminal}
              <span class="ml-1 text-xs text-muted-foreground">...</span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/if}
