Sends a named signal to workflows currently waiting for that event. The emitting branch continues immediately (fire-and-forget).

```json5
"notify-ready": {
  "type": "emit",
  // Signal event name to broadcast
  "event": "data.processed",
  // Optional payload template (resolved before emission)
  "payload": "{{steps.transform.result}}",
  // Optional: only resume waits with this correlation key
  "correlate": "{{trigger.payload.orderId}}",
  // Optional: only resume waits of this run (e.g. a run started by start-workflow)
  "targetRun": "{{steps.start-child.result.workflowRunId}}",
}
```

Which waits an emit resumes:
- only `waitFor` steps with `scope: "broadcast"`; waits with the default `instance` scope are never reached by emit
- a wait with a `correlate` key only when the emit carries the same key; a wait without a key on any emit of the event
- with `targetRun`, only waits of that run
- never waits of the emitting run itself

Without `correlate` or `targetRun`, every unkeyed broadcast wait on the event, in every run, is resumed. To address a single workflow instance, use a correlation key, `targetRun`, or direct delivery.
