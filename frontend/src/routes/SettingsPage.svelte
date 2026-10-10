<script lang="ts">
import { Tabs } from "bits-ui";
import CheckCircleIcon from "phosphor-svelte/lib/CheckCircleIcon";
import GearIcon from "phosphor-svelte/lib/GearIcon";
import InfoIcon from "phosphor-svelte/lib/InfoIcon";
import WarningIcon from "phosphor-svelte/lib/WarningIcon";
import { untrack } from "svelte";
import { fly, slide } from "svelte/transition";
import { authFetch } from "$lib/auth";
import LoadingIndicator from "$lib/components/LoadingIndicator.svelte";
import NotificationBanner from "$lib/components/NotificationBanner.svelte";
import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
import { Badge } from "$lib/components/ui/badge";
import { Button } from "$lib/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "$lib/components/ui/table";
import { t, tx } from "$lib/i18n.svelte";
import { modelStore } from "$lib/modelStore.svelte";
import { settings } from "$lib/settingsStore.svelte";
import type { AvailableModel, ExtensionInfo, ModelIntent } from "../../../shared/types";
import GlobalSecretForm from "../components/GlobalSecretForm.svelte";
import GlobalVariableForm from "../components/GlobalVariableForm.svelte";
import IntentModelSelector from "../components/IntentModelSelector.svelte";
import ModelSelector from "../components/ModelSelector.svelte";
import SecretForm from "../components/SecretForm.svelte";
import SettingsForm from "../components/SettingsForm.svelte";

let extensions = $state<ExtensionInfo[]>([]);
let loading = $state(true);
let error = $state<string | null>(null);
let toggleError = $state<string | null>(null);
let toggleSuccess = $state<string | null>(null);
let toggleTimer: ReturnType<typeof setTimeout> | null = null;
let thinkingSuccess = $state<string | null>(null);
let thinkingTimer: ReturnType<typeof setTimeout> | null = null;

/** Available models for the intent selectors. */
let availableModels = $state<AvailableModel[]>([]);
/** Success/error message for intent model changes. */
let intentMessage = $state<string | null>(null);
let intentMessageTimer: ReturnType<typeof setTimeout> | null = null;

/** Status message emitted by ModelSelector via bindable prop. */
let modelStatusMessage = $state<string | null>(null);
/** Variant for the ModelSelector status message. */
let modelStatusVariant = $state<"success" | "error" | "info" | "accent">("info");

/** Merged banner message for the Models tab (priority: modelSelector > thinking > intent > default info). */
let bannerMessage = $derived(modelStatusMessage ?? thinkingSuccess ?? intentMessage ?? t("settings.changesNextJob"));
/** Merged banner variant for the Models tab. */
let bannerVariant = $derived<"success" | "error" | "info" | "accent">(
  modelStatusMessage ? modelStatusVariant : thinkingSuccess ? "success" : intentMessage ? "success" : "info",
);

/** Currently open settings panel (extension name) or null. */
let settingsOpen = $state<string | null>(null);

/** Fetched settings data for the open panel. */
let settingsData = $state<{ schema: Record<string, unknown>; values: Record<string, unknown> } | null>(null);

/** Whether settings are currently loading. */
let settingsLoading = $state(false);

/** Whether the secret vault is available. `null` = not yet checked, `true` = available, `false` = disabled. */
let vaultAvailable = $state<boolean | null>(null);

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && settingsOpen) {
    settingsOpen = null;
    settingsData = null;
  }
}

$effect(() => {
  if (settingsOpen) {
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }
});

function toggleThinking() {
  settings.toggleThinkingExpanded();
  thinkingSuccess = settings.thinkingExpanded ? t("settings.thinkingExpanded") : t("settings.thinkingCollapsed");
  if (thinkingTimer) clearTimeout(thinkingTimer);
  thinkingTimer = setTimeout(() => (thinkingSuccess = null), 3000);
}

