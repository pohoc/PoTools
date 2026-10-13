# Repository Guidelines

## Project Structure & Module Organization

PoTools is a pnpm workspace for a local-first desktop file-tools application:

- `apps/web/` contains the Vite + React UI, static assets, and bundled licenses.
- `apps/desktop/` contains the Tauri host, with Cargo/Tauri config at the app root and Rust code under `src/`.
- `packages/core/` is the Rust shared protocol/catalog crate; `catalog/*.json` is the shared tool metadata consumed by Rust.
- `packages/engine/` is the Rust tool engine library, built as native Rust for Tauri and WebAssembly for browser Workers. Keep host APIs and UI adapters in `apps/web/` and privileged native services in the Tauri app.
- `scripts/` contains repository utilities; `samples/` contains fixtures for tool checks; `docs/` contains normative engineering and UX standards, tool audit/risks, RFCs, historical plans, and licensing documentation.

Keep business and engine behavior in the packages, UI state and presentation in `apps/web/src`, and avoid committing generated build output.

## Build, Test, and Development Commands

Use Node 20.19+ or 22.12+, pnpm 12, and Rust stable. From the repository root:

```sh
pnpm install                 # install workspace dependencies
pnpm dev                     # run the web frontend
pnpm tauri dev               # run the native desktop application
pnpm wasm:build              # build the Rust engine for browser Workers
pnpm --filter @potools/web build # build the Web app
pnpm lint                    # oxlint (correctness + hooks + unused code)
pnpm --filter @potools/web typecheck # type-check the Web adapters/UI
pnpm test:tools              # run browser tool checks
pnpm samples                 # generate or refresh engine samples
```

Everything CI enforces is available as one command:

```sh
pnpm check                   # version + lint + typecheck + rust fmt/clippy/test
```

Individual gates: `pnpm version:check` (manifests match the root version),
`pnpm lint` (`oxlint .`), `pnpm typecheck`, `pnpm rust:fmt`, `pnpm rust:clippy`
(`-D warnings`), `pnpm rust:test`, `pnpm rust:check:wasm` (wasm32 compile),
`pnpm licenses:check` (committed inventory matches the resolved graph).

Toolchain expectations are declared in `rust-toolchain.toml` (stable + rustfmt +
clippy + wasm32 target) and `rustfmt.toml` (default style, pinned); formatting is
`cargo fmt`, linting is `clippy` for Rust and `oxlint` for TypeScript. ESLint is
deliberately absent: `typescript-eslint` does not support the TypeScript 7 this
repo uses, and oxlint covers the same ground without the compiler API.

Use `pnpm dev:web` when working on the Web app. The `@potools/desktop` app owns Tauri; `@potools/web` owns the UI and browser host adapters.

## Coding Style & Naming Conventions

Use Rust for shared core behavior and engine tool logic. Use TypeScript with strict typing and 2-space indentation for `apps/web` UI and browser capability adapters. Prefer React function components, hooks, and descriptive PascalCase component filenames; use camelCase for variables, functions, and utilities. Keep shared contracts in `packages/core`. Follow the existing Tailwind/CSS conventions and use the established i18n files for user-visible text rather than hardcoding strings.

Theme colours come from `packages/ui/src/theme/tokens.css` and are addressed by
role. Use `--ui-line` for decorative separation (cards, panels, overlays,
dividers) and `--ui-control-line` for anything whose border is how a user
identifies an interactive control (fields, choice controls, segmented controls,
bordered buttons, slider thumbs, drop zones). The latter is the 3:1 tier required
by WCAG 2.2 SC 1.4.11; do not use it for decoration, and do not put an interactive
control's boundary on the decorative tier.

## Documentation & Tool Experience Guidelines

Before adding or modifying tools, read `docs/README.md`, `docs/standards/TOOL_DEVELOPMENT.md`, and `docs/standards/TOOL_INTERACTION.md`. Record the tool's primary user task, experience archetype, execution mode, output shape, platform support, failure/recovery paths, and measurable acceptance criteria. Check `docs/audits/TOOL_UX_MATRIX.md` for the tool's proposed UX; this matrix is a static design audit, not proof of a UI bug or completion. Proposed schema/API changes belong in `docs/rfcs/` before broad migrations. `docs/plans/` contains historical plans and must not override adopted standards.

All privileged file and network operations require Rust-side authorization and negative tests; consult `docs/standards/ENGINE_SECURITY.md`. Changes to a tool's UX, routing, or host capability must update the audit matrix and relevant standards. Consult `docs/standards/QUALITY_GATES.md` for manual, automated, and packaged-app acceptance; `pnpm check` does not run `pnpm test:unit` or `pnpm test:tools` today.

## Testing Guidelines

There is no separate unit-test runner configured. Run `pnpm test:tools` for the engine’s end-to-end coverage, including content assertions, format round-trips, error paths, and cleanup. Pure frontend helpers (path and output-dir resolution, date preset echo) carry `node:test` unit tests under `apps/web/tests/` — run `pnpm test:unit` when touching them, and keep new pure logic there covered the same way. Run `pnpm lint` and `pnpm typecheck` (or the package-specific equivalent) for all TypeScript changes, and `pnpm rust:test` plus `pnpm rust:clippy` for Rust changes. Exercise `pnpm tauri dev` when changing Rust, IPC, packaging, or native integration, and the packaged build when changing the WebView security config (`csp`, capabilities) or theme tokens.

## Commit & Pull Request Guidelines

Existing commits use concise Conventional Commit subjects such as `feat(ui): ...`. Use `type(scope): summary` with a focused scope (`ui`, `engine`, `core`, or `tauri`), and keep unrelated work separate. Pull requests should explain user-visible behavior, list validation commands and results, identify packaging or licensing impacts, and include screenshots for UI changes. Do not commit secrets, generated runtime bundles, or unreviewed third-party artifacts.
