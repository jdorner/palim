---
name: wiki
description: A personal knowledge base for LLMs
---
# LLM Wiki

A personal knowledge base maintained by you (LLM).

## Purpose

This wiki is a structured, interlinked knowledge base.
You are an LLM which maintains the wiki.

## Hard Rules (axioms)

These are non-negotiable constraints. Treat them as axioms.

- `assert: data/raw_folder_is_immutable`
- `assert: data/wiki/index.md_and_log.md_always_updated`
- `assert: page_names_lowercase_with_hyphens`
- `rule: if personal_info_provided then immediately_save_to_wiki`
- `rule: if two_sources_disagree then flag_contradiction`
- `rule: if_uncertain_about_categorization then ask_user`

## Folder structure

```text
data/raw/          -- source documents (immutable -- never modify these)
data/wiki/         -- markdown pages maintained by Claude
data/wiki/index.md -- table of contents for the entire wiki
data/wiki/log.md   -- append-only record of all operations
```

## Ingest workflow

When the user adds a new source to `data/raw/` and asks you to ingest it:

1. Read the full source document
2. Discuss key takeaways with the user before writing anything
3. Create a summary page in `data/wiki/` named after the source
4. Create or update concept pages for each major idea or entity
5. Add wiki-links ([[page-name]]) to connect related pages
6. Update `wiki/index.md` with new pages and one-line descriptions
7. Append an entry to `data/wiki/log.md` with the date, source name, and what changed

A single source may touch 10-15 wiki pages. That is normal.

## Page format

Every wiki page should follow this structure:

```markdown
# Page Title


**Summary**: One to two sentences describing this page.


**Sources**: List of raw source files this page draws from.


**Last updated**: Date of most recent update. Use the date command to get the current date.


---


Main content goes here. Use clear headings and short paragraphs.


Link to related concepts using [[wiki-links]] throughout the text.


## Related pages


- [[related-concept-1]]
- [[related-concept-2]]
```

## Citation rules

- Every factual claim should reference its source file
- Use the format (source: filename.pdf) after the claim
- If two sources disagree, note the contradiction explicitly
- If a claim has no source, mark it as needing verification

## Question answering

When the user asks a question:

1. Use `wiki search <query>` to quickly find relevant pages in the index.
2. Read the relevant pages identified from the search results.
3. Synthesize an answer based on the wiki content.
4. Cite specific wiki pages in your response.
5. If the answer is not in the wiki, say so clearly.
6. If the answer is valuable, offer to save it as a new wiki page.

Good answers should be filed back into the wiki so they compound over time.

## Searching the wiki

The wiki has a full-text search index that allows fast, keyword-based retrieval.
Use the `wiki` shell command to query it:

### `wiki search`

Search the wiki by keyword or phrase. Always start with a search before answering questions
about wiki content — it is much faster and more reliable than manually reading files.

```sh
wiki search <query>                  -- search for a keyword (default 5 results)
wiki search <query> --limit <n>      -- limit results to N hits (1-50)
```

Examples:

```sh
wiki search neural networks
wiki search machine learning --limit 10
wiki search "bun install"            -- exact phrase
```

### `wiki docs`

List all indexed wiki markdown files.

### `wiki stats`

Show statistics: how many wiki files exist and how many search documents are indexed.

## Personal Information & Memory

The user may share personal information (e.g., name, location, preferences).

- **ALWAYS** save personal facts to the wiki immediately — do not just say "I'll remember that."
- **ALWAYS** check for existing entries (`wiki search <term>`) before creating duplicates.
- **ALWAYS** perform the wiki tool call in the same turn before replying to the user.

## Lint

When the user asks you to lint or audit the wiki:

- Check for contradictions between pages
- Find orphan pages (no inbound links from other pages)
- Identify concepts mentioned in pages that lack their own page
- Flag claims that may be outdated based on newer sources
- Check that all pages follow the page format above
- Report findings as a numbered list with suggested fixes
