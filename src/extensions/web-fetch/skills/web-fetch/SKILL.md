---
name: web-fetch
description: Fetch and read webpages to retrieve information from the internet
---
# Web Access

## Overview

The `web` command allows you to fetch webpages and extract their text content. Use it to look up information, read documentation, check online resources, or retrieve data from URLs.

## When to use

- When the user asks you to look something up online
- When you need to read a webpage, article, or documentation page
- When the user provides a URL and wants you to retrieve its content
- When you need current information that may be available on the web

## Command reference

### Fetch a webpage

```sh
web fetch [options] "<url>"
```

Fetches the given URL and returns the page content as plain text. Output is truncated to a reasonable length to avoid overwhelming context.

**Arguments:**

- `url`: The full URL to fetch (must start with `http://` or `https://`)

**Options:**

- `-m`, `--max-length <n>`: Max characters to return (default: 12000)
- `-H`, `--header "Name: Value"`: HTTP header to send (repeatable)

## Examples

### Read a documentation page

```sh
web fetch "https://bun.sh/docs/runtime/bunfig"
```

### Fetch with a shorter limit

```sh
web fetch --max-length 5000 "https://example.com/article"
```

### Fetch with an authorization header

```sh
web fetch -H "Authorization: Bearer mytoken123" "https://api.example.com/data"
```

### Fetch with multiple custom headers and a length limit

```sh
web fetch -H "Authorization: Bearer tok" -H "Accept: application/json" -m 8000 "https://api.example.com/v2/items"
```

## Notes

- Only HTTP and HTTPS URLs are supported
- The command converts HTML content automatically to markdown
- Output is truncated to avoid exceeding context limits (default 12000 chars)
- Requests have a 15-second timeout
- A standard browser User-Agent header is sent to avoid bot-blocking (can be overridden via `-H`)
- If a page requires JavaScript rendering, the extracted content may be incomplete
- Respect robots.txt and terms of service — use responsibly
