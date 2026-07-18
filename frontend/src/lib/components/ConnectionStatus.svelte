<script lang="ts">
let { connected }: { connected: boolean } = $props();
</script>

<div class="connection-status">
  <div class="status-indicator {connected ? 'connected' : 'disconnected'}"></div>
  <span class="status-text"> {connected ? 'Connected' : 'Disconnected'} </span>
</div>

<style>
.connection-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-radius: 0.375rem;
  background-color: hsl(var(--muted));
}

.status-indicator {
  width: 0.75rem;
  height: 0.75rem;
  border-radius: 50%;
  transition: background-color 0.3s ease;
}

.status-indicator.connected {
  background-color: hsl(142, 76%, 36%);
  box-shadow: 0 0 0 2px hsla(142, 76%, 36%, 0.2);
}

.status-indicator.disconnected {
  background-color: hsl(0, 84%, 60%);
  box-shadow: 0 0 0 2px hsla(0, 84%, 60%, 0.2);
}

.status-text {
  font-size: 0.875rem;
  font-weight: 500;
  color: hsl(var(--foreground));
}
</style>
