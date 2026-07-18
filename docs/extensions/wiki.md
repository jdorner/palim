# Wiki

The Wiki extension maintains a personal knowledge base for the agent. It scans markdown files in a configurable directory, chunks them by heading hierarchy, and indexes them into an in-memory full-text search engine (Orama). The agent can search and read wiki pages to answer questions grounded in your documented knowledge.

## Enabling

Enable the extension in the web UI under **Settings > Extensions** by toggling the switch next to "wiki".

## How It Works

1. On startup, all `.md` files in the wiki directory are scanned and chunked by headings
2. Chunks are indexed into an in-memory Orama full-text search index
3. A file watcher monitors the wiki directory for changes (add/edit/delete) and updates the index incrementally
4. The agent reads the wiki skill at conversation start and uses it to search for relevant content
5. The extension optionally injects a system prompt instruction to always consult the wiki first

## Settings

All settings are configurable in the web UI under **Settings > Extensions > Wiki**.

### Inject Instructions into System Prompt

When enabled, adds instructions to the system prompt that tell the agent to read the wiki at the start of every conversation before answering.

Default: `true`

### Wiki Directory

Subdirectory within the work directory where wiki markdown files are stored.

Default: `data/wiki`

Changing this rebuilds the search index from the new directory.

## Environment Variable Override

| Setting | Environment Variable |
| --- | --- |
| Inject Prompt | `EXT_WIKI_INJECT_PROMPT` |
| Wiki Directory | `EXT_WIKI_WIKI_PATH` |

## HTTP API

The extension exposes routes for programmatic access:

### POST /ext/wiki/search

Search the wiki index by text query.

### GET /ext/wiki/search?q=...

Query-parameter search (bookmarkable URL).

### GET /ext/wiki/docs

List all indexed wiki documents.

### GET /ext/wiki/stats

Return index statistics (document count, chunk count).

## Agent Skill

The extension provides a `wiki` skill with sandbox commands for the agent:

- `wiki search "<query>"` - Search the index for relevant content
- `wiki read "<page>"` - Read a specific wiki page
- `wiki write "<page>"` - Write/update a wiki page
- `wiki list` - List all wiki pages

## File Watching

The wiki directory is watched recursively. When you add, edit, or delete markdown files, the search index updates automatically without restart.
