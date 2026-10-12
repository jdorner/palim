<!-- Starts one workflow: pick or take a photo/file, fill the fields, send. -->
<script lang="ts">
import { Button } from "@palim/ui";
import ArrowLeftIcon from "phosphor-svelte/lib/ArrowLeftIcon";
import CameraIcon from "phosphor-svelte/lib/CameraIcon";
import CheckCircleIcon from "phosphor-svelte/lib/CheckCircleIcon";
import FileIcon from "phosphor-svelte/lib/FileIcon";
import PaperclipIcon from "phosphor-svelte/lib/PaperclipIcon";
import { ApiError } from "$app/api";
import FormFields from "$app/FormFields.svelte";
import { collectData, formFields, initialValues } from "$app/form";
import { i18n, t } from "$app/i18n.svelte";
import { matchesAccept } from "$shared/portal";
import { launchers } from "./store.svelte";

let { params }: { params: Record<string, string> } = $props();

let file = $state<File | null>(null);
let preview = $state<string | null>(null);
let values = $state<Record<string, unknown>>({});
let fieldErrors = $state<Record<string, string>>({});
let submitting = $state(false);
let message = $state<string | null>(null);
let started = $state(false);

if (!launchers.loaded) void launchers.load();

const launcher = $derived(launchers.items.find((item) => item.name === params.name) ?? null);
const fields = $derived(formFields(launcher?.fields ?? null));
/** Whether a camera capture makes sense for the accepted types. */
const acceptsImages = $derived(!launcher?.accept || matchesAccept(launcher.accept, "image/jpeg", "photo.jpg"));

// Fresh form values when the launcher (or its fields) change.
$effect(() => {
  values = initialValues(fields);
});

// Release the preview URL when it is replaced or the page closes.
$effect(() => {
  const url = preview;
  return () => {
    if (url) URL.revokeObjectURL(url);
  };
});

/** Takes the file picked by an input and checks it against the launcher. */
function pick(event: Event) {
  const input = event.currentTarget as HTMLInputElement;
  const picked = input.files?.[0] ?? null;
  input.value = "";
  if (!picked || !launcher) return;
  message = null;
  if (picked.size > launcher.maxSizeMb * 1024 * 1024) {
    message = t("launch.fileTooLarge", { size: launcher.maxSizeMb });
    return;
  }
  // Browsers may not know a type (then the server decides).
  if (picked.type && !matchesAccept(launcher.accept, picked.type, picked.name)) {
    message = t("launch.fileType");
    return;
  }
  file = picked;
  preview = picked.type.startsWith("image/") ? URL.createObjectURL(picked) : null;
}

function clearFile() {
  file = null;
  preview = null;
}

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1
    ? `${i18n.current.format.number(mb, { maximumFractionDigits: 1 })} MB`
    : `${i18n.current.format.number(Math.max(1, Math.round(bytes / 1024)))} KB`;
}

