<script lang="ts">
import PaperPlaneRightIcon from "phosphor-svelte/lib/PaperPlaneRightIcon";
import StopIcon from "phosphor-svelte/lib/StopIcon";
import { tick } from "svelte";
import { Button } from "$lib/components/ui/button";

interface Props {
  /** Whether the input is disabled (e.g. during streaming). */
  disabled?: boolean;
  /** Whether the agent is currently streaming a response. */
  streaming?: boolean;
  /** Callback when the user submits a message. */
  onsubmit?: (content: string) => void;
  /** Callback when the user cancels an active stream. */
  oncancel?: () => void;
}

let { disabled = false, streaming = false, onsubmit, oncancel }: Props = $props();

let value = $state("");
let textareaEl = $state<HTMLTextAreaElement | undefined>(undefined);

const MAX_ROWS = 8;
const LINE_HEIGHT_PX = 20;

/** Auto-resize the textarea to fit its content, up to MAX_ROWS. */
function autoResize() {
  if (!textareaEl) return;
  textareaEl.style.height = "auto";
  const maxHeight = MAX_ROWS * LINE_HEIGHT_PX;
  textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, maxHeight)}px`;
  textareaEl.style.overflowY = textareaEl.scrollHeight > maxHeight ? "auto" : "hidden";
}

/** Re-focus the textarea when input is re-enabled (e.g. after streaming completes). */
$effect(() => {
  if (!disabled && textareaEl) {
    tick().then(() => textareaEl?.focus());
  }
});

/** Resize textarea whenever value changes. */
$effect(() => {
  // Track value to re-run on changes
  void value;
  tick().then(() => autoResize());
});

/** Focuses the textarea. Can be called by parent via bind:this. */
export function focus() {
  tick().then(() => textareaEl?.focus());
}

/** Handles keydown: Enter submits, Shift+Enter inserts newline. */
function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}

/** Submits the current input value if non-empty. */
function submit() {
  const trimmed = value.trim();
  if (!trimmed || disabled) return;
  onsubmit?.(trimmed);
  value = "";
  tick().then(() => autoResize());
}

/** Prevents default form submission and calls submit(). */
function handleFormSubmit(e: SubmitEvent) {
  e.preventDefault();
  submit();
}
</script>

<form class="flex items-end gap-2 border-t border-border bg-background p-4" onsubmit={handleFormSubmit}>
  <textarea
    bind:this={textareaEl}
    bind:value
    name="chat-input"
    onkeydown={handleKeydown}
    disabled={disabled && !streaming}
    rows="1"
    placeholder="Send a message..."
    class="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm leading-5
      placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring
      disabled:cursor-not-allowed disabled:opacity-50 overflow-hidden"
    aria-label="Chat message input"
  ></textarea>
  {#if streaming}
    <Button type="button" size="icon" variant="destructive" onclick={() => oncancel?.()}>
      <StopIcon class="w-4 h-4" aria-hidden="true" />
      <span class="sr-only">Stop generation</span>
    </Button>
  {:else}
    <Button type="submit" size="icon" {disabled}>
      <PaperPlaneRightIcon class="w-4 h-4" aria-hidden="true" />
      <span class="sr-only">Send</span>
    </Button>
  {/if}
</form>
