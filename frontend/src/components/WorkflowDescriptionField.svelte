<script lang="ts">
/** Description input shown above the graph while a workflow is edited. */
import { slide } from "svelte/transition";
import { t } from "$lib/i18n.svelte";

interface Props {
  value: string;
  /** Validation error for the description, if any. */
  error?: string;
  oninput: (value: string) => void;
}

let { value, error, oninput }: Props = $props();
</script>

<div class="mb-4 shrink-0 p-4 border border-border rounded-md bg-muted/30" transition:slide={{ duration: 100 }}>
  <div class="flex flex-col gap-1">
    <label for="edit-description" class="text-xs font-medium text-muted-foreground">{t("common.description")}</label>
    <input
      id="edit-description"
      type="text"
      class="px-2 py-1.5 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
      {value}
      maxlength={256}
      oninput={(e) => oninput((e.target as HTMLInputElement).value)}
      placeholder={t("workflows.descriptionPlaceholder")}
    >
    {#if error}
      <span class="text-xs text-destructive">{error}</span>
    {/if}
  </div>
</div>
