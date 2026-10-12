/**
 * Shared state of the workflow editor's variable picker: whether the panel is
 * open, and the template field it inserts into. Every field with template
 * autocomplete (`TemplateAutocomplete`) registers itself as the target when it
 * gains focus, so the panel follows the field being edited. The target stays
 * registered on blur, so clicking into the panel (e.g. its search box) does not
 * lose it; the last selection is remembered for that case. Focusing a field
 * without template support hides the panel until a template field has focus.
 */
import { insertReference } from "./autocompleteEngine";
import type { ScopeConfig } from "./templateScope";

/** Whether an element is a form field (buttons excluded). */
function isPlainFormField(element: Element): boolean {
  if (!element.matches("input, textarea, select, [contenteditable='true']")) return false;
  return !(element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type));
}

/** A field the picker can insert into. */
export interface PickerTarget {
  /** The input or textarea. */
  element: HTMLInputElement | HTMLTextAreaElement;
  /** The field's current template scope (read when the panel renders). */
  getConfig: () => ScopeConfig;
  /** Reports the new field value to the owning form. */
  onChange: (value: string) => void;
}

/** localStorage key of the panel's on/off state. */
const OPEN_KEY = "palim.variablePicker.open";

function readOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(open: boolean): void {
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // Storage unavailable (private mode, blocked): the state just isn't remembered.
  }
}

class VariablePickerState {
  /** Whether the panel is switched on (remembered across nodes and reloads). */
  #open = $state(readOpen());
  /** The field references are inserted into (null = none focused yet). */
  target = $state<PickerTarget | null>(null);
  /** Whether a field without template support has focus (hides the panel). */
  suppressed = $state(false);
  /** Selection of the target when it last lost focus. */
  #selection = { start: 0, end: 0 };

  /**
   * Makes a field the insertion target.
   *
   * @param target - The field
   */
  setTarget(target: PickerTarget): void {
    this.target = target;
    this.suppressed = false;
  }

  /**
   * Notes that an element gained focus: a form field that is not a template
   * field hides the panel and drops the target, so nothing is inserted into a
   * field the user has left. Other elements (buttons, the graph) change nothing.
   *
   * @param element - The focused element
   */
  noteFocus(element: Element): void {
    if (this.target?.element === element || !isPlainFormField(element)) return;
    this.target = null;
    this.suppressed = true;
  }

  /**
   * Forgets a field (it is being removed), if it is the current target.
   *
   * @param element - The field's element
   */
  release(element: HTMLElement): void {
    if (this.target?.element === element) this.target = null;
  }

  /**
   * Remembers the target's selection (called when it loses focus).
   *
   * @param element - The field's element
   */
  rememberSelection(element: HTMLInputElement | HTMLTextAreaElement): void {
    if (this.target?.element !== element) return;
    this.#selection = { start: element.selectionStart ?? 0, end: element.selectionEnd ?? 0 };
  }

  /** Whether the panel is switched on. */
  get open(): boolean {
    return this.#open;
  }

  set open(value: boolean) {
    this.#open = value;
    writeOpen(value);
    if (value) this.suppressed = false;
  }

  /** Switches the panel on or off (switching on also shows it while a plain field has focus). */
  toggle(): void {
    this.open = !this.open;
  }

  /**
   * Notes that an element lost focus: once a field without template support
   * is left (and focus does not move to another such field), the panel shows
   * again, e.g. after switching to another node.
   *
   * @param next - The element receiving focus, if any
   */
  noteBlur(next: Element | null): void {
    if (!this.suppressed) return;
    if (next && isPlainFormField(next)) return;
    this.suppressed = false;
  }

  /**
   * Inserts a reference into the target field at its cursor and focuses it.
   *
   * @param expr - Dotted reference path or function name
   * @param kind - `"function"` to insert a call
   * @returns False when there is no target
   */
  insert(expr: string, kind: "value" | "function"): boolean {
    const target = this.target;
    const el = target?.element;
    if (!target || !el?.isConnected) return false;
    const focused = document.activeElement === el;
    const start = focused ? (el.selectionStart ?? el.value.length) : this.#selection.start;
    const end = focused ? (el.selectionEnd ?? start) : this.#selection.end;
    const { newText, newCursorPos } = insertReference(el.value, start, end, expr, kind);
    el.value = newText;
    el.focus();
    el.setSelectionRange(newCursorPos, newCursorPos);
    this.#selection = { start: newCursorPos, end: newCursorPos };
    // Like an accepted autocomplete suggestion: notify input listeners and the owning form.
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    target.onChange(newText);
    return true;
  }
}

/** The editor-wide variable picker state. */
export const variablePicker = new VariablePickerState();
