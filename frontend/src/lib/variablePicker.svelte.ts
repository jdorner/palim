/**
 * Shared state of the workflow editor's variable picker: whether the panel is
 * open, and the template field it inserts into. Every field with template
 * autocomplete (`TemplateAutocomplete`) registers itself as the target when it
 * gains focus, so the panel follows the field being edited. The target stays
 * registered on blur, so clicking into the panel (e.g. its search box) does not
 * lose it; the last selection is remembered for that case. Focus moving
 * anywhere else (another field, a graph node, a button) drops the target, and
 * the panel only shows while there is a target.
 */
import { insertReference } from "./autocompleteEngine";
import type { ScopeConfig } from "./templateScope";

/** Attribute marking the panel's on/off button, whose focus keeps the target. */
export const PICKER_TOGGLE_ATTR = "data-variable-picker-toggle";

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
  /** Whether the panel is switched on (remembered across nodes and reloads); it shows while there is a target. */
  #open = $state(readOpen());
  /** The field references are inserted into (null = none focused yet). */
  target = $state<PickerTarget | null>(null);
  /** Selection of the target when it last lost focus. */
  #selection = { start: 0, end: 0 };

  /**
   * Makes a field the insertion target.
   *
   * @param target - The field
   */
  setTarget(target: PickerTarget): void {
    this.target = target;
  }

  /**
   * Notes that an element outside the panel gained focus: anything but the
   * target field (or the panel's on/off button) drops the target, which hides
   * the panel and ensures nothing is inserted into a field the user has left.
   *
   * @param element - The focused element
   */
  noteFocus(element: Element): void {
    if (this.target?.element === element || element.hasAttribute(PICKER_TOGGLE_ATTR)) return;
    this.target = null;
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
  }

  /** Switches the panel on or off. */
  toggle(): void {
    this.open = !this.open;
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
