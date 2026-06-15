# htn-ai — Web Preview (Staircase World)

A small Next.js + [react-three-fiber](https://github.com/pmndrs/react-three-fiber)
app that **visualizes the `htn-ai` planner running in the browser**. It is the
implementation of "Task 4" in [`../../PLAN-web-demo-and-block-stacking.md`](../../PLAN-web-demo-and-block-stacking.md).

## What it shows

Three scenes, selectable from the scenario dropdown, each driving the **real
reactive `Planner`** in the browser (the app never re-implements planning):

- **Staircase** (flagship, [`../../scenarios/staircase.ts`](../../scenarios/staircase.ts)) —
  the goal is a pure **3D coordinate** (*"be up in the air at (x, y, z)"*). It does
  **not** tell the agent to place blocks or build anything; because the only way
  to gain height is to stand on blocks, the planner **discovers** it must carry
  blocks from the supply depot, build a staircase, and climb it.
- **Climb the ledge** — a 2-high wall the agent can't scale directly (you ascend
  one level at a time); the planner builds a single support step and walks over.
- **Blocks World (Sussman)** ([`../../scenarios/blocks.ts`](../../scenarios/blocks.ts)) —
  the classic Sussman anomaly: `C on A`, `A`/`B` on the table, goal `A-on-B-on-C`.
  The naive order deadlocks, so the planner interleaves subgoals.

The right-hand panel shows the live world state, the **plan the search
discovered**, and the planner's **`TraceEvent` stream** (so repair/replan show up
when they happen).

## Run it

```bash
cd examples/web
npm install
npm run dev      # http://localhost:3000
```

The library is imported straight from source via a webpack alias
(`htn-ai → ../../src/index.ts`) and the shared scenarios via `@scenarios/*`, so
changes to the core library hot-reload here with no rebuild.

## Build / deploy

```bash
npm run build    # static export to ./out  (Next.js `output: "export"`)
```

The output in `out/` is a fully static site — deploy to Vercel, GitHub Pages, or
any static host. A [`vercel.json`](./vercel.json) is included. On Vercel, set the
project **Root Directory** to `examples/web` (the app lives in a subfolder of the
library repo).

## How it maps to the library

| UI piece | htn-ai feature |
|---|---|
| Agent building + climbing | `Planner.tick()` executing the discovered plan |
| "Plan · discovered by search" | the `Plan` from goal search over `goto`/`pick`/`place` operators |
| World-state panel | `model.read(state, fluent, …)` over typed fluents |
| Trace events panel | the `trace:` `TraceEvent` stream (`plan.*`, `step.*`, `repair.*`, …) |
| Goal = a 3D coordinate | a position-only goal (`agentAt ∧ agentY`), not a prescriptive structure |

This is an intentionally small seed of the planned `@htn-ai/devtools` inspector
and `@htn-ai/react` adapter described in `ROADMAP.md`.
