---
name: converter
description: Convert files (PDFs, images) to markdown text using a vision LLM
---
# Converter

## Overview

The converter skill provides a `convert` shell command that transforms files into markdown text. It uses a vision LLM to extract and structure text content from PDFs and images.

Supported file types:

- PDF documents (each page is converted to an image and processed)
- Images: PNG, JPEG, WebP, GIF, BMP, TIFF

File types are detected by reading magic bytes from the file header, not by file extension.

## When to use

- When the user asks to extract text from a PDF or image
- When ingesting documents into the wiki or knowledge base
- When processing files dropped into the inbox that need text extraction
- When converting raw documents into structured markdown pages
- When asking questions about image or PDF content (e.g. describing what's in a photo)

## Command reference

```
convert [--file <path>] [--output <path>] [--prompt <text>]
```

When `--file` is omitted, input is read from stdin (pipe or redirect).

**Options:**

- `-f`, `--file` — Path to the file to convert
- `-o`, `--output` — Write result to this path instead of stdout
- `-p`, `--prompt` — Custom system prompt overriding the default OCR instructions. When omitted, the default prompt extracts all visible text and preserves document structure as markdown.

## Examples

### Extract text from a PDF

```sh
convert --file data/raw/file1.pdf
```

### Convert a PDF and save as a wiki page

```sh
convert -f data/raw/file1.pdf -o data/wiki/pages/file1.md
```

### Extract text from an image

```sh
convert --file data/raw/screenshot.png
```

### Ask a question about an image

```sh
convert --file data/raw/photo.png --prompt "Describe what you see in this image. Is there a blue ball?"
```

### Extract structured data with specific instructions

```sh
convert -f data/raw/invoice.pdf --prompt "Extract the invoice number, date, total amount, and line items as a markdown table."
```

### Pipe file data via stdin

```sh
cat data/raw/image.png | convert
```

### Pipe with a custom prompt

```sh
cat data/raw/receipt.jpg | convert --prompt "Extract the total amount and date from this receipt."
```

## Notes

- Conversion is processed through a queue, so jobs appear in the web UI with progress tracking
- Large PDFs with many pages may take 30+ seconds to process
- The vision LLM preserves document structure: headings, lists, tables, paragraphs
- If multiple PDF pages are provided, they are separated by horizontal rules (---)
- The `--prompt` option replaces the entire system prompt, so include all necessary instructions
- When using stdin, the file type is auto-detected from magic bytes in the binary data
