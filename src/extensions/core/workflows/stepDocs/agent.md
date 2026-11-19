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
- Optional `outputSchema` (JSON5 type hints, e.g. `{ category: "string", total: "number" }`) makes the agent answer with a JSON object of that shape. The object becomes the result, so later steps read `{{steps.<slug>.result.category}}`. Do not describe the answer in the prompt (no request for JSON, no list of keys, no example answer): the engine adds the shape from the schema, and a second description can contradict it. Every field must be filled with its type; a field that may be empty (e.g. no category) needs the hint `"any"`, the only one that accepts `null`, and the prompt does not say how to write "empty". Without `outputSchema` the result is free text.
- Prefer deterministic step types over `agent`; use an `agent` step only when no deterministic type fits.
