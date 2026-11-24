---

name: workflows
description: Overview and CLI usage for multi-step workflow pipelines - what workflows are, when to use them, and the workflow command reference
---

# Workflow Pipelines

## Overview

Workflows chain multiple agent jobs into a directed acyclic graph (DAG) where the output of one step feeds into the next. Definitions are JSON5 files stored in `workflows/`. The system watches this directory and hot-reloads definitions on any change.

A workflow is a set of named `steps` plus an `edges` array that wires them together. This graph model supports:

- **Sequential chains** - edge from one step to the next
- **Parallel fan-out** - a step with multiple outgoing edges dispatches all successors at once
- **Join / convergence** - a step with multiple incoming edges waits until all predecessors resolve before running
- **Control flow** - conditional branching (`if`, `case`), data-driven iteration (`iterator`/`aggregator`), external signal gates (`waitFor`), human approvals and input (`humanTask`), and cross-workflow signaling (`emit`)

## Related skills

This skill covers the concept and the CLI. For the details, read the companion skills:

- **Authoring a definition** (schema, edges, prompts, per-step tools/skills, template variables, secrets, triggers, worked examples, execution model): run `skill read workflow-writing`
- **Turning a task solved in this chat into a workflow** (keep the calls that worked, parameterize inputs, test before going live): run `skill read workflow-crystallize`
- **Designing a new process with the user** (interview, write a draft early, grow it one confirmed change at a time, human tasks and their branches): run `skill read workflow-design`
- **Step type reference** (every step type's fields, examples, and behavior, including types added by extensions): run `workflow step-types`, then `workflow step-types <type>`

## When to use

- When the user wants to create a new multi-step pipeline
- When the user wants a task just solved in this chat turned into a workflow ("make that a workflow", "automate what we just did"): read `workflow-crystallize`
- When the user describes a process that does not exist yet ("build me a workflow that...", "I need an approval process for..."): read `workflow-design`
- When the user wants to modify, inspect, or delete an existing workflow
- When the user asks about chaining agent tasks, automations, or pipelines
- When the user needs parallel execution, joins, conditional logic, data-driven loops, approval gates, or inter-workflow coordination

## Duplicate/Similar Workflow Guardrail

**CRITICAL: Before creating a new workflow, you MUST check if a similar workflow already exists. If a user requests a new workflow (e.g., a new schedule or a new webhook trigger) that is highly similar to an existing one (e.g., same purpose, same target like Telegram, similar frequency), you MUST list the existing workflow(s) to the user and ask for clarification on whether they want to modify the existing one or create a new one.**

## Command reference

```sh
workflow list                          # list all workflow definitions
workflow step-types                    # list all step types (engine + extension-registered), one line each
workflow step-types "<type>"           # full reference of one step type: fields, result, examples, behavior
workflow step-types --search "<terms>" # find step types by keyword (e.g. "email", "loop", "notify")
workflow trigger-types                 # list the trigger types extensions add (beyond the built-in ones)
workflow trigger-types "<type>"        # payload fields, refs, and docs of one extension trigger type
```

Whenever the result is user-facing, present it as a table.

Use `workflow step-types` to discover which step types are available in this deployment, including any contributed by external extensions. Before using a step type in a definition, read its reference with `workflow step-types <type>`.

```sh
workflow read "<name>"                 # display full JSON5 content
workflow outline "<name>"              # steps in order, where each leads, and the warnings
workflow write --draft "<name>" "<json5>"  # create as a draft (always for a new workflow): runnable by hand, its trigger does not start it
workflow write "<name>" "<json5>"      # overwrite (validates first)
workflow write "<name>" --file "<path>"    # same, JSON5 read from a file in the work directory
workflow set-step "<name>" "<slug>" "<json5>" [--after "<slug>"] [--branch "<key>"]  # create or replace one step
workflow set-step "<name>" "<slug>" --file "<path>" [--after ...]  # same, step JSON5 read from a file
workflow remove-step "<name>" "<slug>"           # remove a step and its edges
workflow add-edge "<name>" "<from>" "<to>" [--branch "<key>"]     # add an edge
workflow remove-edge "<name>" "<from>" "<to>" [--branch "<key>"]  # remove an edge
workflow set-meta "<name>" "<json5>"   # set description, group, trigger (null removes description or group)
workflow add-loop "<name>" "<slug>" --over "<list>" [--as "<alias>"] --from "<first>" --to "<last>"  # wrap steps in a per-item loop
workflow validate "<name>"             # validate against schema
workflow delete "<name>"               # delete a workflow file
workflow trigger "<name>" "<payload>"  # trigger a run (payload optional, use "" if empty)
workflow runs "<name>"                 # list recent runs with status
workflow logs "<run-id>"               # show per-step execution logs
workflow wait "<run-id>" [--timeout "<seconds>"]  # wait until the run ends or waits for input, then show its logs
workflow cancel "<run-id>"             # cancel a running or waiting run (it ends failed and stays listed)
```

## Creating a workflow

For the full schema, edges, prompts, template variables, and triggers, run `skill read workflow-writing`. A minimal two-step pipeline:

```sh
workflow write --draft "my-pipeline" '{
  "name": "my-pipeline",
  "description": "A simple two-step pipeline",
  "trigger": { "type": "manual" },
  "steps": {
    "step-one": {
      "type": "agent",
      "tools": [],
      "prompt": "Generate a haiku about coding.",
    },
    "step-two": {
      "type": "agent",
      "tools": [],
      "prompt": ["Translate this haiku to French:", "{{steps.step-one.result}}"],
    },
  },
  "edges": [
    { "from": "step-one", "to": "step-two" },
  ],
}'
```

## Modifying a workflow

Change an existing workflow with one edit command per change, so the parts you were not asked about stay exactly as they are:

```sh
workflow outline "my-pipeline"
workflow set-step "my-pipeline" "step-two" '{ "type": "agent", "tools": [], "prompt": "Translate this haiku to German: {{steps.step-one.result}}" }'
workflow set-step "my-pipeline" "step-three" '{ "type": "agent", "prompt": "Count the words: {{steps.step-two.result}}" }' --after "step-two"
```

- `set-step` replaces the whole step. A new step needs `--after`; after an `if`, `case`, or `iterator`, add `--branch`. For a long prompt, pass the step JSON5 in a file with `--file "<path>"`.
- For a per-item loop, write the steps for one item, then run `workflow add-loop` (`workflow-writing`, "Loops").
- Each command validates first and writes nothing when the result would be invalid; the error says what to change first. On success it prints the outline and the warnings.
- `draft` and every field the command does not address are kept. On an active workflow the change is live at once, so ask first.
- For a change to the whole file, use `workflow read` and `workflow write` as before.

## Notes

- Drafts (`draft: true`, set by `workflow write --draft`) are loaded and can be run with `workflow trigger`, but their trigger, other workflows, and the portal do not start them. Rewriting a draft with `workflow write` keeps it a draft, with or without `--draft`. The user activates a draft in the workflow editor; never remove `draft` yourself.
- Always ask for approval before triggering a workflow run!
- After `workflow trigger`, run `workflow wait "<run-id>"` once instead of calling `workflow runs` or `workflow logs` repeatedly. It returns when the run completes or fails (with the logs), or when it waits for a signal or a human task (with what it waits for). After the timeout (default 300 seconds) it prints the step statuses; run it again to keep waiting.
