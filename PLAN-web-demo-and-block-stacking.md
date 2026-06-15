# Plan: Web App Preview + 3D Block-Stacking Battle-Test

> Status: **Implemented on this branch.** Produced from analysis of this repo (htn-ai v2) and
> the external [`Glavin001/vibe-city`](https://github.com/Glavin001/vibe-city) repo on both
> `main` and `feat/htn-block-stacking`. Covers tasks 3–4: *what scenarios to add to core tests*
> and *what the web app should look like*.
>
> **Shipped:** `scenarios/` (shared blocks + staircase domains), Tier A tests (`tests/blocks.ts`)
> and Tier B tests (`tests/spatial.ts`) — suite now 67 tests — and the web preview
> (`examples/web/`, Next.js static export + react-three-fiber). The block-stacking **goal was
> refined to be a pure 3D position** (see §2 Tier B): the planner must *discover* it has to build
> a staircase; the goal never prescribes block placement or any structure.

## 0. TL;DR

1. **Block-stacking battle-test (task 3):** add two tiers of scenarios that hit the planner's
   biggest *untested* seams — (A) a richer **symbolic Blocks World** run through the reactive
   `Planner` with **repair** and **multi-agent** variants, and (B) a **spatial "Staircase World"**
   where positions, reachability, and build-order are discovered *by search* (not hand-rolled).
2. **Web app preview (task 4):** a lightweight **Vite + React + react-three-fiber** demo app under
   `examples/web/`, reusing vibe-city's visualization blueprint but driven by htn-ai v2's
   **`TraceEvent` stream** + **deterministic replay** to deliver the **devtools inspector** the
   ROADMAP already calls for (live decomposition graph, why-rejected, world-state diff,
   time-travel scrubber). The core library stays zero-dependency and untouched.

Both directly advance milestones already in `ROADMAP.md`/`SPEC.md`: **M-2 "the demo that markets
itself"** (§205) and **M5 devtools inspector** (§187–189).

---

## 1. What the analysis established

### 1.1 htn-ai v2 (this repo) — capabilities & gaps
- **Browser-ready core:** pure ESM, **zero runtime dependencies**, no `node:*` imports. `tsup`
  already emits `esm`/`cjs`/**`iife`** (`globalName: HtnAI`) + a `unpkg` entry. A web app can
  import it directly (built package or a Vite path-alias to `src/index.ts`).
- **Rich API surface:** typed fluents (`boolean|enum|int|float|entity|vec2|vec3`), lifted
  operators (`pre`/`verify`/`eff`/`cost`/`duration`/`executor`), HTN methods & compounds, **axioms**
  (derived predicates), goals (`task()` / `achieve()`), **scopes** (`deadline`/`maintain`/
  `minHold`/`onExit`), budgeted/anytime/resumable `Planner.tick({ms})`, **suffix plan repair**,
  **MTR replan-if-better**, a multi-agent **`Scheduler`**, and a **`TraceEvent`** observability
  stream (`plan.*`, `step.*`, `scope.*`, `repair.*`, `replan.dirty`, `drift`).
- **Deterministic:** seeded RNG (`createRng`) + injected `now()` ⇒ byte-identical replays — the
  foundation for a time-travel inspector.
- **Coverage gaps (the battle-test targets):**
  - **Spatial/vector reasoning is the biggest gap.** `vec2`/`vec3` and `N.dist` exist but are only
    smoke-tested — *no test lets geometry drive a precondition, cost, or heuristic.*
  - **Blocks World is minimal** (3 blocks, relational `on`/`clear`, `planOnce` only) — never scaled,
    never executed through a `Planner`, never repaired.
  - **Multi-agent coordination is untested** — the `Scheduler` only runs *independent* agents; no
    shared/contended world state, handoffs, or one agent invalidating another's plan.
  - Thinner spots: relaxation quality on numeric/external conditions, `weight` tuning, deep nested
    scopes × repair interaction.

### 1.2 vibe-city `main` — reusable visualization blueprint
- Ships **three** "bunker" demos over one scenario: `/bunker-htnai` (**htn-ai v1**, *not* our v2 API),
  `/bunker-fluid` (FluidHTN C#→WASM), `/bunker` (mahler).
- **Reuse the viz, not the domain code** (v1 ≠ v2 API). Directly transferable patterns:
  - **Plan-then-animate** loop: plan once → iterate a token plan (`MOVE x`, `PICKUP_KEY`…) → `await`
    one animation per step → flip world facts → React re-renders.
  - **Controlled goal/initial-state editor** panel, **"Current State" fact HUD** (green/red booleans),
    **in-scene plan overlay** (drei `<Line>` route + numbered label sprites), **node→Vec3 map**
    bridging symbolic state to 3D, **auto-run on edit**.
  - Stack: Next.js App Router, `@react-three/fiber@9`, `@react-three/drei@10`, `three@0.18x`,
    Tailwind v4.
- **Drop:** the WASM/Docker toolchain, the 3× duplicated ~600-line pages (→ one page + a pluggable
  `planFn`), and all Rapier/CSG/navmesh/AI-SDK weight (none needed for planning viz).

### 1.3 vibe-city `feat/htn-block-stacking` — the cautionary tale
- "**Navcat Block Stacker**": an agent builds a **staircase** on an 8×8 grid to climb a goal tower.
  Imports `htn-ai` v1 **but bypasses real HTN** — the winning method is a single `planonly` effect
  wrapping a hand-rolled **greedy frontier-filling loop**; world state is a bare `grid[x][z]`
  height-map (no block identities), navigation is `navcat`/recast navmesh.
- **The tell:** a literal `// TODO(backtracking): enable this when the planner supports multi-step
  lookahead/backtracking`. They hit the planner's limits and routed around it.
- **Two genuinely-hard ingredients worth keeping:** (a) **state-dependent reachability** — every
  pick/place changes what's walkable; (b) the physical **"must build support before you can stand/
  place higher"** ordering constraint.
- **Lesson for us:** model the world *natively* (real block identities, `on`/`clear`, conjunctive
  goal, reachability as a planner-visible derived fact) and let **search/decomposition discover the
  build order** — exactly the thing that battle-tests a planner.

---

## 2. Task 3 — Block-stacking battle-test scenarios

Goal: add scenarios that force the planner through its untested seams, each asserted against
ground-truth optima in the existing `uvu` style (cf. `tests/puzzles.ts`), and at least one runnable
through the reactive `Planner` so the web app can visualize it. Proposed as **two tiers**.

### Tier A — "Blocks World+" (symbolic; scales the classic)
Extends the existing 3-block test (`tests/puzzles.ts`) along three axes. Pure relational
(`on`/`clear`/`holding`/`handEmpty`) so optima are known and assertions are crisp.

1. **Sussman anomaly (the canonical reorder trap).** Start `C on A`, `A`/`B` on table; goal
   `A on B on C`. Naive subgoal order deadlocks; optimal is 3 moves. Verifies the search interleaves
   subgoals correctly (delete-relaxation heuristic behavior on a known hard instance).
2. **Scale the tower (search/heuristic stress).** Parameterized N-block instances (4/6/8 blocks,
   e.g. full reversal of a stack) asserting optimal move counts and bounded node expansions —
   exercises heuristic informativeness and the grounding-explosion guard.
3. **Reactive execution + repair (the headline gap).** Run a build through `new Planner(model, …)`
   with executors instead of `planOnce`, then **perturb mid-plan**: an executor for `place` flips a
   `slipped` fluent (the block falls back to the table). Assert the planner emits `step.fail` →
   `repair.attempt`/`repair.success` and still reaches the goal — the first test of **suffix repair
   on a stacking domain**.
4. **Two-arm multi-agent (coordination gap).** Two arms share one table (shared `ExecState`/
   contended `clear`/`holding` fluents) driven by the `Scheduler`. Assert both make progress without
   trampling each other (one arm's effect invalidating the other's plan → cross-agent replan). First
   test of the `Scheduler` over **shared, contended state**.

*Domain sketch (matches the verified v2 idiom in `tests/puzzles.ts`):*
```ts
// on(b) : entity (0/table), clear(b) : boolean, holding : entity, handEmpty : boolean
operators: [
  { name: "pick",    params: [{name:"x",type:"block"}],
    pre: F.and(F.lit("handEmpty",[],true), F.lit("clear",["?x"]), F.lit("on",["?x"],0)),
    eff: [E.set("holding",[], "?x"), E.set("handEmpty",[],false), E.set("clear",["?x"],false)] },
  { name: "stack",   params: [{name:"x",type:"block"},{name:"to",type:"block"}],
    pre: F.and(F.lit("holding",[],"?x"), F.lit("clear",["?to"]), F.ext("neq",["?x","?to"],[])),
    eff: [E.set("on",["?x"],"?to"), E.set("clear",["?to"],false), E.set("clear",["?x"],true),
          E.set("handEmpty",[],true), E.set("holding",[],0)] },
  // … unstack / put-down symmetric
]
```

### Tier B — "Staircase World" (spatial; the 3D headline scenario)
A native-HTN reimagining of the Navcat demo. The world is a small grid; the agent must **build a
staircase out of supply blocks to climb onto a goal tower** — but *order and navigation are
discovered by the planner*, not scripted. This is the scenario the web app renders in 3D.

**Why it battle-tests the planner (one scenario, many untested seams):**
- **Spatial cost/heuristic:** movement cost via `N.dist` over `vec2`/`vec3` cell positions — first
  test where **geometry drives the search**.
- **State-dependent reachability:** `height(cell)` is an `int` fluent that operators mutate; whether
  the agent can step `from→to` depends on `|height(to) − agentLevel| ≤ 1`. Placing a block *creates*
  new reachable cells — modeled as a **planner-visible precondition/axiom**, not a hidden navmesh
  rebuild. This is the genuinely-hard property the Navcat demo had but hid.
- **Ordering constraint:** you can't stand at level 3 until the level-2 step exists ⇒ the build order
  *emerges* from preconditions (the `TODO(backtracking)` the v1 demo punted on).
- **Resource accounting:** finite `supply(cell)` crates; the planner must allocate and may exhaust a
  crate and pick another.
- **Decomposition + reactive execution:** HTN methods for `BuildColumnTo`/`AcquireBlock`/`ReachGoalTop`,
  run through the `Planner` with `duration`s so the web app gets a real timeline; optional `deadline`
  scope makes it a temporal test too.

*Design choices to keep it tractable & deterministic:*
- Grid as `cell` entities with a static `adj(cell,cell)` table (relational adjacency, like existing
  tests) **plus** a `pos(cell):vec2` fluent so `N.dist` can drive movement cost — gets spatial
  reasoning into the loop without full geometric pathfinding.
- Reachability/"climbable" expressed as an **axiom** over `height` + `adj` (derived, re-evaluated as
  heights change) — exercises the axiom system, which only `tests/core.ts` lightly touches.
- Keep the first instance small (≈5×5, 3–4 stair steps, 2–3 supply crates) with a known optimal
  step/cost count for assertions; scale up as a perf/anytime case.

**Goal (position-only — the planner discovers the "how"):** the goal is purely a **3D position** —
`agentAt = targetCell ∧ agentY = TARGET_Y` (be at the target's x,z, up in the air at elevation
TARGET_Y). It deliberately does **not** mention block placement or any column height. Because the
only way to raise `agentY` is to stand on a column, and the only way to build higher is to first
stand higher, the staircase + its build order *emerge from search*. (The shipped domain expresses
the climb/place constraints as operator preconditions over `height`; reachability is local
adjacency + a one-level climb limit rather than a transitive-path axiom, which keeps it tractable.)

### Where the code lives
- Battle-tests: new `tests/blocks.ts` (Tier A) and `tests/spatial.ts` (Tier B), `uvu`-style,
  asserted against optima — they run in CI (`npm test`) like the other suites.
- **Shared scenario definitions** (so the web app and tests don't drift): a small
  `scenarios/` module (plain TS, imports only `htn-ai` types) exporting each `DomainDoc` +
  `WorldSetup` + `Registry` + the goal. Tests import it for assertions; the web app imports it for
  visualization. *(Alternative: keep domains inline in tests and re-export; decision in §4.)*

---

## 3. Task 4 — Web app preview

A demo that **shows what v2 can do that v1/competitors can't**: budgeted planning, repair,
replan-if-better, scopes/deadlines, multi-agent, and an auditable trace — visualized live.

### 3.1 Placement & stack (keep the core clean)
- New top-level **`examples/web/`** with its **own `package.json`** — *not* part of the library's
  build/test/CI, so the published `htn-ai` package stays zero-dependency.
- **Vite + React + TypeScript + react-three-fiber + drei + Tailwind.** Vite (not Next.js) because
  there's no SSR need, it's lighter, has instant HMR, and deploys to **GitHub Pages** trivially for a
  public preview. (Next.js is the vibe-city choice; we don't need its weight here.)
- Consume the library via a **Vite alias `htn-ai → ../../src/index.ts`** in dev (instant HMR when the
  library changes) with a switch to the built package for the deployed build.
- Optional: wire as an npm **workspace** so `examples/web` resolves `htn-ai` from the repo root
  without publishing. (Adds a root `package.json` `workspaces` field; low risk, keeps CI green since
  the web app isn't in the root test/build scripts.)

### 3.2 The three panels (maps to ROADMAP M-2 demo + M5 inspector)
1. **3D World view** (`@react-three/fiber`): renders the active scenario — Staircase World as the
   flagship (grid, supply crates, goal tower, agent, carried block, growing staircase), plus simpler
   ones (Blocks World as stacked cubes, Gripper, Bunker). Reuses vibe-city's **node→Vec3 map**,
   **in-scene plan overlay** (`<Line>` route + numbered step labels), and **plan-then-animate**
   playback for clarity.
2. **Inspector** (the differentiator — fed by the `TraceEvent` stream):
   - **Live decomposition graph** — HTN method/compound tree with the active branch highlighted
     (React Flow + dagre/elkjs), per ROADMAP §187.
   - **World-state fluent HUD** with type-aware rendering and **diff-on-change** highlighting.
   - **Plan timeline** — steps with projected ETAs from `duration`s, current step + scope deadlines
     marked; shows budgeted/anytime progress.
   - **Trace log** — color-coded `plan.*`/`step.*`/`scope.violated`/`repair.*`/`replan.dirty`.
   - **"Why rejected?"** — surfaced via `explainFailure`/`validatePlan` (the LLM-facing APIs).
   - **Time-travel scrubber** — record the trace, scrub back/forth; deterministic (seed + injected
     clock) so replays are exact. Answers ROADMAP's bar: *"why didn't the agent do X?" from the
     inspector alone.*
3. **Controls:** scenario picker, goal/initial-state editor (vibe-city's controlled-panel pattern),
   **play/pause/step**, speed, a **planning-budget slider** (visibly demonstrate `tick({ms})`
   resuming search across frames), seed, and **perturbation buttons** (inject a block "slip" / jam a
   path → watch **repair** vs **replan** live), reset.

### 3.3 How it drives the planner
Two modes, both off the same scenario definitions:
- **Playback mode** (simple, vibe-city-style): `planOnce` → animate the token plan. Best for first
  impression and the plan overlay.
- **Live mode** (the showcase): drive `planner.tick({ ms: budget })` from `useFrame` with an injected
  clock; subscribe `trace:` to feed the inspector. This is what makes repair/replan/scopes/multi-agent
  legible — none of which the vibe-city demos show.

### 3.4 Phasing
- **Phase 1 — MVP (proves it runs in-browser):** Vite scaffold + alias; Staircase World in 3D;
  plan-then-animate playback; fluent HUD; plan list; scenario picker. Reuses the vibe-city blueprint
  almost verbatim.
- **Phase 2 — Inspector:** trace log + plan timeline + world-state diff + decomposition graph +
  time-travel scrubber; switch the flagship to **live `tick` mode**.
- **Phase 3 — Showcase & deploy:** budget slider, perturbation→repair demo, two-arm multi-agent via
  `Scheduler`, more scenarios (Blocks World+, Gripper, Bunker), deploy to GitHub Pages. This is the
  artifact for ROADMAP's "demo that markets itself."

### 3.5 Relationship to the roadmap's package plan
The inspector here is the prototype of the planned **`@htn-ai/devtools`**, and the React glue is the
seed of **`@htn-ai/react`** (ROADMAP §228, SPEC §349). Building it in `examples/web/` first lets us
extract those packages later without committing to the monorepo split now.

---

## 4. Open decisions (need your call)

1. **Session scope:** is this session *plan-only* (this doc), or should I proceed to **implement**
   (Tier-A tests first, then scaffold Phase-1 web app)?
2. **Web framework:** **Vite** (recommended — light, HMR, GH Pages) vs **Next.js** (matches
   vibe-city, heavier).
3. **Shared scenarios:** factor domains into a `scenarios/` module shared by tests + web app
   (DRY, recommended) vs keep them inline in tests and re-declare in the app.
4. **Block-stacking emphasis:** lead with **Tier B Staircase World** (spatial, most visual, biggest
   gap) or land **Tier A Blocks World+** first (smaller, pure-symbolic, fastest to ground-truth)?
   Recommendation: **Tier A first** (quick CI-backed wins), **Tier B** as the web-app flagship.

---

## 5. Suggested file layout

```
HTN-AI/
├─ src/…                         # unchanged, zero-dep core
├─ scenarios/                    # NEW (optional): shared DomainDocs (blocks, staircase, …)
├─ tests/
│  ├─ blocks.ts                  # NEW: Tier A — Sussman, scale, repair, multi-agent
│  └─ spatial.ts                 # NEW: Tier B — Staircase World, vec/dist, reachability axiom
└─ examples/
   └─ web/                       # NEW: Vite + React + r3f demo (own package.json)
      ├─ src/scenes/             # 3D scenes per scenario
      ├─ src/inspector/          # trace log, timeline, decomposition graph, scrubber
      └─ vite.config.ts          # alias htn-ai → ../../src/index.ts
```

---

## 6. Immediate next steps (on approval)
1. Land **Tier A** `tests/blocks.ts` (Sussman + scale + repair + two-arm) — fast, CI-backed.
2. Author **Staircase World** `DomainDoc` in `scenarios/`, prove optimal plan via `planOnce` in
   `tests/spatial.ts`, then run it through `Planner` with executors.
3. Scaffold **`examples/web/`** Phase 1 (3D Staircase + playback + HUD).
4. Layer in the **inspector** (Phase 2) off the `TraceEvent` stream.
