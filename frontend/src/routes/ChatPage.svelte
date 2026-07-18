<script lang="ts">
import ChatView from "../components/ChatView.svelte";
import { route } from "../router";

let conversationId = $derived(route.params.conversationId ?? null);
</script>

<div class="flex-1 min-h-0"><ChatView {conversationId} /></div>
