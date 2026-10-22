Pauses its own branch and releases the worker slot until an external signal is delivered via the API. In the DAG model, `waitFor` is a regular node: it blocks only its own successors — independent branches keep running.

```json5
"await-approval": {
  "type": "waitFor",
  // Signal event name (lowercase, dots/hyphens allowed)
  "event": "approval.granted",
  // Optional timeout in ms (1 second to 7 days). Run fails if exceeded.
  "timeout": 86400000, // 24 hours
  // Optional JSON Schema for validating the incoming signal payload
  "inputSchema": {
    "type": "object",
    "properties": {
      "approver": { "type": "string" },
      "comment": { "type": "string" },
    },
    "required": ["approver"],
  },
  // Optional: who may resume the wait (default "instance")
  //   "instance"  - only direct delivery to this run (see below)
  //   "broadcast" - additionally emit steps (from other workflows)
  "scope": "broadcast",
  // Optional correlation key, resolved when the wait is reached.
  // Only emits carrying the same key resume this wait.
  "correlate": "{{trigger.payload.orderId}}",
}
```

When the signal arrives, its payload becomes the step result. Successor steps access it via `{{steps.await-approval.result}}` or `{{steps.await-approval.result.approver}}`.

**Delivering a signal**

Every waiting step of every run has its own address, so a signal resumes exactly one wait. Deliver it with a POST (JSON body = payload):

```
POST /ext/workflows/runs/<runId>/steps/<stepSlug>/signal   # preferred: one step of one run
POST /ext/workflows/signals/<signalId>                     # signal ID from GET /ext/workflows/runs/<runId>
Content-Type: application/json

{ "approver": "joe", "comment": "Looks good" }
```

To let an external system call back into the right run, pass it the address from a template: `/ext/workflows/runs/{{run.id}}/steps/await-approval/signal`.

Response codes:
- `200` - Signal accepted, workflow resumed
- `404` - Run or signal not found
- `409` - Not waiting (already delivered, timed out, run ended)
- `422` - Payload fails inputSchema validation

A timeout survives restarts: after a restart, pending timeouts are re-armed and already elapsed ones fire immediately.

**Event name rules**

Event names must match `^[a-z][a-z0-9._-]*$` (max 128 characters). Examples: `approval.granted`, `deploy-ready`, `data.processed`.
