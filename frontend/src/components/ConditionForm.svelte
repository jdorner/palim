<!--
  Form-based editor for an `if` step's condition object.

  A condition is a `ref` template expression plus exactly one comparison
  operator (eq, neq, gt, gte, lt, lte, in, contains, exists, matches). The
  generic StepConfigForm cannot render this nested/one-of shape, so this
  component provides a dedicated form: a ref input (with template autocomplete),
  an operator selector, and an operator-appropriate value input.
-->
<script lang="ts">
import { Tooltip } from "bits-ui";
import InfoIcon from "phosphor-svelte/lib/InfoIcon";
import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
import type { OutputSchemas } from "$lib/templateScope";
import TemplateAutocomplete from "./TemplateAutocomplete.svelte";

/** The comparison operator keys a condition may carry. */
type OperatorKey = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains" | "exists" | "matches";

/** Ordered operator options with human-readable labels. */
const OPERATORS: Array<{ key: OperatorKey; label: string }> = [
  { key: "eq", label: "equals" },
  { key: "neq", label: "not equals" },
  { key: "gt", label: "greater than" },
  { key: "gte", label: "greater than or equal" },
  { key: "lt", label: "less than" },
  { key: "lte", label: "less than or equal" },
  { key: "in", label: "in list" },
  { key: "contains", label: "contains" },
  { key: "exists", label: "exists (truthy)" },
  { key: "matches", label: "matches regex" },
];

const OPERATOR_KEYS = OPERATORS.map((o) => o.key);

interface Props {
  /** The current condition object (`{ ref, <operator> }`). */
  condition: Record<string, unknown>;
  /** Callback fired with the full updated condition object. */
  onchange?: (condition: Record<string, unknown>) => void;
  /** When true, all fields render read-only. */
  readonly?: boolean;
  /** Validation error for the `ref` field, if any. */
  refError?: string;
  /** Workflow steps for template autocomplete scope (optional). */
  steps?: Array<{ slug: string; [key: string]: unknown }>;
  /** Index of the current step (zero-based) for autocomplete scope. */
  currentStepIndex?: number;
  /** Prefetched secret keys for template autocomplete. */
  secretKeys?: string[];
  /** Prefetched variable keys for template autocomplete. */
  variableKeys?: string[];
  /** Resolved output schemas for deep property autocomplete. */
  outputSchemas?: OutputSchemas;
}

let {
  condition,
  onchange,
  readonly: isReadonly,
  refError,
  steps,
  currentStepIndex,
  secretKeys,
  variableKeys,
  outputSchemas,
}: Props = $props();

/** Whether template autocomplete is available (all required context provided). */
let autocompleteEnabled = $derived(steps !== undefined && currentStepIndex !== undefined && secretKeys !== undefined);

/** Ref input element (for autocomplete anchoring). */
let refEl = $state<HTMLInputElement | null>(null);

/** The currently active operator, derived from the condition object. */
let activeOperator = $derived<OperatorKey>((OPERATOR_KEYS.find((k) => k in condition) as OperatorKey) ?? "eq");

/** The current ref value. */
let refValue = $derived(typeof condition.ref === "string" ? (condition.ref as string) : "");

/**
 * Emit an updated condition, replacing the current ref/operator while ensuring
 * exactly one operator key remains present.
 */
function emit(ref: string, operator: OperatorKey, value: unknown) {
  if (isReadonly) return;
  const next: Record<string, unknown> = { ref };
  next[operator] = value;
  onchange?.(next);
}

/** Update the ref, preserving the active operator and its value. */
function updateRef(ref: string) {
  emit(ref, activeOperator, currentOperatorValue());
}

/** Switch the operator, carrying over a sensible value for the new operator. */
function updateOperator(operator: OperatorKey) {
  const carried = currentOperatorValue();
  let value: unknown;
  if (operator === "exists") {
    value = typeof carried === "boolean" ? carried : true;
  } else if (operator === "in") {
    value = Array.isArray(carried) ? carried : [];
  } else {
    value = Array.isArray(carried) ? "" : (carried ?? "");
  }
  emit(refValue, operator, value);
}

