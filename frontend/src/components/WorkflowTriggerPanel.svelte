<script lang="ts">
import { authFetch } from "$lib/auth";
import { Badge } from "$lib/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger } from "$lib/components/ui/select";
import { t } from "$lib/i18n.svelte";
/**
 * Detail panel for the workflow trigger node: shows the trigger type/ref in
 * view mode, and type/ref pickers when editing.
 */
import { type CoreKey, translateCore } from "$lib/i18nCore";
import { identity } from "$lib/identity.svelte";
import { visualForStepType } from "$lib/nodeVisuals";
import type { WorkflowTrigger } from "$lib/workflowDetail";
import type { TriggerRefs } from "$lib/workflowEditorMeta";
import type { DraftTrigger } from "$lib/workflowValidation";
import { PORTAL_UPLOAD_DEFAULT_MB, PORTAL_UPLOAD_MAX_MB } from "$shared/portal";
import type { PortalTriggerConfig } from "$shared/workflows";
import ExpandButton from "./ExpandButton.svelte";
import ExpandedTextEditor from "./ExpandedTextEditor.svelte";
import FieldListEditor from "./FieldListEditor.svelte";
import InfoTip from "./InfoTip.svelte";
import MultiSelect from "./MultiSelect.svelte";
import OutputSchemaEditor from "./OutputSchemaEditor.svelte";
import StepPanelHeader from "./StepPanelHeader.svelte";

interface Props {
  /** The saved trigger, shown in view mode. */
  trigger: WorkflowTrigger;
  /** Saved workflow name (for inferring the payload schema from past runs). */
  workflowName?: string;
  /** The draft trigger when editing; null in view mode. */
  draftTrigger: DraftTrigger | null;
  /** Validation errors map (reads `trigger.type` / `trigger.ref` / `trigger.portal.fields`). */
  validationErrors: Map<string, string>;
  /** The account portal-started runs execute as (null when unbound). */
  portalRunAs?: { username: string; usable: boolean } | null;
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
  portalRunAs = null,
  availableTriggerRefs,
  metaLoading,
  onclose,
  onTriggerChange,
  onValidationErrorsChange,
}: Props = $props();

/** Whether the portal description is open in the large editor dialog. */
let descriptionExpanded = $state(false);

/** Selectable workflow trigger types (subtypes of the built-in "trigger" node). */
const TRIGGER_TYPES = ["webhook", "schedule", "manual", "filewatcher", "portal"] as const;

/** Trigger types without a ref. */
const REFLESS = ["manual", "portal"];

/** Accept presets for portal uploads (value "" = any file). */
const ACCEPT_PRESETS = [
  { value: "image/*", labelKey: "triggerPanel.portalAcceptImages" },
  { value: "image/*,application/pdf", labelKey: "triggerPanel.portalAcceptImagesPdf" },
  { value: "", labelKey: "triggerPanel.portalAcceptAny" },
] as const;
const CUSTOM_ACCEPT = "__custom__";

const inputClass =
  "px-2 py-1.5 text-xs border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring";

/** Role names offered as suggestions (only readable with user management; free entry otherwise). */
let roleNames = $state<string[]>([]);
$effect(() => {
  if (draftTrigger?.type !== "portal" || !identity.can("manage", "User") || roleNames.length > 0) return;
  void authFetch("/api/roles")
    .then((res) => (res.ok ? (res.json() as Promise<{ name: string }[]>) : []))
    .then((roles) => {
      roleNames = roles.map((r) => r.name).filter((n) => n !== "system");
    })
    .catch(() => {});
});

const portalConfig = $derived<PortalTriggerConfig>(draftTrigger?.portal ?? {});

/** Whether the custom accept input is shown (set when picked, or when the value matches no preset). */
let customAccept = $state(false);
const acceptChoice = $derived(
  customAccept || !ACCEPT_PRESETS.some((p) => p.value === (portalConfig.accept ?? ""))
    ? CUSTOM_ACCEPT
    : (portalConfig.accept ?? ""),
);

/**
 * Applies a change to the portal configuration, dropping empty values.
 *
 * @param patch - The changed properties (undefined removes one)
 * @param extra - Other draft trigger changes (e.g. the fields error)
 */
function updatePortal(patch: Partial<PortalTriggerConfig>, extra: Partial<DraftTrigger> = {}) {
  if (!draftTrigger) return;
  const next: Record<string, unknown> = { ...portalConfig, ...patch };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) delete next[key];
  }
  const { portalFieldsError: _err, ...rest } = draftTrigger;
  onTriggerChange({ ...rest, ...extra, portal: next as PortalTriggerConfig });
}
</script>

