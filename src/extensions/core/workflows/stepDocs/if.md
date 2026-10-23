Evaluates a condition against a resolved template value. It is NOT dispatched as a job — the engine evaluates it inline when its incoming edges are satisfied. The `then` and `else` branches are expressed as **edges**, not nested arrays.

```json5
{
  "steps": {
    "extract-data": {
      "type": "agent",
      "tools": ["exec"],
      "prompt": "Extract priority from: {{trigger.payload}}",
    },
    "check-priority": {
      "type": "if",
      "condition": {
        "ref": "{{steps.extract-data.result.priority}}",
        "eq": "high",
      },
    },
    "urgent-notify": {
      "type": "agent",
      "tools": ["send_telegram_message"],
      "prompt": "Send an urgent notification: {{steps.extract-data.result}}",
    },
    "log-low-priority": {
      "type": "agent",
      "tools": ["write_file"],
      "prompt": "Append to the low-priority log: {{steps.extract-data.result}}",
    },
  },
  "edges": [
    { "from": "extract-data", "to": "check-priority" },
    // Branch edges MUST carry a "branch" property on if/case nodes
    { "from": "check-priority", "to": "urgent-notify", "branch": "then" },
    { "from": "check-priority", "to": "log-low-priority", "branch": "else" },
  ],
}
```

If the chosen branch is `then`, the `then` edges become `satisfied` and the `else` edges become `dead` (and vice versa). Dead edges propagate downstream so any step reachable only through a dead branch is skipped.

**Condition operators**

The `condition` object requires a `ref` field (template expression to resolve) and exactly one operator:

| Operator   | Description                                                       | Example                                  |
| ---------- | ----------------------------------------------------------------- | ---------------------------------------- |
| `eq`       | String equality after `String()` coercion                         | `"eq": "success"`                        |
| `neq`      | Logical negation of eq                                            | `"neq": "error"`                         |
| `gt`       | Greater than (numeric if both parseable, otherwise lexicographic) | `"gt": 100`                              |
| `gte`      | Greater than or equal                                             | `"gte": 0`                               |
| `lt`       | Less than                                                         | `"lt": 50`                               |
| `lte`      | Less than or equal                                                | `"lte": 1000`                            |
| `in`       | Membership in array (String coercion per element)                 | `"in": ["draft", "review", "published"]` |
| `contains` | Case-sensitive substring check                                    | `"contains": "error"`                    |
| `exists`   | Not null, not undefined, not empty string                         | `"exists": true`                         |
| `matches`  | Regex test against String(value)                                  | `"matches": "^\\d{4}-\\d{2}-\\d{2}$"`    |

For `null` or `undefined` resolved values, all operators except `exists` return false without performing the comparison.
