Runs an LLM prompt. The agent's text response becomes the step result.

```json5
"extract-data": {
  "type": "agent",
  "tools": ["exec", "read_file"],
  "prompt": [
    "Extract the invoice number and total from:",
    "{{trigger.payload}}",
    "Return as JSON.",
  ],
}
```

Agent step with skills — the agent gets the full skill context and can read skill instructions at runtime:

```json5
"update-tasks": {
  "type": "agent",
  "tools": ["exec", "write_file"],
  "skills": ["task-list", "memory-management"],
  "prompt": [
    "Review the current task list and mark completed items.",
    "Update the memory file with a summary of changes.",
  ],
}
```

- `prompt` is a string or an array of lines (joined with newlines); it supports `{{template}}` expressions.
- `tools` lists the tool names the agent may call; `skills` lists the skills it may read.
- Optional `outputSchema` declares the shape of the answer (JSON5 type hints) so later steps can reference `{{steps.<slug>.result.<path>}}`.
- Prefer deterministic step types over `agent`; use an `agent` step only when no deterministic type fits.