/** Update the operator value. */
function updateValue(value: unknown) {
  emit(refValue, activeOperator, value);
}

/** Read the value currently attached to the active operator. */
function currentOperatorValue(): unknown {
  return condition[activeOperator];
}

/** Render the `in` operator array as a comma-separated string for editing. */
function inAsText(): string {
  const v = condition.in;
  return Array.isArray(v) ? (v as unknown[]).map((x) => String(x)).join(", ") : "";
}
</script>

{#snippet infoTip(description: string)}
  <Tooltip.Root delayDuration={0}>
    <Tooltip.Trigger
      class="inline-flex items-center pointer-events-auto cursor-help text-muted-foreground/60 hover:text-muted-foreground"
    >
      <InfoIcon class="w-4 h-4" />
    </Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content
        class="z-50 max-w-64 rounded-md border border-border px-3 py-2 text-xs text-foreground shadow-md"
        style="background: hsl(var(--popover));"
        sideOffset={4}
        side="top"
      >
        {description}
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
{/snippet}

<div class="space-y-3">
  <!-- Ref -->
  <div class="space-y-1">
    <span class="inline-flex items-center gap-1">
      <label class="text-xs font-medium text-muted-foreground" for="condition-ref">Ref</label>
      {@render infoTip("Template expression resolving to the value to test.")}
    </span>
    <input
      id="condition-ref"
      bind:this={refEl}
      type="text"
      disabled={isReadonly}
      class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-70"
      value={refValue}
      placeholder="{'{{'}steps.slug.output{'}}'}"
      oninput={(e) => updateRef(e.currentTarget.value)}
    >
    {#if autocompleteEnabled && !isReadonly}
      <TemplateAutocomplete
        targetElement={refEl}
        steps={steps ?? []}
        currentStepIndex={currentStepIndex ?? 0}
        secretKeys={secretKeys ?? []}
        variableKeys={variableKeys ?? []}
        {outputSchemas}
        onChange={(newValue) => updateRef(newValue)}
      />
    {/if}
    {#if refError}
      <span class="text-xs text-destructive">{refError}</span>
    {/if}
  </div>

  <!-- Operator -->
  <div class="space-y-1">
    <label class="text-xs font-medium text-muted-foreground" for="condition-operator">Operator</label>
    <select
      id="condition-operator"
      disabled={isReadonly}
      class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-70"
      value={activeOperator}
      onchange={(e) => updateOperator(e.currentTarget.value as OperatorKey)}
    >
      {#each OPERATORS as op (op.key)}
        <option value={op.key}>{op.label}</option>
      {/each}
    </select>
  </div>

  <!-- Operator value -->
  <div class="space-y-1">
    {#if activeOperator === "exists"}
      <div class="flex items-center gap-2">
        <ToggleSwitch
          id="condition-value"
          checked={condition.exists === true}
          onChange={(v) => updateValue(v)}
          disabled={isReadonly}
          aria-label="Expected truthiness"
        />
        <label class="text-xs font-medium" for="condition-value">Value must be truthy</label>
      </div>
    {:else if activeOperator === "in"}
      <span class="inline-flex items-center gap-1">
        <label class="text-xs font-medium text-muted-foreground" for="condition-value">Values</label>
        {@render infoTip("Comma-separated list; matches if the resolved value is one of these.")}
      </span>
      <input
        id="condition-value"
        type="text"
        disabled={isReadonly}
        class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-70"
        value={inAsText()}
        placeholder="value1, value2, ..."
        oninput={(e) => {
          const items = e.currentTarget.value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
          updateValue(items);
        }}
      >
    {:else}
      <label class="text-xs font-medium text-muted-foreground" for="condition-value">Value</label>
      <input
        id="condition-value"
        type="text"
        disabled={isReadonly}
        class="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-70"
        value={String(currentOperatorValue() ?? "")}
        placeholder={activeOperator === "matches" ? "regular expression" : "comparison value"}
        oninput={(e) => updateValue(e.currentTarget.value)}
      >
    {/if}
  </div>
</div>
