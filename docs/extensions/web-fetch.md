# Web Fetch

The Web Fetch extension gives the agent the ability to fetch and read webpages via a `web` sandbox command. It's a lightweight replacement for `curl` or `wget` that automatically converts HTML to readable markdown.

## Enabling

Enable the extension in the web UI under **Settings > Extensions** by toggling the switch next to "web-fetch".

## How It Works

The extension provides a skill with a sandbox script. When the agent needs to look something up online, it runs the `web fetch` command in the sandbox shell. The script fetches the URL, converts HTML to markdown, and returns truncated plaintext.

## Settings

This extension has no configurable settings.

## Command Reference

### Fetch a webpage

```sh
web fetch [options] "<url>"
```

**Arguments:**

- `url` - Full URL to fetch (must start with `http://` or `https://`)

**Options:**

- `-m`, `--max-length <n>` - Max characters to return (default: 12000)
- `-H`, `--header "Name: Value"` - HTTP header to send (repeatable)

## Examples

```sh
# Read documentation
web fetch "https://bun.sh/docs/runtime/bunfig"

# Limit output length
web fetch --max-length 5000 "https://example.com/article"

# Custom authorization header
web fetch -H "Authorization: Bearer mytoken123" "https://api.example.com/data"

# Multiple headers with length limit
web fetch -H "Authorization: Bearer tok" -H "Accept: application/json" -m 8000 "https://api.example.com/v2/items"
```

## Notes

- Only HTTP and HTTPS URLs are supported
- HTML is automatically converted to markdown
- Output is truncated to avoid exceeding context limits (default 12000 chars)
- Requests have a 15-second timeout
- A standard browser User-Agent header is sent (can be overridden via `-H`)
- JavaScript-rendered content may be incomplete
