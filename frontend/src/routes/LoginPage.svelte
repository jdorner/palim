<script lang="ts">
import { resetAuthCache, setToken } from "$lib/auth";
import { navigate } from "../router";

let token = "";
let error = "";
let submitting = false;

async function handleSubmit() {
  error = "";
  submitting = true;
  try {
    const res = await fetch("/api/auth/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    if (data.valid) {
      setToken(token);
      resetAuthCache();
      navigate("/");
    } else {
      error = "Invalid token. Please try again.";
    }
  } catch {
    error = "Could not reach the server.";
  } finally {
    submitting = false;
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !submitting) handleSubmit();
}
</script>

<div class="flex items-center justify-center min-h-screen bg-background">
  <div class="w-full max-w-sm p-6 space-y-6">
    <div class="text-center space-y-2">
      <h1 class="text-2xl font-bold">Authentication Required</h1>
      <p class="text-sm text-muted-foreground">Enter the access token to continue.</p>
    </div>

    <div class="space-y-4">
      <div class="space-y-2">
        <label for="auth-token" class="text-sm font-medium">Access Token</label>
        <input
          id="auth-token"
          type="password"
          bind:value={token}
          onkeydown={handleKeydown}
          placeholder="Enter token"
          class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background
            placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2
            focus-visible:ring-ring focus-visible:ring-offset-2"
          disabled={submitting}
        >
      </div>

      {#if error}
        <p class="text-sm text-destructive">{error}</p>
      {/if}

      <button
        type="button"
        onclick={handleSubmit}
        disabled={submitting || !token}
        class="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground
          hover:bg-primary/90 disabled:opacity-50 disabled:pointer-events-none"
      >
        {submitting ? "Validating..." : "Sign In"}
      </button>
    </div>
  </div>
</div>
