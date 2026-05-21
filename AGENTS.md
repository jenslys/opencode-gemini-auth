# OpenCode Agent Instructions

## Commands
- **Install dependencies:** `bun install`
- **Run tests:** `bun test` (runs all tests). To run a specific test: `bun test path/to/test.ts`
- **Build project:** `bun run build` (uses `tsup` to compile ESM).
- **Check node import compatibility:** `bun run smoke:node-import`

## Architecture & Conventions
- **Opencode Plugin**: This is an Opencode authentication plugin for Gemini.
- **Entrypoints**: `index.ts` is the main export. `src/plugin.ts` sets up the loader and `fetch` interception.
- **Multi-Account**: The plugin supports multiple Gemini accounts via `AccountPool` (`src/plugin/account-pool.ts`). Accounts are selected using a rotation strategy (cooldown-aware LRU with quota fallback). 
- **Storage**: Auth state is maintained in-memory and dynamically added accounts persist to `~/.config/opencode/gemini-auth.json` via `src/plugin/config-store.ts`. (Note: During testing, it isolates to `gemini-auth.test.json`).
- **Quota Handling**: `gquota` tool dynamically resolves Google Cloud project IDs and aggregates metrics across multiple accounts.

## Workflow
- **Spec-Driven Development (SDD)**: This repo uses SDD. Look for specs and task artifacts in `openspec/` (or via Engram memory) before making architectural changes.
- **Strict TDD**: Write tests for any new features or bug fixes. `bun test` must pass before considering a task complete. Keep tests next to source files (e.g., `feature.test.ts`).
- **Imports**: Ensure all necessary functions are exported from `src/plugin/types.ts` if they need to be shared across modules.
