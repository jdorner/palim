<script lang="ts">
/** Read-only view of an agent step: tools, skills, and the rendered prompt. */
import { Badge } from "$lib/components/ui/badge";
import { t } from "$lib/i18n.svelte";
import type { PanelStep } from "$lib/stepConfig";
import ChatMarkdown from "../ChatMarkdown.svelte";

interface Props {
  step: PanelStep;
}

let { step }: Props = $props();
</script>

<div class="space-y-3">
  <div class="flex items-center gap-1.5 flex-wrap">
    <span class="text-xs font-medium text-muted-foreground">{t("stepSidebar.toolsLabel")}</span>
    {#if step.tools?.length}
      {#each step.tools as tool}
        <Badge variant="outline" class="text-xs">{tool}</Badge>
      {/each}
    {:else}
      <Badge variant="outline" class="text-xs">none</Badge>
    {/if}
  </div>

  <div class="flex items-center gap-1.5 flex-wrap">
    <span class="text-xs font-medium text-muted-foreground">{t("stepSidebar.skillsLabel")}</span>
    {#if step.skills?.length}
      {#each step.skills as skill}
        <Badge variant="outline" class="text-xs">{skill}</Badge>
      {/each}
    {:else}
      <Badge variant="outline" class="text-xs">none</Badge>
    {/if}
  </div>

  <div>
    <span class="text-xs font-medium text-muted-foreground">{t("stepSidebar.promptLabel")}</span>
    <div class="text-xs whitespace-pre-wrap wrap-break-word bg-muted p-3 rounded mt-1">
      <ChatMarkdown content={step.prompt ?? ""} />
    </div>
  </div>
</div>
