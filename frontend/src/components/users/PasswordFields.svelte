<script lang="ts">
import CheckIcon from "phosphor-svelte/lib/CheckIcon";
import CopyIcon from "phosphor-svelte/lib/CopyIcon";
import EyeIcon from "phosphor-svelte/lib/EyeIcon";
import EyeSlashIcon from "phosphor-svelte/lib/EyeSlashIcon";
import SparkleIcon from "phosphor-svelte/lib/SparkleIcon";
import { Button } from "$lib/components/ui/button";
import { generatePassword, MIN_PASSWORD_LENGTH } from "./userAdmin";

interface Props {
  /** Prefix for input ids, so several instances can coexist. */
  idPrefix: string;
  /** The new password. */
  password: string;
  /** The confirmation entry. */
  confirm: string;
}

let { idPrefix, password = $bindable(), confirm = $bindable() }: Props = $props();

let visible = $state(false);
let generated = $state(false);
let copied = $state(false);

function generate() {
  const pw = generatePassword();
  password = pw;
  confirm = pw;
  visible = true;
  generated = true;
  copied = false;
}

async function copy() {
  try {
    await navigator.clipboard.writeText(password);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  } catch {
    // Clipboard unavailable (e.g. insecure context) — the password is visible for manual copy.
  }
}

const inputClass = "rounded-md border border-input bg-background px-3 py-1.5 text-sm font-mono";
</script>

<div class="space-y-3">
  <div class="space-y-1">
    <div class="flex items-center justify-between">
      <label for="{idPrefix}-password" class="text-xs font-medium text-muted-foreground">
        Password <span class="font-normal">(min {MIN_PASSWORD_LENGTH} characters)</span>
      </label>
      <button
        type="button"
        class="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        onclick={generate}
      >
        <SparkleIcon size={12} aria-hidden="true" />
        Generate
      </button>
    </div>
    <div class="flex gap-2">
      <input
        id="{idPrefix}-password"
        type={visible ? "text" : "password"}
        autocomplete="new-password"
        bind:value={password}
        oninput={() => (generated = false)}
        class="{inputClass} min-w-0 flex-1"
      >
      <Button
        size="icon"
        variant="outline"
        class="h-9 w-9 shrink-0"
        aria-label={visible ? "Hide password" : "Show password"}
        onclick={() => (visible = !visible)}
      >
        {#if visible}
          <EyeSlashIcon size={14} aria-hidden="true" />
        {:else}
          <EyeIcon size={14} aria-hidden="true" />
        {/if}
      </Button>
      {#if visible && password}
        <Button size="icon" variant="outline" class="h-9 w-9 shrink-0" aria-label="Copy password" onclick={copy}>
          {#if copied}
            <CheckIcon size={14} aria-hidden="true" />
          {:else}
            <CopyIcon size={14} aria-hidden="true" />
          {/if}
        </Button>
      {/if}
    </div>
    {#if generated}
      <p class="text-xs text-muted-foreground">Copy this password now — it is not shown again after saving.</p>
    {/if}
  </div>
  {#if !generated}
    <div class="space-y-1">
      <label for="{idPrefix}-confirm" class="text-xs font-medium text-muted-foreground">Confirm password</label>
      <input
        id="{idPrefix}-confirm"
        type={visible ? "text" : "password"}
        autocomplete="new-password"
        bind:value={confirm}
        class="{inputClass} w-full"
      >
    </div>
  {/if}
</div>
