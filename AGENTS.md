# AGENTS.md

## Cursor Cloud specific instructions

This repo is a TypeScript library (`htn-ai`, an HTN + GOAP planning/execution runtime) plus a standalone Next.js + Three.js web demo under `examples/web`. There are no databases, Docker, or external services.

### Services / how to run

- **Core library** (`/workspace`): not a long-running service. Develop via the npm scripts in `package.json` — `npm run lint`, `npm run typecheck`, `npm test` (uvu suite), `npm run build` (tsup → `dist/`). Optional benchmarks: `npm run bench`.
- **Web demo** (`/workspace/examples/web`): the only runnable server. Run `npm run dev` (Next.js on http://localhost:3000). It imports the library directly from `../../src` via a webpack alias, so you do **not** need to `npm run build` the library first; source edits hot-reload in the demo.

### Non-obvious notes

- Dependencies live in **two** separate npm trees: repo root and `examples/web` (independent lockfiles). The update script installs both.
- `next build` ignores ESLint/TS errors (`next.config.mjs`); use the root `npm run typecheck`/`npm run lint` for real type/lint signal on the library.
- Known pre-existing bug in the demo: selecting some non-default scenarios (e.g. "Blocks World (Sussman)") in the SCENARIO dropdown throws `TypeError: Cannot read properties of undefined (reading 'heavyMs')` from `examples/web/lib/run.ts`. The default "Staircase" scenario works fine. This is unrelated to environment setup.
