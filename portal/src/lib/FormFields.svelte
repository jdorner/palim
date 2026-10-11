<!-- Renders form fields from a JSON Schema (common subset; see lib/form.ts). Used by task answers and workflow launchers. -->
<script lang="ts">
import type { FormField } from "./form";
import { t } from "./i18n.svelte";

interface Props {
  /** The form fields. */
  fields: FormField[];
  /** Values by key (bound). */
  values: Record<string, unknown>;
  /** Field errors by key. */
  errors?: Record<string, string>;
  /** Disable all inputs. */
  disabled?: boolean;
}

let { fields, values = $bindable(), errors = {}, disabled = false }: Props = $props();

const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60";
</script>

<div class="space-y-4">
  {#each fields as field (field.key)}
    {@const id = `field-${field.key}`}
    <div class="space-y-1">
      {#if field.kind === "boolean"}
        <label class="flex items-center gap-2 text-sm font-medium" for={id}>
          <input {id} type="checkbox" class="size-4" bind:checked={values[field.key] as boolean} {disabled}>
          {field.label}
        </label>
      {:else}
        <label class="text-sm font-medium" for={id}>
          {field.label}
          {#if field.required}
            <span class="text-destructive" title={t("form.required")}>*</span>
          {/if}
        </label>
        {#if field.kind === "textarea"}
          <textarea {id} rows="4" class={inputClass} bind:value={values[field.key]} {disabled}></textarea>
        {:else if field.kind === "select"}
          <select {id} class={inputClass} bind:value={values[field.key]} {disabled}>
            <option value="">{t("form.choose")}</option>
            {#each field.options as option (option.value)}
              <option value={String(option.value)}>{option.label}</option>
            {/each}
          </select>
        {:else if field.kind === "number" || field.kind === "integer"}
          <input
            {id}
            type="number"
            inputmode={field.kind === "integer" ? "numeric" : "decimal"}
            step={field.kind === "integer" ? 1 : "any"}
            class={inputClass}
            bind:value={values[field.key]}
            {disabled}
          >
        {:else if field.kind === "date"}
          <input {id} type="date" class={inputClass} bind:value={values[field.key]} {disabled}>
        {:else if field.kind === "text"}
          <input {id} type="text" class={inputClass} bind:value={values[field.key]} {disabled}>
        {:else}
          <p class="text-xs text-muted-foreground">{t("form.unsupportedField")}</p>
        {/if}
      {/if}
      {#if field.description}
        <p class="text-xs text-muted-foreground">{field.description}</p>
      {/if}
      {#if errors[field.key]}
        <p class="text-xs text-destructive" role="alert">{errors[field.key]}</p>
      {/if}
    </div>
  {/each}
</div>
