```json5
"abort-unexpected": {
  "type": "fail",
  "message": "Unexpected category: {{steps.classify.result}}",
}
```

Use it on a branch where reaching that path means the workflow cannot continue (e.g. an unexpected `case` branch). The step logs the message and the entire run is marked failed (fail-fast). Without `message`, the run fails with "Workflow aborted by fail step".

To end a branch without failing the run, use `noop` instead.
