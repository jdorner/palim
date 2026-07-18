# Error Analyzer

The Error Analyzer extension automatically investigates job failures and writes structured markdown reports. When a job fails in a monitored queue or workflow step, the extension dispatches an analysis agent that inspects logs, context, and available tools to produce a root-cause report.

## Enabling

Enable the extension in the web UI under **Settings > Extensions** by toggling the switch next to "error-analyzer".

## Settings

All settings are configurable in the web UI under **Settings > Extensions > Error Analyzer**.

### Monitored Queues

Controls which failure sources trigger automatic analysis. Palim has three independent failure paths that never overlap:

| Source | What it monitors | Examples |
| --- | --- | --- |
| `agents` | One-shot agent prompt jobs dispatched to the core agents queue | Scheduled tasks, telegram replies, file watcher triggers |
| `chat` | Interactive conversational sessions (streamed via WebSocket) | User chat messages that fail during processing |
| `workflows` | Individual steps within multi-step workflow pipelines | A failing step in `daily-wiki-lint` or `report-rotation` |

These sources are mutually exclusive: a workflow step failure only appears under `workflows` (it runs on the workflow extension's own queue, not the core `agents` queue). Disabling `agents` does not suppress workflow step failures, and vice versa.

Default: `agents` and `workflows` enabled.

Changes take effect immediately without restart. Removing a source unsubscribes from its failure events; adding one subscribes.

### Reports Path

Relative path within the work directory where error reports are stored.

Default: `data/error-reports`

Reports are named `<timestamp>_<jobId>.md` and written by the analysis agent into this directory. You can change the path to organize reports differently (e.g. `reports/errors`).

### System Prompt Override

Custom system prompt for the analysis agent. Only change this if you want to modify report structure or analysis behavior. The default prompt instructs the agent to:

- Analyze root causes using available tools
- Write a structured markdown report
- Never attempt to fix anything

## Environment Variable Override

Each setting can also be overridden via environment variable (highest precedence):

| Setting | Environment Variable |
| --- | --- |
| Monitored Queues | `EXT_ERROR_ANALYZER_MONITORED_QUEUES` |
| Reports Path | `EXT_ERROR_ANALYZER_REPORTS_PATH` |
| System Prompt | `EXT_ERROR_ANALYZER_OVERRIDE_PROMPT` |

For the array setting, provide a JSON array string: `'["agents","workflows"]'`

## Report Structure

Each generated report contains:

1. **Error Summary** - What failed, which queue, the error message
2. **Root Cause Analysis** - Why it failed (investigated via tools)
3. **Relevant Context** - Original prompt, tools used, workflow context
4. **Suggested Fix** - How to prevent the failure in the future
5. **Classification** - One of: `infra`, `config`, `skill`, `workflow`, `prompt`, `unknown`

## Circuit Breaker

If the analysis agent itself fails, it will not trigger another analysis (preventing infinite loops). These self-failures are logged as warnings but not retried.
