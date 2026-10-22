Closes the loop opened by an `iterator`: collects each pass's result and, once all items are done, continues with its regular (unlabeled) outgoing edges. Run `workflow step-types iterator` for wiring, rules, and a full example.

```json5
"collect": {
  "type": "aggregator",
  "iterator": "iter",  // slug of the paired iterator
}
```

The result, available as `{{steps.<aggregator-slug>.result}}`, is `{ results: [...], totalItems, succeeded, failed }`.
