```json5
"notify-slack": {
  "type": "http-request",
  "url": "{{env.SLACK_WEBHOOK_URL}}",
  "method": "POST",
  "body": "{\"text\": \"Invoice {{steps.extract-data.result.invoice}} processed.\"}",
}
```

- `headers` is an object of key-value strings. **Omit it entirely if you have no custom headers**; do not set it to an empty string.
- When a `body` is present and no `Content-Type` header is set, `application/json` is applied automatically.
- Use `responseFormat: "json"` to read fields of the response downstream, e.g. `{{steps.<slug>.result.body.id}}`.
- A status outside `expectedStatus` (or outside 2xx when it is not set) fails the step.

```json5
// With custom headers:
"headers": { "Authorization": "Bearer {{secret.API_TOKEN}}" }
```