<!--
  Renders a trigger's icon tile (colored by category) followed by its type text.
  The icon is resolved by trigger subtype (manual/webhook/schedule/filewatcher)
  via visualForStepType, matching the graph trigger node.
-->
{#snippet triggerChip(triggerType: string)}
  {@const v = visualForStepType("trigger", { triggerType })}
  <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-white {v.tileClass}">
    <v.icon size={11} weight="bold" aria-hidden="true" />
  </span>
  {translateCore(`triggerTypes.${triggerType}` as CoreKey, { default: triggerType })}
{/snippet}

{#snippet runAsInfo(editing: boolean)}
  <div class="flex flex-col gap-0.5">
    <span class="text-xs font-medium text-muted-foreground">{t("triggerPanel.portalRunAs")}</span>
    {#if portalRunAs}
      <span class="text-xs {portalRunAs.usable ? "" : "text-destructive"}">
        {portalRunAs.usable
          ? portalRunAs.username
          : t("triggerPanel.portalRunAsUnusable", { username: portalRunAs.username })}
      </span>
      {#if editing}
        <span class="text-xs text-muted-foreground">{t("triggerPanel.portalRunAsRebind")}</span>
      {/if}
    {:else}
      <span class="text-xs text-muted-foreground">{t("triggerPanel.portalRunAsUnbound")}</span>
    {/if}
  </div>
{/snippet}

{#snippet portalEditor()}
  <p class="text-xs text-muted-foreground">{t("triggerPanel.portalHint")}</p>
  <div class="flex flex-col gap-1">
    <label for="portal-title" class="text-xs font-medium text-muted-foreground">{t("triggerPanel.portalTitle")}</label>
    <input
      id="portal-title"
      class={inputClass}
      maxlength="200"
      placeholder={t("triggerPanel.portalTitlePlaceholder")}
      value={portalConfig.title ?? ""}
      oninput={(e) => updatePortal({ title: (e.target as HTMLInputElement).value })}
    >
  </div>
  <div class="flex flex-col gap-1">
    <div class="flex items-center justify-between">
      <label for="portal-description" class="text-xs font-medium text-muted-foreground"
        >{t("triggerPanel.portalDescription")}</label
      >
      <ExpandButton label={t("triggerPanel.portalDescription")} onclick={() => (descriptionExpanded = true)} />
    </div>
    <textarea
      id="portal-description"
      rows="2"
      class={inputClass}
      maxlength="2000"
      placeholder={t("triggerPanel.portalDescriptionPlaceholder")}
      value={portalConfig.description ?? ""}
      oninput={(e) => updatePortal({ description: (e.target as HTMLTextAreaElement).value })}
    ></textarea>
    {#if descriptionExpanded}
      <ExpandedTextEditor
        title={t("triggerPanel.portalDescription")}
        value={portalConfig.description ?? ""}
        oninput={(v) => updatePortal({ description: v })}
        onClose={() => (descriptionExpanded = false)}
        maxlength={2000}
        placeholder={t("triggerPanel.portalDescriptionPlaceholder")}
      />
    {/if}
  </div>
  <div class="flex flex-col gap-1">
    <label for="portal-accept" class="text-xs font-medium text-muted-foreground"
      >{t("triggerPanel.portalAccept")}</label
    >
    <select
      id="portal-accept"
      class={inputClass}
      value={acceptChoice}
      onchange={(e) => {
        const value = (e.target as HTMLSelectElement).value;
        customAccept = value === CUSTOM_ACCEPT;
        if (!customAccept) updatePortal({ accept: value });
      }}
    >
      {#each ACCEPT_PRESETS as preset (preset.value)}
        <option value={preset.value}>{t(preset.labelKey)}</option>
      {/each}
      <option value={CUSTOM_ACCEPT}>{t("triggerPanel.portalAcceptCustom")}</option>
    </select>
    {#if acceptChoice === CUSTOM_ACCEPT}
      <input
        aria-label={t("triggerPanel.portalAccept")}
        class="{inputClass} font-mono"
        placeholder="image/*,application/pdf,.csv"
        value={portalConfig.accept ?? ""}
        oninput={(e) => updatePortal({ accept: (e.target as HTMLInputElement).value })}
      >
    {/if}
  </div>
  <div class="flex items-end gap-3">
    <label class="flex items-center gap-2 text-xs pb-1.5">
      <input
        type="checkbox"
        checked={portalConfig.fileRequired ?? true}
        onchange={(e) => {
          const checked = (e.target as HTMLInputElement).checked;
          updatePortal({ fileRequired: checked ? undefined : false });
        }}
      >
      {t("triggerPanel.portalFileRequired")}
    </label>
    <div class="flex flex-col gap-1 ml-auto w-28">
      <label for="portal-max-size" class="text-xs font-medium text-muted-foreground"
        >{t("triggerPanel.portalMaxSize")}</label
      >
      <input
        id="portal-max-size"
        type="number"
        min="1"
        max={PORTAL_UPLOAD_MAX_MB}
        class={inputClass}
        placeholder={String(PORTAL_UPLOAD_DEFAULT_MB)}
        value={portalConfig.maxSizeMb ?? ""}
        oninput={(e) => {
          const n = Number((e.target as HTMLInputElement).value);
          updatePortal({ maxSizeMb: n > 0 ? Math.min(n, PORTAL_UPLOAD_MAX_MB) : undefined });
        }}
      >
    </div>
  </div>
  <div class="flex flex-col gap-1">
    <label for="portal-roles" class="text-xs font-medium text-muted-foreground">{t("triggerPanel.portalRoles")}</label>
    <MultiSelect
      id="portal-roles"
      size="xs"
      items={roleNames}
      selected={portalConfig.roles ?? []}
      allowCustom
      placeholder={t("triggerPanel.portalRolesPlaceholder")}
      onchange={(roles) => updatePortal({ roles })}
    />
  </div>
  <div class="flex flex-col gap-1">
    <span class="inline-flex items-center gap-1">
      <span id="portal-fields-label" class="text-xs font-medium text-muted-foreground"
        >{t("triggerPanel.portalFields")}</span
      >
      <InfoTip text={t("triggerPanel.portalFieldsHint")} />
    </span>
    <FieldListEditor
      id="portal-fields"
      labelledBy="portal-fields-label"
      mode="form"
      value={portalConfig.fields}
      jsonPlaceholder={'{ "type": "object", "properties": { "note": { "type": "string", "title": "Note" } } }'}
      onChange={(fields) => updatePortal({ fields })}
      onError={(error) => updatePortal({}, error ? { portalFieldsError: error } : {})}
    />
    {#if validationErrors.get("trigger.portal.fields") && !draftTrigger?.portalFieldsError}
      <span class="text-xs text-destructive">{validationErrors.get("trigger.portal.fields")}</span>
    {/if}
  </div>
  {@render runAsInfo(true)}
{/snippet}

{#snippet portalSummary()}
  {@const config = trigger.portal ?? {}}
  <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
    <dt class="text-muted-foreground">{t("triggerPanel.portalTitle")}</dt>
    <dd class="min-w-0 break-words">{config.title || workflowName}</dd>
    <dt class="text-muted-foreground">{t("triggerPanel.portalAccept")}</dt>
    <dd class="font-mono">{config.accept || t("triggerPanel.portalAcceptAny")}</dd>
    <dt class="text-muted-foreground">{t("triggerPanel.portalMaxSize")}</dt>
    <dd>{config.maxSizeMb ?? PORTAL_UPLOAD_DEFAULT_MB}</dd>
    <dt class="text-muted-foreground">{t("triggerPanel.portalRoles")}</dt>
    <dd>{config.roles?.length ? config.roles.join(", ") : t("triggerPanel.portalRolesPlaceholder")}</dd>
  </dl>
  {#if config.fields}
    <div class="flex flex-col gap-1">
      <span class="text-xs font-medium text-muted-foreground">{t("triggerPanel.portalFields")}</span>
      <FieldListEditor id="portal-fields-view" mode="form" value={config.fields} readonly />
    </div>
  {/if}
  {@render runAsInfo(false)}
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
            const { portal, portalFieldsError: _err, ...rest } = draftTrigger;
            onTriggerChange({
              ...rest,
              type: newType,
              ref: REFLESS.includes(newType) || newType !== oldType ? "" : draftTrigger.ref,
              ...(newType === "portal" ? { portal: portal ?? {} } : {}),
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
      {#if draftTrigger.type === "portal"}
        {@render portalEditor()}
      {:else if draftTrigger.type !== "manual"}
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
      {#if trigger.type === "portal"}
        {@render portalSummary()}
      {/if}
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
