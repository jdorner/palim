# Converter

The Converter extension transforms files (PDFs, images) into markdown text using a vision LLM. It exposes an HTTP endpoint that accepts a file path or base64-encoded data, queues the conversion job, and returns the extracted text.

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

| Setting | Environment Variable |
| --- | --- |
| Image Size | `EXT_CONVERTER_RESIZE_IMAGE_PX` |
| Timeout | `EXT_CONVERTER_CONVERSION_TIMEOUT_MS` |

## HTTP API

### POST /ext/converter/convert

Accepts JSON with one of:

- `path` - File path relative to the work directory
- `data` - Base64-encoded file content (for piped/stdin input)
- `prompt` (optional) - Custom system prompt overriding the default OCR instructions

**Response:**

```json
{ "markdown": "# Extracted content..." }
```

**Error responses:**

- `400` - Validation error or missing path/data
- `403` - Path outside work directory
- `404` - File not found
- `415` - Unsupported file type

## Supported File Types

- **Images:** PNG, JPEG, WebP, GIF, BMP, TIFF
- **Documents:** PDF (converted to page images first)
