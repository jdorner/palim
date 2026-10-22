Use it to compute a value once (e.g. a composed string) and reuse it in several later steps, or to build up a value inside an iterator. Later steps read each variable as `{{steps.<slug>.result.<name>}}`.

```json5
"names": {
  "type": "set-variables",
  "variables": [
    { "name": "fileName", "value": "{{trigger.payload.user}}-report.md" },
    { "name": "outPath", "value": "outbox/{{steps.names.result.fileName}}" },
    { "name": "limit", "value": "25", "type": "number" },
  ],
}
```

- `name`: letters, digits and `_`, not starting with a digit. Must be unique within the step.
- `value`: a literal or a `{{template}}`.
- `type` (optional): `string` (default), `number`, `boolean` or `json`. The resolved value is converted to this type, and the step fails if it can't be.
- Entries are evaluated in order. Inside the step, `{{steps.<own-slug>.result.<name>}}` is the variable's current value: the value set by an earlier entry, else the value from the step's previous execution, else `""` / `0` / `false` / `null`.
- To accumulate inside an iterator body, reference the variable's own previous value. After the aggregator, the result holds the last pass's value:

```json5
"acc": {
  "type": "set-variables",
  "variables": [{ "name": "text", "value": "{{steps.acc.result.text}}{{item.name}}, " }],
}
```

Outside an iterator body there is no previous pass, so a self-reference to the variable's own value is always the zero value (the validator warns).
