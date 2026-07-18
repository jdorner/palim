/**
 * Reactive read/unread tracking for conversations.
 * Backed by localStorage for persistence
 */

const STORAGE_KEY = "conversation-read-state";

/** Loads the read-state map from localStorage. */
function load(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Persists the read-state map to localStorage. */
function persist(state: Record<string, number>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/**
 * Reactive read-state store using Svelte 5 runes.
 * All methods mutate `$state` so dependents auto-update.
 */
class ReadState {
  /** Per-conversation last-read timestamps. Reactive - triggers derived re-evaluation on mutation. */
  timestamps = $state<Record<string, number>>(load());

  /**
   * Marks a conversation as read at the current time.
   * @param conversationId - The conversation ID to mark as read.
   */
  markRead(conversationId: string): void {
    this.timestamps = { ...this.timestamps, [conversationId]: Date.now() };
    persist(this.timestamps);
  }

  /**
   * Determines whether a conversation has unread messages.
   * @param conversationId - The conversation ID to check.
   * @param updatedAt - The conversation's last update timestamp.
   * @returns True if the conversation is unread.
   */
  isUnread(conversationId: string, updatedAt: number): boolean {
    const lastRead = this.timestamps[conversationId];
    return lastRead === undefined || updatedAt > lastRead;
  }

  /**
   * Removes entries for conversations that no longer exist.
   * @param activeIds - The set of conversation IDs that currently exist.
   */
  prune(activeIds: Set<string>): void {
    let changed = false;
    const next: Record<string, number> = {};
    for (const [id, ts] of Object.entries(this.timestamps)) {
      if (activeIds.has(id)) {
        next[id] = ts;
      } else {
        changed = true;
      }
    }
    if (changed) {
      this.timestamps = next;
      persist(this.timestamps);
    }
  }
}

/** Singleton reactive read-state instance. */
export const readState = new ReadState();
