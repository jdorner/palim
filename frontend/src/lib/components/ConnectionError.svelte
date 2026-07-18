<script lang="ts">
import WifiSlashIcon from "phosphor-svelte/lib/WifiSlashIcon";
import { onDestroy, onMount } from "svelte";

let retrying = $state(false);
let countdown = $state(0);
let retryInterval: ReturnType<typeof setInterval> | null = null;

const RETRY_SECONDS = 5;

function startCountdown() {
  countdown = RETRY_SECONDS;
  retryInterval = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      clearInterval(retryInterval!);
      retryInterval = null;
      attemptReconnect();
    }
  }, 1000);
}

async function attemptReconnect() {
  retrying = true;
  if (retryInterval) clearInterval(retryInterval);

  try {
    const res = await fetch("/api/auth/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "" }),
    });
    if (res.status < 500) {
      // Server is back - reload the page to reinitialize everything
      window.location.reload();
      return;
    }
  } catch {
    // Still unreachable
  }
  retrying = false;
  startCountdown();
}

onMount(() => {
  startCountdown();
});

onDestroy(() => {
  if (retryInterval) clearInterval(retryInterval);
});
</script>

<div class="flex items-center justify-center min-h-screen bg-background">
  <div class="w-full max-w-md p-8 text-center space-y-6">
    <div class="flex justify-center">
      <WifiSlashIcon class="w-16 h-16 text-muted-foreground" />
    </div>
    <div class="space-y-2">
      <h1 class="text-2xl font-bold">Connection Error</h1>
      <p class="text-muted-foreground">Unable to reach the server. It may be down or restarting.</p>
    </div>
    <div class="space-y-3">
      {#if retrying}
        <p class="text-sm text-muted-foreground">Attempting to reconnect...</p>
      {:else}
        <p class="text-sm text-muted-foreground">Retrying in {countdown}s...</p>
      {/if}
      <button
        type="button"
        onclick={attemptReconnect}
        disabled={retrying}
        class="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground
          hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
      >
        {retrying ? "Connecting..." : "Retry Now"}
      </button>
    </div>
  </div>
</div>
