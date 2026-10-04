/**
 * A transient status message that clears itself after a timeout, used for
 * "Saved" / "Deleted" confirmations in settings forms.
 */
export class Flash {
  /** The message currently shown, or null when hidden. */
  message = $state<string | null>(null);

  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #durationMs: number;

  /**
   * @param durationMs - How long a message stays visible
   */
  constructor(durationMs = 3000) {
    this.#durationMs = durationMs;
  }

  /**
   * Show a message, restarting the hide timer.
   *
   * @param msg - The message to show
   */
  show(msg: string): void {
    this.message = msg;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => (this.message = null), this.#durationMs);
  }

  /** Hide the message immediately. */
  clear(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.message = null;
  }
}
