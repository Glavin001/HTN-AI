# htn-ai — Web Preview (Squad Combat + Staircase World)

A small Next.js + [react-three-fiber](https://github.com/pmndrs/react-three-fiber)
app that **visualizes the `htn-ai` planner running in the browser**.

## What it shows

Scenes selectable from the scenario dropdown, each driving the **real reactive
`Planner`** in the browser (the app never re-implements planning).

### ★ Squad combat (F.E.A.R.-style game AI)

Four scenarios where coordinated NPCs run one reactive `Planner` each over a
shared world + blackboard (see [`../../scenarios/squad-combat.ts`](../../scenarios/squad-combat.ts)).
Select an NPC (click it, or use the **glass-box AI-director** panel) to watch its
live plan, the executing step, recent trace events, and **why a branch was
rejected**. The playback slider is a deterministic **replay** of the engagement.

- **Skirmish** — two NPCs flush a target with coordinated **suppress-and-flank**:
  one pins inside a `scoped({ maintain: !flankerReady })` block while the other
  swings to a flank cover; reaching position releases the suppressor to push.
- **Emergent flank** — a barricade blocks the direct line of fire. The flank is
  **not scripted**: method selection *derives* that the unit must reposition to a
  cover that geometrically sees the target (the staircase emergence, on combat).
- **Timed breach** — a fire-team **stacks and breaches in sync** inside a
  `scoped({ deadline })` window; the projected-clock deadline prunes anyone who
  can't make it *in search*.
- **Companion + orders** — an allied companion auto-assists, and takes orders
  (**Engage / Regroup / Hold fire**) routed through `Planner.setGoals` — the LLM
  seam. Issue an order at any scrubbed moment and watch the plan change on replay.

### Staircase World (spatial GOAP)

Each scene below drives the same reactive `Planner`:

- **Staircase** (flagship, [`../../scenarios/staircase.ts`](../../scenarios/staircase.ts)) —
  the goal is a pure **3D coordinate** (*"be up in the air at (x, y, z)"*). It does
  **not** tell the agent to place blocks or build anything; because the only way
  to gain height is to stand on blocks, the planner **discovers** it must carry
  blocks from the supply depot, build a staircase, and climb it.
- **Climb the ledge** — a 2-high wall the agent can't scale directly (you ascend
  one level at a time); the planner builds a single support step and walks over.
- **Quarry (advanced)** — a grid world: reach the top of a **height-4 pillar**.
  Six blocks are **scattered across two depots**, a **wall pillar** is impassable,
  and the agent can only climb one level at a time. From a position-only goal the
  planner finds the optimal route to collect from both depots and build a 3-step
  staircase (1→2→3) to climb up — solved optimally by pure GOAP (~1.5k node
  expansions; see [`../../tests/spatial.ts`](../../tests/spatial.ts)).
- **Scavenger (collect & harvest)** — blocks lie **scattered on the ground**
  (no depots). You can only take the **top** of a stack, and only if you're high
  enough to reach it (`stand ≥ height−1`), so a 2-pillar's top block is out of
  reach from the ground. From a position-only goal the planner grabs a loose
  block, **builds a step, climbs it, harvests the pillar's top block**, and uses
  the blocks to reach a coordinate up in the air. Placement is free — the planner
  decides where the steps go.
- **Scavenger XL (taller, harder)** — a bigger 4×3 grid, a **height-3** goal, and
  seven scattered blocks (five loose + a 2-pillar). Loose blocks alone are
  insufficient, so the planner harvests the pillar — using loose blocks as
  stepping stones to reach its top — and stacks a 3-level structure to climb up.
  Solved with a greedier search weight (~0.5s).
- **Scavenger HUGE (stress · ~9s)** — a 6×4 grid (24 cells) littered with blocks;
  a deliberate stress test, ≈10× the compute of the others (~9s to plan, the page
  is busy while it searches). Demonstrates the planner solving a large symbolic
  problem from a position-only goal. Search is hard-capped (`maxNodes`) so it can
  never run away. (Benchmarkable headless via `HTN_BENCH=1 npm test`.)
- **Blocks World (Sussman)** ([`../../scenarios/blocks.ts`](../../scenarios/blocks.ts)) —
  the classic Sussman anomaly: `C on A`, `A`/`B` on the table, goal `A-on-B-on-C`.
  The naive order deadlocks, so the planner interleaves subgoals.
- **Build a wall (structure goal)** ([`../../scenarios/wall.ts`](../../scenarios/wall.ts)) —
  the goal is **not a position to stand at**, and **not a recipe** either. It is one
  **declarative end-state**: `∧ height(cell) ≥ 2` over an octagonal ring (a 5×5
  perimeter minus its corners — 12 cells) enclosing a courtyard on a 9×9 yard. The
  domain has only the primitive operators `goto` / `grab` / `place` — **no "build
  wall" task, no "place a block here" method**. The planner is told *what the world
  should look like*, never *how*, and **discovers** pickup-and-place by search.

  The lesson is *scale*. Laying an N-cell wall is a conjunction of N near-identical,
  serializable sub-goals; one search over the whole conjunction blows up
  combinatorially (every ordering and block↔slot assignment is a distinct state).
  The standard symbolic-planning fix is to **serialize** — and the reactive
  `Planner`'s **`goalAgenda: true`** option does it generically: it **splits a
  declarative conjunction `goal(a ∧ b ∧ …)` into its conjuncts itself** and commits
  to them one at a time (solve, commit, plan the next from the reached state). The
  agenda comes from the goal's own structure, not from the caller naming a task per
  cell — so one exponential search becomes N small ones, *linear* in cells (the
  9×9 / 24-block wall plans in well under a second).

  Two domain rules make serialization **sound** (sub-goals never clobber each other):
  `grab` may only take from a **`source`** cell (the scatter pile), so a laid block
  is never cannibalised; and `place` reaches **one level up**
  (`height(stand) ≥ height(at) − 1`, mirroring `grab`), so a 2-course wall is laid
  from the ground without ever climbing the half-built wall — each cell independent.
  The yard ends tidy (24 blocks, 24 slots; courtyard left clear). See
  [`../../tests/wall.ts`](../../tests/wall.ts), which also builds a *different*
  structure (a free-standing 2-tall tower) from the same operators and goal form.

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
| Goal = a block structure (wall) | one declarative `∧ height(cell) ≥ k`; `goalAgenda` auto-splits the conjunction and serialises; placements are discovered, not prescribed |

This is an intentionally small seed of the planned `@htn-ai/devtools` inspector
and `@htn-ai/react` adapter described in `ROADMAP.md`.
