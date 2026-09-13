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
- **Control flow** - conditional branching (`if`, `case`), data-driven iteration (`iterator`/`aggregator`), external signal gates (`waitFor`), and cross-workflow signaling (`emit`)

## Related skills

This skill covers the concept and the CLI. For the details, read the companion skills:

- **Authoring a definition** (schema, edges, prompts, per-step tools/skills, template variables, secrets, triggers, worked examples, execution model): run `skill read workflow-writing`
- **Step type reference** (every step type's fields and behavior: `agent`, `http-request`, `fail`, `if`, `case`, `iterator`/`aggregator`, `waitFor`, `emit`): run `skill read workflow-step-types`

## When to use

- When the user wants to create a new multi-step pipeline
- When the user wants to modify, inspect, or delete an existing workflow
- When the user asks about chaining agent tasks, automations, or pipelines
- When the user needs parallel execution, joins, conditional logic, data-driven loops, approval gates, or inter-workflow coordination

## Duplicate/Similar Workflow Guardrail

**CRITICAL: Before creating a new workflow, you MUST check if a similar workflow already exists. If a user requests a new workflow (e.g., a new schedule or a new webhook trigger) that is highly similar to an existing one (e.g., same purpose, same target like Telegram, similar frequency), you MUST list the existing workflow(s) to the user and ask for clarification on whether they want to modify the existing one or create a new one.**

## Command reference

```sh
workflow list                          # list all workflow definitions
workflow step-types                    # list available step types (built-in + extension-registered)
```

Whenever the result is user-facing, present it as a table.

Use `workflow step-types` to discover which step types are available in this deployment, including any contributed by external extensions. Built-in control-flow/agent types are always available; the command additionally lists custom types with their config fields.

```sh
workflow read "<name>"                 # display full JSON5 content
workflow write "<name>" "<json5>"      # create or overwrite (validates first)
workflow validate "<name>"             # validate against schema
workflow delete "<name>"               # delete a workflow file
workflow trigger "<name>" "<payload>"  # trigger a run (payload optional, use "" if empty)
workflow runs "<name>"                 # list recent runs with status
workflow logs "<run-id>"               # show per-step execution logs
workflow cancel "<run-id>"             # cancel all steps of a running workflow
```

## Creating a workflow

For the full schema, edges, prompts, template variables, and triggers, run `skill read workflow-writing`. A minimal two-step pipeline:

```sh
workflow write "my-pipeline" '{
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

Changes are picked up automatically - no restart needed.

## Modifying a workflow

```sh
workflow read "my-pipeline"
workflow write "my-pipeline" '<updated-json5>'
workflow validate "my-pipeline"
```

## Notes

- Workflow names must be unique across all files; step slugs (the `steps` map keys) must match `^[a-z][a-z0-9-]*$`.
- Disabled workflows (`enabled: false`) are skipped during loading.
- Always ask for approval before triggering a workflow run!
