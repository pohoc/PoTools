# Repository Guidelines

## Project Structure & Module Organization

PoTools is a pnpm workspace for a local-first desktop file-tools application:

- `apps/desktop/` contains the Vite + React UI and Tauri host. UI code is under `src/`; Rust integration is under `src-tauri/`; static assets and bundled licenses are under `public/`.
- `packages/core/` contains shared protocols, tool definitions, fields, and page metadata.
- `packages/engine/` contains the Node sidecar, JSON-RPC transports, jobs, tool implementations, OCR models, and runtime scripts.
- `scripts/` contains repository utilities; `samples/` contains fixtures for tool checks; `docs/` contains licensing documentation.

Keep business and engine behavior in the packages, UI state and presentation in `apps/desktop/src`, and avoid committing generated build output.

## Build, Test, and Development Commands

Use Node 20.19+ or 22.12+, pnpm 12, and Rust stable. From the repository root:

```sh
pnpm install                 # install workspace dependencies
pnpm dev                     # run the desktop Vite app and engine together
pnpm tauri dev               # run the native desktop application
pnpm build                   # build every workspace package
pnpm typecheck               # type-check every package
pnpm test:tools              # run engine end-to-end tool checks
pnpm samples                 # generate or refresh engine samples
```

Use `pnpm dev:web` or `pnpm dev:engine` when working on one process. Use `pnpm tauri build` for a production desktop bundle.

## Coding Style & Naming Conventions

Use TypeScript with strict typing and 2-space indentation. Prefer React function components, hooks, and descriptive PascalCase component filenames; use camelCase for variables, functions, and utilities. Keep shared contracts typed in `packages/core`. Follow the existing Tailwind/CSS conventions and use the established i18n files for user-visible text rather than hardcoding strings.

## Testing Guidelines

There is no separate unit-test runner configured. Run `pnpm test:tools` for the engine’s end-to-end coverage, including content assertions, format round-trips, error paths, and cleanup. Run `pnpm typecheck` (or the package-specific equivalent) for all TypeScript changes. Exercise `pnpm tauri dev` when changing Rust, IPC, packaging, or native integration.

## Commit & Pull Request Guidelines

Existing commits use concise Conventional Commit subjects such as `feat(ui): ...`. Use `type(scope): summary` with a focused scope (`ui`, `engine`, `core`, or `tauri`), and keep unrelated work separate. Pull requests should explain user-visible behavior, list validation commands and results, identify packaging or licensing impacts, and include screenshots for UI changes. Do not commit secrets, generated runtime bundles, or unreviewed third-party artifacts.
