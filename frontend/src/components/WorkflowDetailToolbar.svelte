<script lang="ts">
import { DropdownMenu } from "bits-ui";
import ArrowUUpLeftIcon from "phosphor-svelte/lib/ArrowUUpLeftIcon";
import ArrowUUpRightIcon from "phosphor-svelte/lib/ArrowUUpRightIcon";
import DotsThreeVerticalIcon from "phosphor-svelte/lib/DotsThreeVerticalIcon";
import PencilSimpleIcon from "phosphor-svelte/lib/PencilSimpleIcon";
import PlayIcon from "phosphor-svelte/lib/PlayIcon";
import TrashIcon from "phosphor-svelte/lib/TrashIcon";
import { Button } from "$lib/components/ui/button";
import { buttonVariants } from "$lib/components/ui/button/button.svelte";
/**
 * Header bar of the workflow detail page: back button, title, and the
 * mode-dependent actions (Undo/Redo/Save/Cancel in edit mode; Edit/Run/Delete otherwise,
 * collapsing into a dropdown on narrow screens). Owns the delete confirmation.
 */
import { t } from "$lib/i18n.svelte";
import { navigate } from "../router";

interface Props {
  /** Workflow name shown as the title. */
  name: string;
  /** Optional description shown next to the title in view mode. */
  description?: string;
  /** Whether the page is in edit mode. */
  editMode: boolean;
  /** Whether a save is in flight. */
  saving: boolean;
  /** Whether the Save button is disabled. */
  saveDisabled: boolean;
  /** Whether there is a draft change to undo. */
  canUndo: boolean;
  /** Whether there is an undone draft change to redo. */
  canRedo: boolean;
  /** Undo the last draft change. */
  onUndo: () => void;
  /** Redo the last undone draft change. */
  onRedo: () => void;
  /** Save the edit draft. */
  onSave: () => void;
  /** Leave edit mode, discarding changes. */
  onCancelEdit: () => void;
  /** Enter edit mode. */
  onEdit: () => void;
  /** Start a workflow run. */
  onRun: () => void;
  /** Delete the workflow (after confirmation). */
  onDelete: () => void;
}

let {
  name,
  description,
  editMode,
  saving,
  saveDisabled,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSave,
  onCancelEdit,
  onEdit,
  onRun,
  onDelete,
}: Props = $props();

let confirmingDelete = $state(false);
</script>

<div class="flex items-center justify-between gap-2 mb-4 shrink-0">
  <div class="flex items-center gap-3 min-w-0">
    <Button
      size="sm"
      variant="outline"
      onclick={() => {
        navigate("/workflows");
      }}
    >
      &laquo;&nbsp;{t("common.back")}
    </Button>
    <h2 class="text-lg font-semibold truncate">{name}</h2>
    {#if !editMode && description}
      <span class="hidden md:inline text-sm text-muted-foreground truncate">{description}</span>
    {/if}
  </div>
  <div class="flex items-center gap-2 shrink-0">
    {#if editMode}
      <Button
        size="sm"
        variant="ghost"
        class="min-w-0! w-9! p-0!"
        onclick={onUndo}
        disabled={!canUndo}
        title={t("workflows.undoTitle")}
        aria-label={t("workflows.undo")}
      >
        <ArrowUUpLeftIcon size={16} aria-hidden="true" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        class="min-w-0! w-9! p-0!"
        onclick={onRedo}
        disabled={!canRedo}
        title={t("workflows.redoTitle")}
        aria-label={t("workflows.redo")}
      >
        <ArrowUUpRightIcon size={16} aria-hidden="true" />
      </Button>
      <Button size="sm" variant="default" onclick={onSave} disabled={saveDisabled}>
        {#if saving}
          {t("common.saving")}
        {:else}
          {t("common.save")}
        {/if}
      </Button>
      <Button size="sm" variant="outline" onclick={onCancelEdit}>{t("common.cancel")}</Button>
    {:else if confirmingDelete}
      <span class="text-sm font-bold text-destructive">{t("workflows.confirmDelete")}</span>
      <Button size="sm" variant="destructive" onclick={() => onDelete()}>{t("common.confirm")}</Button>
      <Button
        size="sm"
        variant="outline"
        onclick={() => {
          confirmingDelete = false;
        }}
        >{t("common.cancel")}</Button
      >
    {:else}
      <!-- Wide: full inline buttons -->
      <div class="hidden xl:flex items-center gap-2">
        <Button size="sm" variant="outline" onclick={onEdit}>
          <PencilSimpleIcon size={14} class="mr-1.5" aria-hidden="true" />
          {t("common.edit")}
        </Button>
        <Button size="sm" variant="default" class="text-nowrap" onclick={onRun}>
          <PlayIcon size={14} class="mr-1.5" aria-hidden="true" />
          {t("workflows.runWorkflow")}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onclick={() => {
            confirmingDelete = true;
          }}
        >
          <TrashIcon size={14} class="mr-1.5" aria-hidden="true" />
          {t("common.delete")}
        </Button>
      </div>

      <!-- Narrow: primary action stays inline, the rest collapse into a menu -->
      <div class="flex xl:hidden items-center gap-2">
        <Button size="sm" variant="default" class="text-nowrap" onclick={onRun}>
          <PlayIcon size={14} class="mr-1.5" aria-hidden="true" />
          {t("workflows.runWorkflow")}
        </Button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class={`${buttonVariants({ variant: "outline", size: "sm" })} min-w-0! w-10! p-0! shrink-0`}
            aria-label={t("workflows.moreActions")}
          >
            <DotsThreeVerticalIcon size={16} aria-hidden="true" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              class="z-9999 min-w-40 rounded-md border border-border bg-background p-1 shadow-lg"
            >
              <DropdownMenu.Item
                class="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm cursor-pointer outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                onSelect={onEdit}
              >
                <PencilSimpleIcon size={14} aria-hidden="true" />
                {t("common.edit")}
              </DropdownMenu.Item>
              <DropdownMenu.Separator class="my-1 h-px bg-border" />
              <DropdownMenu.Item
                class="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm cursor-pointer outline-none text-destructive data-highlighted:bg-destructive/10"
                onSelect={() => {
                  confirmingDelete = true;
                }}
              >
                <TrashIcon size={14} aria-hidden="true" />
                {t("common.delete")}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    {/if}
  </div>
</div>
