```json5
"batch-files": {
  "type": "chunk",
  "input": "{{steps.list-files.result.stdout}}",
  "size": 200,
}
```

- A string input is split into lines (or on `separator`); with `trim` (default true) items are trimmed and empty items dropped. A template that resolves to a JSON array is grouped directly.
- The result's `batches` is an array of arrays with at most `size` items each, made to feed an `iterator`: `"items": "{{steps.batch-files.result.batches}}"`.
