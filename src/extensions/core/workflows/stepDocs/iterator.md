Iterates over an array, executing the body steps once per element. Uses two paired nodes: an **iterator** (splits the array, opens the loop scope) and an **aggregator** (collects results, drives re-execution or completes).

The body steps between them are regular top-level nodes — they show up in the graph, get their own status/logs, and can be any step type.

**Iterator definition:**

```json5
"iter": {
  "type": "iterator",
  "items": "{{trigger.payload}}",  // template expression resolving to a JSON array
  "as": "image",                   // optional, variable name for current element (default: "item")
}
```

**Aggregator definition:**

```json5
"collect": {
  "type": "aggregator",
  "iterator": "iter",  // slug of the paired iterator
}
```

**Wiring:** The iterator's outgoing edge must have `branch: "each"`. Body steps connect sequentially between iterator and aggregator with regular (unlabeled) edges.

```json5
"edges": [
  { "from": "iter", "to": "convert", "branch": "each" },
  { "from": "convert", "to": "collect" },
  { "from": "collect", "to": "downstream-step" },
]
```

**Template variables inside the loop body:**
- `{{<as>}}` (e.g. `{{image}}`) — the current array element
- `{{<as>.<field>}}` (e.g. `{{image.dataUrl}}`) — dot-path into the current element
- `{{itemIndex}}` — zero-based iteration index

**Aggregator result:** After all iterations complete, the aggregator's result is available downstream as `{{steps.<aggregator-slug>.result}}` containing `{ results: [...], totalItems, succeeded, failed }`.

**Full example:**

```json5
{
  "name": "process-scans",
  "trigger": { "type": "webhook", "ref": "scan-app" },
  "steps": {
    "iter": {
      "type": "iterator",
      "items": "{{trigger.payload}}",
      "as": "image",
    },
    "ocr": {
      "type": "http-request",
      "url": "http://localhost:3000/ext/converter/convert",
      "method": "POST",
      // The webhook delivers images as data URIs (data:image/...;base64,...),
      // but the converter's `data` field expects raw base64. stripDataUri removes
      // the prefix; jsonEscape keeps the value safe inside the JSON body.
      "body": "{\"data\": \"{{ jsonEscape(stripDataUri(image.dataUrl)) }}\"}",
      "responseFormat": "json",
      "timeout": 120000,
    },
    "collect": {
      "type": "aggregator",
      "iterator": "iter",
    },
    "summarize": {
      "type": "agent",
      "prompt": "Summarize OCR results: {{steps.collect.result.results}}",
    },
  },
  "edges": [
    { "from": "iter", "to": "ocr", "branch": "each" },
    { "from": "ocr", "to": "collect" },
    { "from": "collect", "to": "summarize" },
  ],
}
```

**Rules:**
- Every iterator must have exactly one aggregator referencing it (via the aggregator's `iterator` field)
- The aggregator must be reachable from the iterator's `each` branch
- The iterator's outgoing edges must all carry `branch: "each"` (it is a CF node)
- The aggregator has regular (unlabeled) outgoing edges
- Iteration is sequential — each item runs through the full body before the next starts
- If a body step fails, the entire run fails (fail-fast)
