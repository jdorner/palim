Closes the loop opened by an `iterator`: collects each pass's result and, once all items are done, continues with its regular (unlabeled) outgoing edges. Run `workflow step-types iterator` for wiring, rules, and a full example.

```json5
"collect": {
  "type": "aggregator",
  "iterator": "iter",  // slug of the paired iterator
}
```

The result, available as `{{steps.<aggregator-slug>.result}}`, is `{ results: [...], totalItems, succeeded, failed }`.

- `results` has one object per pass, keyed by the slug of every body step that ran in it: `{{steps.<aggregator-slug>.result.results.0.classify.category}}`. A step on a branch not taken in that pass is not in it.
- `succeeded` always equals `totalItems` and `failed` is 0, because a failed body step fails the whole run. They do not count categories; count those from `results`.
