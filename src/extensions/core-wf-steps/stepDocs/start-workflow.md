```json5
"start-cleanup": {
  "type": "start-workflow",
  "workflowName": "cleanup",
  "payload": "{\"orderId\": \"{{trigger.payload.orderId}}\"}",
}
```

Fire-and-forget: the step returns as soon as the target run is dispatched. The started run is independent; its result is not propagated and its failure does not affect this run. When the resolved `payload` parses as JSON, the started workflow reads its fields as `{{trigger.payload.<path>}}`; otherwise it receives the raw string.

To wait for the started run, pass this run's id in the payload (`"parentRunId": "{{run.id}}"`), let the started workflow end with an `emit` step whose `targetRun` is `{{trigger.payload.parentRunId}}`, and wait here with a `waitFor` step on that event with `scope: "broadcast"`.