async function handleIntentChange(intent: ModelIntent, modelId: string | null) {
  intentMessage = null;
  let success: boolean;
  if (modelId) {
    success = await modelStore.setIntentModel(intent, modelId);
  } else {
    success = await modelStore.clearIntentModel(intent);
  }
  if (success) {
    intentMessage = modelId
      ? t("settings.intentSet", { intent, model: modelId })
      : t("settings.intentReset", { intent });
  } else {
    intentMessage = t("settings.intentUpdateFailed", { intent });
  }
  if (intentMessageTimer) clearTimeout(intentMessageTimer);
  intentMessageTimer = setTimeout(() => (intentMessage = null), 3000);
}

async function fetchExtensions() {
  loading = true;
  error = null;
  try {
    const res = await authFetch("/api/extensions");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    extensions = (await res.json()).sort((a: ExtensionInfo, b: ExtensionInfo) => a.name.localeCompare(b.name));
    // Check vault availability if any extension has secretsSchema
    const extWithSecrets = extensions.find((e) => e.secretsSchema);
    if (extWithSecrets) {
      checkVaultAvailability(extWithSecrets.name);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : t("settings.loadExtensionsFailed");
  } finally {
    loading = false;
  }
}

/** Probes vault availability by attempting a secrets fetch for one extension. */
async function checkVaultAvailability(extName: string) {
  try {
    const res = await authFetch(`/api/extensions/${extName}/secrets`);
    vaultAvailable = res.status !== 503;
  } catch {
    vaultAvailable = false;
  }
}

async function toggleExtension(ext: ExtensionInfo) {
  const previous = ext.enabled;
  extensions = extensions.map((e) => (e.name === ext.name ? { ...e, enabled: !previous } : e));
  toggleSuccess = null;
  toggleError = null;

  try {
    const res = await authFetch(`/api/extensions/${ext.name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !previous }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    toggleSuccess = t(!previous ? "settings.extensionEnabled" : "settings.extensionDisabled", { name: ext.name });
    if (toggleTimer) clearTimeout(toggleTimer);
    toggleTimer = setTimeout(() => (toggleSuccess = null), 3000);
  } catch (err) {
    extensions = extensions.map((e) => (e.name === ext.name ? { ...e, enabled: previous } : e));
    toggleError = err instanceof Error ? err.message : t("settings.toggleFailed");
    if (toggleTimer) clearTimeout(toggleTimer);
    toggleTimer = setTimeout(() => (toggleError = null), 5000);
  }
}

function formatStats(ext: ExtensionInfo): string {
  const parts: string[] = [];
  if (ext.toolCount > 0) parts.push(t("settings.tools", { count: ext.toolCount }));
  if (ext.routeCount > 0) parts.push(t("settings.routes", { count: ext.routeCount }));
  if (ext.queueCount > 0) parts.push(t("settings.queues", { count: ext.queueCount }));
  if (ext.skillCount > 0) parts.push(t("settings.skills", { count: ext.skillCount }));
  return parts.length > 0 ? parts.join(", ") : "-";
}

async function openSettings(ext: ExtensionInfo) {
  if (settingsOpen === ext.name) {
    settingsOpen = null;
    settingsData = null;
    return;
  }
  settingsOpen = ext.name;
  settingsData = null;
  settingsLoading = true;
  try {
    if (ext.settingsSchema) {
      const res = await authFetch(`/api/extensions/${ext.name}/settings`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      settingsData = await res.json();
    }
  } catch {
    settingsData = null;
  } finally {
    settingsLoading = false;
  }
}

const SETTINGS_TAB_KEY = "settings-active-tab";
let activeTab = $state(sessionStorage.getItem(SETTINGS_TAB_KEY) ?? "model");

function onTabChange(tab: string) {
  activeTab = tab;
  sessionStorage.setItem(SETTINGS_TAB_KEY, tab);
}

$effect(() => {
  untrack(() => {
    fetchExtensions();
  });
});
</script>

<Tabs.Root value={activeTab} onValueChange={onTabChange} class="space-y-4">
  <Tabs.List class="flex gap-1 border-b border-border">
    <Tabs.Trigger
      value="model"
      class="px-3 py-1.5 text-sm font-medium text-muted-foreground data-[state=active]:text-foreground data-[state=active]:border-b-2 data-[state=active]:border-primary -mb-px"
    >
      {t("settings.tabModels")}
    </Tabs.Trigger>
    <Tabs.Trigger
      value="extensions"
      class="px-3 py-1.5 text-sm font-medium text-muted-foreground data-[state=active]:text-foreground data-[state=active]:border-b-2 data-[state=active]:border-primary -mb-px"
    >
      {t("settings.tabExtensions")}
    </Tabs.Trigger>
    <Tabs.Trigger
      value="variables"
      class="px-3 py-1.5 text-sm font-medium text-muted-foreground data-[state=active]:text-foreground data-[state=active]:border-b-2 data-[state=active]:border-primary -mb-px"
    >
      {t("settings.tabVariables")}
    </Tabs.Trigger>
    <Tabs.Trigger
      value="secrets"
      class="px-3 py-1.5 text-sm font-medium text-muted-foreground data-[state=active]:text-foreground data-[state=active]:border-b-2 data-[state=active]:border-primary -mb-px"
    >
      {t("settings.tabSecrets")}
    </Tabs.Trigger>
  </Tabs.List>

  <Tabs.Content value="model" class="space-y-4">
    <NotificationBanner message={bannerMessage} variant={bannerVariant} timeout={0} />
    <h3 class="text-sm font-semibold text-foreground">{t("settings.defaultModel")}</h3>
    <ModelSelector
      bind:statusMessage={modelStatusMessage}
      bind:statusVariant={modelStatusVariant}
      bind:availableModels
    />
    <div class="flex items-center justify-between rounded-md border border-border px-3 py-2">
      <div>
        <p class="text-sm font-medium">{t("settings.expandThinking")}</p>
        <p class="text-xs text-muted-foreground">{t("settings.expandThinkingHint")}</p>
      </div>
      <ToggleSwitch
        checked={settings.thinkingExpanded}
        onChange={() => toggleThinking()}
        aria-label={t("settings.toggleThinking")}
      />
    </div>
    <div class="space-y-2">
      <h3 class="text-sm font-semibold text-foreground">{t("settings.intentModels")}</h3>
      <p class="text-xs text-muted-foreground">
        {t("settings.intentModelsHint")}
      </p>
      <IntentModelSelector
        intent="vision"
        label={t("settings.intentVision")}
        description={t("settings.intentVisionHint")}
        models={availableModels}
        selectedModelId={modelStore.intents.vision}
        defaultModelId={modelStore.selectedModelId}
        onchange={handleIntentChange}
      />
      <IntentModelSelector
        intent="embedding"
        label={t("settings.intentEmbedding")}
        description={t("settings.intentEmbeddingHint")}
        models={availableModels}
        selectedModelId={modelStore.intents.embedding}
        defaultModelId={modelStore.selectedModelId}
        onchange={handleIntentChange}
      />
    </div>
  </Tabs.Content>

  <Tabs.Content value="extensions" class="space-y-3">
    {#if toggleSuccess}
      <div
        class="flex items-center gap-2 text-sm border border-background px-3 py-2 text-green-600 dark:text-green-400"
      >
        <CheckCircleIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>{toggleSuccess}</span>
      </div>
    {:else if toggleError}
      <div
        class="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm bg-muted/50 text-destructive dark:text-red-400"
      >
        <WarningIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>{toggleError}</span>
      </div>
    {:else}
      <div
        class="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
      >
        <InfoIcon class="w-4 h-4 shrink-0" aria-hidden="true" />
        <span>{t("settings.disableWarning")}</span>
      </div>
    {/if}

    {#if loading}
      <LoadingIndicator />
    {:else if error}
      <p class="text-sm text-destructive">{error}</p>
    {:else if extensions.length === 0}
      <p class="text-sm text-muted-foreground">{t("settings.noExtensions")}</p>
    {:else}
      <div class="rounded-md border border-border">
        <Table>
          <TableHeader class="bg-muted/30">
            <TableRow>
              <TableHead class="w-4 text-center"></TableHead>
              <TableHead>{t("common.name")}</TableHead>
              <TableHead class="w-20">{t("settings.colVersion")}</TableHead>
              <TableHead class="w-20">{t("settings.colSource")}</TableHead>
              <TableHead class="hidden xl:table-cell lg:table-cell">{t("common.description")}</TableHead>
              <TableHead class="hidden xl:table-cell">{t("settings.colStats")}</TableHead>
              <TableHead class="w-16 text-right">{t("settings.colEnabled")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each extensions as ext (ext.name)}
              <TableRow>
                <TableCell>
                  {#if ext.settingsSchema || ext.secretsSchema}
                    <Button
                      variant="ghost"
                      size="icon"
                      class="h-7 w-7 p-0"
                      aria-label={t("settings.settingsFor", { name: ext.name })}
                      onclick={() => openSettings(ext)}
                    >
                      <GearIcon class="w-4 h-4" aria-hidden="true" />
                    </Button>
                  {/if}
                </TableCell>
                <TableCell class="font-medium">
                  <span class="inline-flex items-center gap-1.5">
                    {#if ext.settingsSchema || ext.secretsSchema}
                      <a
                        href="#settings-{ext.name}"
                        class="text-left"
                        onclick={(e) => {
                          e.preventDefault();
                          openSettings(ext);
                        }}
                      >
                        {ext.name}
                      </a>
                    {:else}
                      {ext.name}
                    {/if}
                    {#if ext.error}
                      <span title={ext.error} class="text-destructive dark:text-red-400 cursor-help">
                        <WarningIcon class="w-4 h-4" aria-label={t("settings.initError", { error: ext.error })} />
                      </span>
                    {/if}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" class="text-xs font-normal">v{ext.version}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={ext.source === "external" ? "default" : "secondary"} class="text-xs font-normal"
                    >{t(`settings.source.${ext.source}`)}</Badge
                  >
                </TableCell>
                <TableCell class="hidden lg:table-cell text-xs text-muted-foreground">
                  {ext.description ? tx(ext.name, "description", ext.description) : "-"}
                </TableCell>
                <TableCell class="text-muted-foreground hidden xl:table-cell"> {formatStats(ext)} </TableCell>
                <TableCell class="text-right">
                  {#if ext.core !== true}
                    <ToggleSwitch
                      checked={ext.enabled}
                      onChange={() => toggleExtension(ext)}
                      aria-label={ext.enabled
                        ? t("settings.disableExt", { name: ext.name })
                        : t("settings.enableExt", { name: ext.name })}
                    />
                  {/if}
                </TableCell>
              </TableRow>
              {#if settingsOpen === ext.name}
                <TableRow>
                  <TableCell colspan={7} class="p-0! bg-muted/30">
                    <div in:fly={{ y: -10, duration: 300 }} out:slide={{ duration: 200 }}>
                      <div class="p-4 space-y-6">
                        {#if settingsLoading}
                          <LoadingIndicator />
                        {:else if settingsData}
                          <SettingsForm
                            extensionName={ext.name}
                            schema={settingsData.schema}
                            initialValues={settingsData.values}
                          />
                        {:else if ext.settingsSchema}
                          <p class="text-sm text-muted-foreground">{t("settings.loadSettingsFailed")}</p>
                        {/if}

                        {#if ext.secretsSchema && vaultAvailable}
                          {#if settingsData || !ext.settingsSchema}
                            {#if ext.settingsSchema}
                              <hr class="border-border">
                              <h4 class="text-sm font-semibold text-foreground">{t("settings.secrets")}</h4>
                            {/if}
                            <SecretForm extensionName={ext.name} schema={ext.secretsSchema} />
                          {/if}
                        {/if}
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              {/if}
            {/each}
          </TableBody>
        </Table>
      </div>
    {/if}
  </Tabs.Content>

  <Tabs.Content value="variables" class="space-y-3">
    <GlobalVariableForm />
  </Tabs.Content>

  <Tabs.Content value="secrets" class="space-y-3">
    <GlobalSecretForm />
  </Tabs.Content>
</Tabs.Root>
