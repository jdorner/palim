<script lang="ts">
/** Description and group inputs shown above the graph while a workflow is edited. */
import { slide } from "svelte/transition";
import { t } from "$lib/i18n.svelte";
import { MAX_GROUP_LENGTH } from "$lib/workflowValidation";

interface Props {
  description: string;
  /** Validation error for the description, if any. */
  descriptionError?: string;
  ondescription: (value: string) => void;
  group: string;
  /** Validation error for the group, if any. */
  groupError?: string;
  /** Existing group names offered as suggestions. */
  knownGroups: string[];
  ongroup: (value: string) => void;
}

let { description, descriptionError, ondescription, group, groupError, knownGroups, ongroup }: Props = $props();

const inputClass =
  "px-2 py-1.5 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring";
</script>

<div
  class="mb-4 shrink-0 p-4 border border-border rounded-md bg-muted/30 grid gap-3 md:grid-cols-[1fr_16rem]"
  transition:slide={{ duration: 100 }}
>
  <div class="flex flex-col gap-1 min-w-0">
    <label for="edit-description" class="text-xs font-medium text-muted-foreground">{t("common.description")}</label>
    <input
      id="edit-description"
      type="text"
      class={inputClass}
      value={description}
      maxlength={256}
      oninput={(e) => ondescription((e.target as HTMLInputElement).value)}
      placeholder={t("workflows.descriptionPlaceholder")}
    >
    {#if descriptionError}
      <span class="text-xs text-destructive">{descriptionError}</span>
    {/if}
  </div>
  <div class="flex flex-col gap-1 min-w-0">
    <label for="edit-group" class="text-xs font-medium text-muted-foreground">{t("workflows.group")}</label>
    <input
      id="edit-group"
      type="text"
      class={inputClass}
      value={group}
      maxlength={MAX_GROUP_LENGTH}
      list="workflow-group-options"
      autocomplete="off"
      oninput={(e) => ongroup((e.target as HTMLInputElement).value)}
      placeholder={t("workflows.groupPlaceholder")}
    >
    <datalist id="workflow-group-options">
      {#each knownGroups as option (option)}
        <option value={option}></option>
      {/each}
    </datalist>
    {#if groupError}
      <span class="text-xs text-destructive">{groupError}</span>
    {/if}
  </div>
</div>
