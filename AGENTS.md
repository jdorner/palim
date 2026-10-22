# AGENTS.md

## Overview

**Palim** is an AI agent platform built on [pi-agent-core](https://github.com/earendil-works/pi/tree/main/packages/agent) and **Bun**: a conversational agent plus job queues, a plugin-style extension system, a Svelte 5 web UI, and local LLM inference via llama.cpp / llama-swap (any OpenAI-compatible endpoint works).

The agent works in a just-bash sandbox: `AGENT_WORK_DIR` is mounted read/write at `/home/user/work`, skills at `/home/user/skills`; nothing else on the host is reachable. Skills are markdown (`<ext>/skills/<skill>/SKILL.md` with `name`/`description` frontmatter), read at runtime via `skill read <name>`.

**Further reading:** `ARCHITECTURE.md` (implementation internals: workflow engine, signals, human tasks, template expressions, extension UI build, extension hub, i18n, auth), `docs/writing-extensions.md` (full `ExtensionContext` API), `docs/api-security-model.md`, `docs/secrets.md`, `docs/portal.md`, `docs/extensions/<name>.md`.

## Runtime & Tooling

- **Runtime:** Bun >=1.4.3 and <1.5.0
- **Language:** TypeScript 7.0.2+ (ESNext, bundler module resolution, strict mode)
- **Linter/Formatter:** Biome (`bun run check`)
- **Frontend / portal:** Svelte 5 + Vite 8 + Tailwind CSS 4, built to `frontend/dist/` and `portal/dist/`, served by Elysia
- **Database:** Drizzle ORM + Bun's native SQLite (WAL mode). Migrations in `drizzle/`.
- **Config:** all env vars are read in `src/config.ts` (see `.env.example`). Extension config comes from `EXT_<NAME>_<KEY>`. `DATA_DIR` (default `.palim/`) must not be inside `AGENT_WORK_DIR`.

## Layout

```text
src/
├── app/boot.ts       # AppBootstrap: create() then start()
├── config.ts         # Centralized env-based config
├── models.ts         # LLM model discovery
├── db/ session/      # Drizzle connection + schema, chat session persistence
├── jobs/ queue/ push/  # Agent/chat queues on bunqueue (ManagedQueue), job logs, out-of-band chat push
├── web/              # Elysia server, auth, /api routes (routes/), ExtensionRouter for /ext/*
├── extensions/
│   ├── engine/       # Registry, discovery, lifecycle, UI builder, watcher (not extension code)
│   ├── core/         # Core extensions: filewatcher, scheduler, webhooks, workflows
│   └── <name>/       # Other extensions (index.ts default-exports an Extension)
├── auth/ secrets/ variables/   # RBAC + identity API, SecretVault, plaintext VariableStore
├── hitl/ portal/     # Human tasks service, portal workflow launchers
├── skills/ tools/    # Skill loading, file tools + sandbox setup
└── utils/
shared/               # Types + pure helpers for backend and frontend; domain modules, no barrel
frontend/src/         # Operator UI: routes/, components/, lib/ (stores, i18n, extensionKit)
portal/src/           # End-user portal (separate package; `$lib` = frontend/src/lib, `$shared` = shared/)
```

## Rules and Gotchas

### Extensions

- Extensions live in `src/extensions/<name>/index.ts` (core: `src/extensions/core/<name>/`) and default-export an `Extension` (manifest + `initialize` + `shutdown`). Routes are auto-prefixed `/ext/<name>/`; `{ public: true }` only for self-authenticating callbacks.
- `@palim/ui` (`frontend/src/lib/extensionKit.ts`) may export only stateless components. Extension code may not import `$lib/*`.
- Bun quirk: an `onResolve` hook returning `undefined` drops the import from the bundle, so every resolve hook in `uiBuilder.ts` has an exact filter and always returns a path.
- Extension `.svelte` changes need a rebuild (toggle the extension; core ones need a restart).
- `registry.loadOne()` purges `require.cache` for reloads, which does nothing under `bun --watch`/`--hot`: hub updates in `bun run dev` need a restart.

### Workflows

- Every signal delivery goes through `deliverSignal` (`signalDelivery.ts`). Never resume a waiting step another way.
- A portal workflow's run-as binding lives in `app_config` (`portalRunAs.ts`), never in the workflow JSON5, because the sandbox can write that file.
- Template functions must be total (never throw; bad input yields `""`, `null`, `[]`, or `NaN`) and read data fields through `ownProp`. Their names and categories come only from `shared/templateFunctionMeta.ts`, which backend, validator, and frontend autocomplete all share.
- `secret` and `env` are resolved only as plain references and must never enter the evaluator scope.
- `humanTask`, portal triggers, and the portal are experimental and active only with `HITL_ENABLED=true`.

### i18n

- Never hardcode UI strings. Add each key to `frontend/src/locales/en.json` and `de.json` (or the extension's `locales/`); `catalogs.test.ts` enforces key parity and that core keys are used.
- Format dates and numbers via `i18n.format` / `activeFormat()`, not hardcoded locales.
- Backend API errors, agent output, and skills are not translated.

## Coding Conventions

- **File naming:** camelCase for backend (`src/`, `shared/`), extension entry points are always `index.ts`
- **Validation:** TypeBox schemas (`Type.Object()`) + `Value.Check()` / `Value.Errors()` for all inputs
- **Documentation:** JSDoc on all exports with `@param`, `@returns`, `@throws`
- **File I/O:** Use `Bun.file()` / `Bun.write()` instead of `node:fs`
- **File discovery:** Use `Bun.Glob` instead of manual directory walking
- **No hardcoded URLs/ports:** Derive from `src/config.ts` or env vars
- **Tool implementation:** Implements `AgentTool` from pi-agent-core, TypeBox parameter schemas, file tools enforce path scoping to `WORK_DIR`
- **Path aliases:** `@src/*` → `./src/*`, `@shared/*` → `./shared/*`, `@ext/sdk` → `./src/extensions/sdk.ts`, `@ext/types` → `./src/extensions/types.ts`
- **Type checking:** Always run `bunx tsc --noEmit` without file arguments. Passing individual files makes tsc ignore tsconfig.json.

## Common Commands

```bash
bun install              # Install dependencies
bun run setup            # Interactive first-time setup (.env, LLM config, admin password, frontend + portal build)
bun run start            # Start (no file watching); UI at http://localhost:3000 by default
bun run dev              # Start with file watching
bun run check            # Lint and format (Biome)
bun run cli              # Sandbox CLI (interactive shell)
bun run test             # Backend tests only; also run `bun test` in frontend/ and portal/
bun run reset-admin [username]   # Break-glass: re-enable user, grant admin, print new password
cd frontend && bun run build     # Build frontend
cd portal && bun install && bun run build  # Build portal (served at /portal/; dev: bun run dev on :5174)
```
