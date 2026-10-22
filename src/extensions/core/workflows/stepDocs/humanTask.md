Creates a task for people in the portal and pauses its own branch until one of them answers (approve/reject, pick an option, fill in a form). The answer becomes the step result. Use it for approvals and for data only a person can provide. Like `waitFor`, it blocks only its own successors.

```json5
"review": {
  "type": "humanTask",
  // Title and description shown in the portal ({{template}} expressions allowed)
  "title": "Approve invoice {{trigger.payload.number}}",
  "body": "Amount: {{steps.extract.result.amount}}",
  // Who may answer: usernames and/or role names (at least one)
  "assignees": { "roles": ["accounting"], "users": ["joe"] },
  // Optional answer buttons (default: approve / reject)
  "outcomes": [
    { "id": "approve", "label": "Approve", "style": "primary" },
    { "id": "reject", "label": "Reject", "style": "danger" },
  ],
  // Optional JSON Schema of a form to fill in
  "form": { "type": "object", "properties": { "costCenter": { "type": "string" } }, "required": ["costCenter"] },
  // Optional: comment required, priority (low | normal | high), extra key/value context
  "requireComment": false,
  "priority": "high",
  "context": { "Vendor": "{{trigger.payload.vendor}}" },
  // Optional timeout in ms (1 second to 7 days); onTimeout: "fail" (default) or "expire"
  "timeout": 172800000,
  "onTimeout": "expire",
}
```

The step result (`{{steps.review.result.*}}`):

- `outcome` - the chosen outcome id, or `"expired"` when the task timed out with `onTimeout: "expire"`
- `data` - the form data (null without a form)
- `comment` - the comment (null if none)
- `respondedBy` - `{ id, username, displayName }` of the person who answered (null when expired)
- `respondedAt`, `taskId`

Branch on the answer with a `case` step: `{ "type": "case", "match": "{{steps.review.result.outcome}}", "paths": ["approve", "reject", "expired"] }`, with edges `branch: "approve"`, `"reject"`, and `"expired"` (the last one only when `onTimeout` is `"expire"`).

Behavior:
- The task is answered in the portal only; the signal routes reject it.
- If a manager cancels the task, or the timeout passes without `onTimeout: "expire"`, the run fails.
- If the run fails or is deleted, its open tasks are cancelled.
- Unknown users or roles fail the run when the step is reached.
