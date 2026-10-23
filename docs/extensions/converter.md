# Converter

The Converter extension transforms files (PDFs, images) into markdown text using a vision LLM. Workflows use its `convert` step, agents the `convert` shell command, and other callers the HTTP endpoint. Each conversion runs as a job on the `converter:jobs` queue.

## Enabling

Enable the extension in the web UI under **Settings > Extensions** by toggling the switch next to "converter".

## How It Works

1. A file is submitted via the HTTP endpoint (path or base64 data)
2. The file type is detected and validated (PDFs and images supported)
3. PDFs are split into page images; images are resized to the configured max dimension
4. The image(s) are sent to the vision LLM with OCR instructions
5. The LLM returns extracted text as markdown

## Settings

All settings are configurable in the web UI under **Settings > Extensions > Converter**.

### Image Size

Maximum pixel dimension to resize images to before sending to the vision model. Larger values produce better results but consume more tokens and processing time.

Default: `800`

### Timeout

Maximum time in milliseconds to wait for a conversion to complete before timing out the HTTP request.

Default: `300000` (5 minutes)

## Environment Variable Override

Each setting can also be overridden via environment variable (highest precedence):

| Setting    | Environment Variable                  |
| ---------- | ------------------------------------- |
| Image Size | `EXT_CONVERTER_RESIZE_IMAGE_PX`       |
| Timeout    | `EXT_CONVERTER_CONVERSION_TIMEOUT_MS` |

## Workflow Step: convert

Converts a file from the work directory to markdown, without an agent step in between.

```json5
"read-receipt": {
  "type": "convert",
  "file": "{{trigger.payload.file.path}}",         // path relative to the work directory
  "prompt": "Extract date, vendor and total.",     // optional, replaces the OCR instructions
  "output": "receipts/{{run.id}}.md"               // optional, also saves the markdown
}
```

| Field    | Description                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `file`   | Image or PDF, relative to the work directory. Supports `{{template}}` expressions. Files outside the work directory can't be read. |
| `prompt` | Optional instructions replacing the default OCR prompt.                                                                            |
| `output` | Optional path to also write the markdown to. Folders are created as needed.                                                        |

The result is `{ markdown, file, output }`, so later steps use `{{steps.read-receipt.result.markdown}}`. The step fails for missing files and unsupported file types, and when the conversion times out (see the Timeout setting).

## HTTP API

### POST /ext/converter/convert

Accepts JSON. Files are passed as base64-encoded bytes.
- `data` (required) - Array of base64-encoded file contents
- `filenames` (optional) - Display names aligned positionally with `data`, used only for job labels and logs; does not affect the conversion
- `prompt` (optional) - Custom system prompt overriding the default OCR instructions

When multiple `data` entries are supplied, they are merged into a single conversion: every image is sent to the vision model together as pages of one document, and one combined markdown result is returned.

**Response:**

```json
{ "markdown": "# Extracted content..." }
```

**Error responses:**
- `400` - Validation error (e.g. missing `data`)
- `415` - Unsupported file type

## Supported File Types

- **Images:** PNG, JPEG, WebP, GIF, BMP, TIFF
- **Documents:** PDF (converted to page images first)