async function submit() {
  if (!launcher) return;
  message = null;
  fieldErrors = {};
  if (launcher.fileRequired && !file) {
    message = t("launch.fileMissing");
    return;
  }
  const { data, missing } = collectData(fields, values);
  if (missing.length > 0) {
    const labels = fields.filter((f) => missing.includes(f.key)).map((f) => f.label);
    for (const key of missing) fieldErrors[key] = t("form.required");
    message = t("form.missingFields", { fields: labels.join(", ") });
    return;
  }

  submitting = true;
  try {
    await launchers.start(launcher.name, file, data);
    started = true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) message = t("launch.notAvailable");
    else if (err instanceof ApiError && err.status === 409) message = t("launch.notConfigured");
    else if (err instanceof ApiError && err.status === 413)
      message = t("launch.fileTooLarge", { size: launcher.maxSizeMb });
    else if (err instanceof ApiError && err.status === 415) message = t("launch.fileType");
    else if (err instanceof ApiError && err.status === 422 && err.details?.length) {
      for (const detail of err.details)
        fieldErrors[detail.path.replace(/^\//, "").split("/")[0] ?? ""] = detail.message;
      message = err.message;
    } else {
      message = t("launch.submitFailed", { message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    submitting = false;
  }
}

function again() {
  started = false;
  clearFile();
  values = initialValues(fields);
  fieldErrors = {};
  message = null;
}
</script>

<div class="space-y-5">
  {#if launchers.items.length !== 1}
    <a
      href="#/start"
      class="inline-flex items-center gap-1 text-sm text-muted-foreground no-underline hover:text-foreground"
    >
      <ArrowLeftIcon size={14} aria-hidden="true" />
      {t("launch.back")}
    </a>
  {/if}

  {#if launchers.error && !launchers.loaded}
    <div class="space-y-2 rounded-lg border p-4 text-sm">
      <p class="text-destructive">{t("launch.loadFailed", { message: launchers.error })}</p>
      <Button size="sm" variant="outline" onclick={() => launchers.load()}>{t("launch.retry")}</Button>
    </div>
  {:else if !launchers.loaded}
    <p class="py-8 text-center text-sm text-muted-foreground">{t("app.loading")}</p>
  {:else if !launcher}
    <p class="rounded-lg border p-4 text-sm">{t("launch.notAvailable")}</p>
  {:else if started}
    <section class="space-y-4 rounded-lg border p-6 text-center">
      <CheckCircleIcon size={48} class="mx-auto text-green-600 dark:text-green-400" aria-hidden="true" />
      <div class="space-y-1">
        <h2 class="text-lg font-semibold">{t("launch.started")}</h2>
        <p class="text-sm text-muted-foreground">{t("launch.startedDescription", { title: launcher.title })}</p>
      </div>
      <Button onclick={again}>{t("launch.again")}</Button>
    </section>
  {:else}
    <header class="space-y-1">
      <h2 class="text-xl font-semibold leading-tight">{launcher.title}</h2>
      {#if launcher.description}
        <p class="whitespace-pre-wrap text-sm text-muted-foreground">{launcher.description}</p>
      {/if}
    </header>

    <form
      class="space-y-5"
      onsubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <section class="space-y-3 rounded-lg border p-4">
        <h3 class="text-sm font-semibold">
          {acceptsImages ? t("launch.photo") : t("launch.file")}
          {#if launcher.fileRequired}
            <span class="text-destructive" title={t("form.required")}>*</span>
          {/if}
        </h3>

        {#if file}
          <div class="space-y-3">
            {#if preview}
              <img src={preview} alt={file.name} class="max-h-72 w-full rounded-md border object-contain">
            {:else}
              <div class="flex items-center gap-3 rounded-md border p-3">
                <FileIcon size={28} class="shrink-0 text-muted-foreground" aria-hidden="true" />
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium">{file.name}</p>
                  <p class="text-xs text-muted-foreground">{formatSize(file.size)}</p>
                </div>
              </div>
            {/if}
            <div class="flex gap-2">
              <label
                class="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              >
                <input
                  type="file"
                  class="sr-only"
                  accept={launcher.accept ?? undefined}
                  onchange={pick}
                  disabled={submitting}
                >
                {t("launch.replace")}
              </label>
              <Button type="button" size="sm" variant="ghost" onclick={clearFile} disabled={submitting}>
                {t("launch.remove")}
              </Button>
            </div>
          </div>
        {:else}
          <div class="grid gap-2 {acceptsImages ? "grid-cols-2" : "grid-cols-1"}">
            {#if acceptsImages}
              <label
                class="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed px-3 py-6 text-sm font-medium hover:bg-accent focus-within:ring-2 focus-within:ring-ring"
              >
                <input type="file" class="sr-only" accept="image/*" capture="environment" onchange={pick}>
                <CameraIcon size={28} aria-hidden="true" />
                {t("launch.takePhoto")}
              </label>
            {/if}
            <label
              class="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed px-3 py-6 text-sm font-medium hover:bg-accent focus-within:ring-2 focus-within:ring-ring"
            >
              <input type="file" class="sr-only" accept={launcher.accept ?? undefined} onchange={pick}>
              <PaperclipIcon size={28} aria-hidden="true" />
              {t("launch.chooseFile")}
            </label>
          </div>
          <p class="text-xs text-muted-foreground">{t("launch.fileHint", { size: launcher.maxSizeMb })}</p>
        {/if}
      </section>

      {#if fields.length > 0}
        <section class="space-y-4 rounded-lg border p-4">
          <h3 class="text-sm font-semibold">{t("launch.details")}</h3>
          <FormFields {fields} bind:values errors={fieldErrors} disabled={submitting} />
        </section>
      {/if}

      <!-- Pinned above the phone tab bar (h-14 + safe area), at the bottom on larger screens. -->
      <div
        class="sticky bottom-[calc(3.5rem+env(safe-area-inset-bottom))] -mx-4 space-y-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:bottom-0 sm:mx-0 sm:border-t-0 sm:px-0"
      >
        {#if message}
          <p class="text-sm text-destructive" role="alert">{message}</p>
        {/if}
        <Button type="submit" class="w-full sm:w-auto" disabled={submitting}>
          {submitting ? t("launch.submitting") : t("launch.submit")}
        </Button>
      </div>
    </form>
  {/if}
</div>
