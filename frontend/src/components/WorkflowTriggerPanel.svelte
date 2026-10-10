<script lang="ts">
import { Badge } from "$lib/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger } from "$lib/components/ui/select";
import { t } from "$lib/i18n.svelte";
/**
 * Detail panel for the workflow trigger node: shows the trigger type/ref in
 * view mode, and type/ref pickers when editing.
 */
import { type CoreKey, translateCore } from "$lib/i18nCore";
import { visualForStepType } from "$lib/nodeVisuals";
import type { WorkflowTrigger } from "$lib/workflowDetail";
import type { TriggerRefs } from "$lib/workflowEditorMeta";
import type { DraftTrigger } from "$lib/workflowValidation";
import OutputSchemaEditor from "./OutputSchemaEditor.svelte";
import StepPanelHeader from "./StepPanelHeader.svelte";

interface Props {
  /** The saved trigger, shown in view mode. */
  trigger: WorkflowTrigger;
  /** Saved workflow name (for inferring the payload schema from past runs). */
  workflowName?: string;
  /** The draft trigger when editing; null in view mode. */
  draftTrigger: DraftTrigger | null;
  /** Validation errors map (reads `trigger.type` / `trigger.ref`). */
  validationErrors: Map<string, string>;
  /** Available refs per trigger type. */
  availableTriggerRefs: TriggerRefs;
  /** Whether the ref options are still loading. */
  metaLoading: boolean;
  /** Close the panel. */
  onclose: () => void;
  /** Replace the draft trigger. */
  onTriggerChange: (trigger: DraftTrigger) => void;
  /** Replace the validation errors. */
  onValidationErrorsChange: (errors: Map<string, string>) => void;
}

let {
  trigger,
  workflowName,
  draftTrigger,
  validationErrors,
  availableTriggerRefs,
  metaLoading,
  onclose,
  onTriggerChange,
  onValidationErrorsChange,
}: Props = $props();

/** Selectable workflow trigger types (subtypes of the built-in "trigger" node). */
const TRIGGER_TYPES = ["webhook", "schedule", "manual", "filewatcher"] as const;
</script>

<!--
  Renders a trigger's icon tile (colored by category) followed by its type text.
  The icon is resolved by trigger subtype (manual/webhook/schedule/filewatcher)
  via visualForStepType, matching the graph trigger node.
-->
{#snippet triggerChip(
  triggerType: string,
)}
  {@const v = visualForStepType("trigger", { triggerType })}
  <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-white {v.tileClass}">
    <v.icon size={11} weight="bold" aria-hidden="true" />
  </span>
  {translateCore(`triggerTypes.${triggerType}` as CoreKey, { default: triggerType })}
{/snippet}

<div class="w-95 h-full flex flex-col">
  <StepPanelHeader type="trigger" triggerType={draftTrigger?.type ?? trigger.type} {onclose} />

  <div class="flex-1 overflow-y-auto min-h-0 p-4 flex flex-col gap-4">
    {#if draftTrigger}
      <!-- Unlike steps, the trigger type stays changeable while editing. -->
      <div class="flex flex-col gap-1">
        <label for="sidebar-trigger-type" class="text-xs font-medium text-muted-foreground"
          >{t("triggerPanel.type")}</label
        >
        <Select
          type="single"
          value={draftTrigger.type}
          onValueChange={(newType) => {
            if (!newType || !draftTrigger) return;
            const oldType = draftTrigger.type;
            onTriggerChange({
              ...draftTrigger,
              type: newType,
              ref: newType === "manual" || newType !== oldType ? "" : draftTrigger.ref,
            });
          }}
        >
          <SelectTrigger id="sidebar-trigger-type" aria-label={t("triggerPanel.typeLabel")} class="text-xs">
            {@render triggerChip(draftTrigger.type)}
          </SelectTrigger>
          <SelectContent>
            {#each TRIGGER_TYPES as triggerType (triggerType)}
              <SelectItem
                value={triggerType}
                label={translateCore(`triggerTypes.${triggerType}` as CoreKey, { default: triggerType })}
                class="text-xs"
              >
                {@render triggerChip(triggerType)}
              </SelectItem>
            {/each}
          </SelectContent>
        </Select>
        {#if validationErrors.get("trigger.type")}
          <span class="text-xs text-destructive">{validationErrors.get("trigger.type")}</span>
        {/if}
      </div>
      {#if draftTrigger.type !== "manual"}
        {@const refOptions = availableTriggerRefs[draftTrigger.type] ?? []}
        <div class="flex flex-col gap-1">
          <label for="sidebar-trigger-ref" class="text-xs font-medium text-muted-foreground"
            >{t("triggerPanel.ref")}</label
          >
          <select
            id="sidebar-trigger-ref"
            class="px-2 py-1.5 text-xs border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            value={draftTrigger.ref}
            disabled={metaLoading}
            onchange={(e) => {
              if (!draftTrigger) return;
              const ref = (e.target as HTMLSelectElement).value;
              onTriggerChange({ ...draftTrigger, ref });
              const newErrors = new Map(validationErrors);
              if (ref) {
                newErrors.delete("trigger.ref");
              }
              onValidationErrorsChange(newErrors);
            }}
          >
            <option value="">{t("triggerPanel.selectRef")}</option>
            {#each refOptions as ref}
              <option value={ref}>{ref}</option>
            {/each}
            {#if draftTrigger.ref && !refOptions.includes(draftTrigger.ref)}
              <option value={draftTrigger.ref}>{t("triggerPanel.notFound", { ref: draftTrigger.ref })}</option>
            {/if}
          </select>
          {#if metaLoading}
            <span class="text-xs text-muted-foreground">{t("triggerPanel.loadingRefs")}</span>
          {:else if refOptions.length === 0}
            <span class="text-xs text-muted-foreground">{t("triggerPanel.noRefs")}</span>
          {/if}
          {#if validationErrors.get("trigger.ref")}
            <span class="text-xs text-destructive">{validationErrors.get("trigger.ref")}</span>
          {/if}
        </div>
      {/if}
      <OutputSchemaEditor
        value={draftTrigger.outputSchema}
        {workflowName}
        source={{ kind: "trigger" }}
        onChange={(outputSchema) => {
          if (!draftTrigger) return;
          const { outputSchema: _old, ...rest } = draftTrigger;
          onTriggerChange(outputSchema ? { ...rest, outputSchema } : rest);
        }}
      />
    {:else}
      {#if trigger.ref}
        <div class="flex items-center gap-2">
          <span class="text-xs font-medium text-muted-foreground">{t("triggerPanel.refLabel")}</span>
          <Badge variant="outline">{trigger.ref}</Badge>
        </div>
      {/if}
      <OutputSchemaEditor value={trigger.outputSchema} readonly source={{ kind: "trigger" }} />
    {/if}
  </div>
</div>
