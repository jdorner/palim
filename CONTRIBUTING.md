# Contributing to Palim

Thanks for your interest in contributing! This document covers the essentials to get you up and running.

## Local Setup

See the [README](./README.md) Quick Start section:

```bash
bun install
bun run setup
bun run dev
```

Requirements:

- **Bun** 1.3.14+
- **An LLM endpoint** (with OpenAI-compatible API)

## Code Style

We use [Biome](https://biomejs.dev/) for linting and formatting. Configuration lives in `biome.json`.

```bash
bun run check     # Lint + format (auto-fixes where possible)
```

Please run this before committing - CI will fail on lint errors.

Key conventions:

- File naming: `camelCase.ts` for backend, extension entry points are always `index.ts`
- JSDoc on all exported functions, classes, interfaces, and type aliases
- TypeBox schemas for input validation (no raw `any` casts)
- Prefer `Bun.file()` / `Bun.write()` over `node:fs`
- No hardcoded URLs or ports - use `src/config.ts` or environment variables

## Testing

We use Bun's built-in test runner.

```bash
bun run test                        # Run all tests
bun test path/to/file.test.ts       # Run a single test file
```

Conventions:

- Test files are **co-located** next to the source file: `foo.ts` → `foo.test.ts`
- Use `describe()` + `test()` (not `it()`)
- No mocking frameworks - use in-memory implementations or lightweight fakes
- No snapshot tests
- Tests must pass without external services (no running LLM server, no Telegram token)

Example structure:

```typescript
import { describe, expect, test } from "bun:test";
import { myFunction } from "./myModule";

describe("myFunction", () => {
  describe("basic behavior", () => {
    test("returns expected result for valid input", () => {
      expect(myFunction("hello")).toBe("HELLO");
    });
  });

  describe("edge cases", () => {
    test("throws on empty input", () => {
      expect(() => myFunction("")).toThrow();
    });
  });
});
```

## Pull Requests

### Branch Naming

Use a descriptive prefix:

- `feat/short-description` - New features
- `fix/short-description` - Bug fixes
- `refactor/short-description` - Code restructuring
- `docs/short-description` - Documentation only

### Commit Messages

Write clear, concise commit messages:

```text
feat: add webhook retry logic

fix: prevent duplicate session creation on reconnect

docs: update secrets section in README
```

Use [Conventional Commits](https://www.conventionalcommits.org/) style (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).

### PR Checklist

Before opening a PR, make sure:

- [ ] `bun run check` passes (no lint errors)
- [ ] `AGENT=1 bun test` passes
- [ ] New code has JSDoc comments on exports
- [ ] New features include co-located tests
- [ ] The PR description summarizes what changed and why
