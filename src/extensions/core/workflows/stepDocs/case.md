Resolves a `match` template and routes to the matching branch. The `paths` field is an **array of branch key strings** (not nested step arrays). Branch steps are separate top-level steps connected via edges whose `branch` matches a path key. An optional `default` names the branch key taken when nothing matches: one of the `paths` (as below) or a key of its own with its own edge. An edge with `branch: "default"` also works as the fallback. Without a fallback, an unmatched value fails the run.

```json5
{
  "steps": {
    "classify": {
      "type": "agent",
      "tools": [],
      "prompt": "Classify the document as 'invoice', 'receipt', or 'other': {{trigger.payload}}",
    },
    "route-by-type": {
      "type": "case",
      "match": "{{steps.classify.result}}",
      "paths": ["invoice", "receipt"],
      "default": "receipt",
    },
    "process-invoice": {
      "type": "agent",
      "tools": ["exec"],
      "prompt": "Process the invoice: {{trigger.payload}}",
    },
    "process-receipt": {
      "type": "agent",
      "tools": ["write_file"],
      "prompt": "Archive the receipt: {{trigger.payload}}",
    },
  },
  "edges": [
    { "from": "classify", "to": "route-by-type" },
    { "from": "route-by-type", "to": "process-invoice", "branch": "invoice" },
    { "from": "route-by-type", "to": "process-receipt", "branch": "receipt" },
  ],
}
```

Path matching is exact and case-sensitive (no trimming). If the resolved value matches no path and no `default` is set, the run fails.
