<script lang="ts">
import PencilRulerIcon from "phosphor-svelte/lib/PencilRulerIcon";
import { AlertDialog } from "$lib/components/ui/alert-dialog";
import { Button } from "$lib/components/ui/button";
/**
 * Banner shown while a workflow is a draft: it runs only by hand, not from its
 * trigger, another workflow, or the portal. Owns the confirmation of the
 * Activate action, which the page performs.
 */
import { t } from "$lib/i18n.svelte";

interface Props {
  /** Whether Activate is offered (hidden in edit mode, where the page has unsaved changes). */
  canActivate: boolean;
  /** Whether an activation is in flight. */
  activating: boolean;
  /** Activates the workflow (after confirmation). */
  onActivate: () => void;
}

let { canActivate, activating, onActivate }: Props = $props();

let confirming = $state(false);
</script>

<div
  class="mb-4 px-3 py-2 rounded-md border border-sky-500/50 bg-sky-500/10 text-sm shrink-0 flex flex-wrap items-center gap-x-3 gap-y-2"
>
  <PencilRulerIcon size={16} class="text-sky-600 dark:text-sky-400 shrink-0" aria-hidden="true" />
  <p class="flex-1 min-w-48 text-sky-700 dark:text-sky-300">
    <span class="font-medium">{t("workflows.draftBannerTitle")}</span>
    {t("workflows.draftBannerMessage")}
  </p>
  {#if canActivate}
    <Button
      size="sm"
      variant="default"
      disabled={activating}
      onclick={() => {
        confirming = true;
      }}
    >
      {activating ? t("workflows.activating") : t("workflows.activate")}
    </Button>
  {/if}
</div>

<AlertDialog
  open={confirming}
  title={t("workflows.activateTitle")}
  description={t("workflows.activateMessage")}
  confirmLabel={t("workflows.activate")}
  confirmVariant="default"
  onConfirm={() => {
    confirming = false;
    onActivate();
  }}
  onCancel={() => {
    confirming = false;
  }}
/>
