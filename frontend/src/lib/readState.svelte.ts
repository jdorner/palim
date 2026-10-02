/**
 * Reactive read/unread tracking for conversations.
 * Backed by localStorage for persistence
 */

const STORAGE_KEY_PREFIX = "conversation-read-state";

/** The localStorage key for the current user, or null when logged out. */
let storageKey: string | null = null;

/** Loads the read-state map from localStorage. */
function load(): Record<string, number> {
  if (!storageKey) return {};
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Persists the read-state map to localStorage. */
function persist(state: Record<string, number>): void {
  if (!storageKey) return;
  localStorage.setItem(storageKey, JSON.stringify(state));
}

/**
 * Reactive read-state store using Svelte 5 runes.
 * All methods mutate `$state` so dependents auto-update.
 */
class ReadState {
  /** Per-conversation last-read timestamps. Reactive - triggers derived re-evaluation on mutation. */
  timestamps = $state<Record<string, number>>(load());

  /**
   * Scopes read state to a user so accounts sharing a browser don't see or
   * prune each other's entries.
   * @param userId - The authenticated user's id, or null when logged out.
   */
  setUser(userId: string | null): void {
    storageKey = userId ? `${STORAGE_KEY_PREFIX}:${userId}` : null;
    this.timestamps = load();
  }

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
