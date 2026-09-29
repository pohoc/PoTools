# Repository Guidelines

## Project Structure & Module Organization

PoTools is a pnpm workspace for a local-first desktop file-tools application:

- `apps/web/` contains the Vite + React UI, static assets, and bundled licenses.
- `apps/desktop/` contains the Tauri host, with Cargo/Tauri config at the app root and Rust code under `src/`.
- `packages/core/` is the Rust shared protocol/catalog crate; `catalog/*.json` is the shared tool metadata consumed by Rust.
- `packages/engine/` is the Rust tool engine library, built as native Rust for Tauri and WebAssembly for browser Workers. Keep host APIs and UI adapters in `apps/web/` and privileged native services in the Tauri app.
- `scripts/` contains repository utilities; `samples/` contains fixtures for tool checks; `docs/` contains licensing documentation.

Keep business and engine behavior in the packages, UI state and presentation in `apps/web/src`, and avoid committing generated build output.

## Build, Test, and Development Commands

Use Node 20.19+ or 22.12+, pnpm 12, and Rust stable. From the repository root:

```sh
pnpm install                 # install workspace dependencies
pnpm dev                     # run the web frontend
pnpm tauri dev               # run the native desktop application
pnpm wasm:build              # build the Rust engine for browser Workers
pnpm --filter @potools/web build # build the Web app
pnpm --filter @potools/web typecheck # type-check the Web adapters/UI
pnpm test:tools              # run browser tool checks
pnpm samples                 # generate or refresh engine samples
```

Use `pnpm dev:web` when working on the Web app. The `@potools/desktop` app owns Tauri; `@potools/web` owns the UI and browser host adapters.

## Coding Style & Naming Conventions

Use Rust for shared core behavior and engine tool logic. Use TypeScript with strict typing and 2-space indentation for `apps/web` UI and browser capability adapters. Prefer React function components, hooks, and descriptive PascalCase component filenames; use camelCase for variables, functions, and utilities. Keep shared contracts in `packages/core`. Follow the existing Tailwind/CSS conventions and use the established i18n files for user-visible text rather than hardcoding strings.

## Testing Guidelines

There is no separate unit-test runner configured. Run `pnpm test:tools` for the engine’s end-to-end coverage, including content assertions, format round-trips, error paths, and cleanup. Run `pnpm typecheck` (or the package-specific equivalent) for all TypeScript changes. Exercise `pnpm tauri dev` when changing Rust, IPC, packaging, or native integration.

## Commit & Pull Request Guidelines

Existing commits use concise Conventional Commit subjects such as `feat(ui): ...`. Use `type(scope): summary` with a focused scope (`ui`, `engine`, `core`, or `tauri`), and keep unrelated work separate. Pull requests should explain user-visible behavior, list validation commands and results, identify packaging or licensing impacts, and include screenshots for UI changes. Do not commit secrets, generated runtime bundles, or unreviewed third-party artifacts.
