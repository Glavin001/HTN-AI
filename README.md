# htn-ai

**Real-time AI planning & execution runtime for TypeScript agents.**

One engine that unifies HTN decomposition (hierarchical methods) and goal search (GOAP-style, weighted-A* with model-derived heuristics) over a typed symbolic representation — with budgeted/resumable planning, plan repair, temporal-lite deadlines & time windows, scoped execution with cleanup, deterministic traces, and validation APIs designed for LLM loops.

> **v2.0.0-alpha — clean-room rewrite.** Design rationale lives in [`ROADMAP.md`](./ROADMAP.md) (research) and [`SPEC.md`](./SPEC.md) (specification). The v1 FluidHTN-port API is gone; its proven semantics (replan-only-if-better via MTR, effect timing tiers, executing conditions) are kept as first-class features. Implementation status vs. spec: [`IMPLEMENTATION.md`](./IMPLEMENTATION.md).

## Why

- **LLMs decide *what*; the planner guarantees *how*, in microseconds.** Run an LLM (or any cognition) above; htn-ai is the deterministic, auditable action layer beneath it: goals & constraints in, verified executable plans out, repaired in real time as the world changes.
- **Planning that respects your frame budget.** Searches run in resumable sessions: `session.step({ ms: 0.5 })` pauses mid-search and continues next tick.
- **Symbolic all the way down.** Typed fluents (boolean / enum / int / float / entity / vec2 / vec3), lifted operators, axioms — so the engine derives heuristics, prunes deadlines *inside search*, explains failures, and serializes domains as plain JSON that LLMs can author and the validator can check.

## Quick example

```ts
import { createModel, Planner, F, E, task, achieve, scoped } from "htn-ai";

const model = createModel(
  {
    name: "escort",
    fluents: [{ name: "at", kind: "enum", values: ["base", "dest"], initial: "base" }],
    operators: [
      { name: "walk",  pre: F.lit("at", [], "base"), duration: 15, cost: 1, eff: [E.set("at", [], "dest")] },
      { name: "drive", pre: F.lit("at", [], "base"), duration: 6,  cost: 5, eff: [E.set("at", [], "dest")] },
    ],
    methods: [
      {
        task: "Deliver",
        subtasks: [scoped({ deadline: 10, label: "within-10s" }, achieve(F.lit("at", [], "dest")))],
      },
    ],
  },
);

const planner = new Planner(model, { goals: [task("Deliver")] });
// each frame:
planner.tick({ ms: 1 }); // plans within budget, executes, repairs, replans-if-better
```

The 10-second deadline is enforced **inside the search**: walking (15s, cheap) is pruned; driving (6s) is chosen. At execution the same deadline is monitored against the real clock, `maintain` conditions abort scopes with `onExit` cleanup, and failures repair from the failure point before falling back to a full replan.

## Feature tour

| Capability | API |
|---|---|
| Typed world state, packed into one buffer | `fluents: [{ name: "ammo", params: [...], kind: "int" }]` |
| Lifted operators with preconditions/effects/costs/durations | `operators: [{ name, params, pre, eff, cost, duration, executor }]` |
| HTN methods, utility selection, free variables bound by search | `methods: [{ task, params, pre, utility, subtasks }]` |
| GOAP-style goals (search over operators, h_add + novelty) | `achieve(F.lit("box", [], "c5"))` / `goal(...)` |
| Derived predicates | `axioms: [{ name: "threatened", body: ... }]` |
| Deadlines, maintained conditions, min-hold, cleanup | `scoped({ deadline, maintain, minHold, onExit }, ...)` |
| Time windows & waits (projected clock) | `T.waitUntil(N.fl("losStart"))`, `F.lte(N.clock(), N.fl("losEnd"))` |
| Budgeted, resumable planning | `new PlanningSession(...).step({ ms, nodes })` |
| Reactive execution: MTR replan-only-if-better, fluent-precise triggers | `new Planner(model, { goals }).tick({ ms })` |
| Plan repair from the failure point | automatic on step failure (`repair.attempt` trace events) |
| Multi-agent staggered planning | `new Scheduler().add(planner); scheduler.tick(budgetMs)` |
| Validation / affordances / explanation (LLM-ready) | `validatePlan`, `simulatePlan`, `applicableActions`, `explainFailure` |
| Deterministic runs & serializable domains | seeded RNG, injected clock, `domainToJSON` / `domainFromJSON` |
| Escape hatches (semi-symbolic & opaque) | `F.ext(name, args, declaredReads)`, registry executors/predicates/effects |

## Game AI: squad combat (F.E.A.R.-style)

[`scenarios/squad-combat.ts`](./scenarios/squad-combat.ts) is a vertical slice that drives this engine as **game AI** — the use case [F.E.A.R.](https://en.wikipedia.org/wiki/F.E.A.R._(video_game)) made famous. The headline scenarios pit **two autonomous squads (Red vs Blue)** against each other: every unit runs the real reactive `Planner` (one `Model` + `ExecState` each — the ExecState *is* that unit's private belief/working memory) and plans from **what it alone has perceived** — no shared memory across teams. A per-unit perception step (line-of-sight + hearing + last-known memory) produces the dirty writes that drive fluent-precise reactive replanning, so as each side discovers the other's moves it **invalidates and re-routes** in real time. No core changes — it's all built from the existing extension points.

The signature idea: there are **no scripted waypoints**. The play area is a **fluid grid of cells**, and a `step(from,to)` operator moves between adjacent cells at a cost of `1 + EXPOSURE_W·exposure(to) + RANGE_W·range(to)`. Engagement is the GOAP goal `achieve(canSee)` — so each unit **searches a multi-step route to a firing line**, trading exposure against closing the distance. It will take the long way around a blocker, or a so-so cell that opens onto a dominant angle, that a greedy "walk toward the enemy" would never find — the library's "discover the staircase" emergence, turned on combat positioning.

It matches F.E.A.R., then exceeds it:

- **Emergent spatial tactics ★** — flanks, covered approaches and break-contact all *emerge* from the exposure-weighted route search over the grid (`adj` is a `static` fluent, so the compiler prunes every non-adjacent `step` grounding — the grid stays cheap to search). Nothing is scripted.
- **Position is a real, mechanical edge** — a probabilistic hit model (closer = deadlier via range, a target in **directional half-cover** is ×0.3 to hit) means the cell the search chose actually changes the odds — cover you path *around*, not onto, and only against the shooters it sits between you and.
- **Single-occupancy cells** — a `cellTaken` belief on the `step` precondition means a claimed cell dirties its rivals, who reactively re-route; two units never converge on one spot.
- **Timed synchronized breach** — a fire-team stacks and breaches inside one `scoped({ deadline })` window; the projected-clock deadline prunes anyone who can't make it *in search* — temporal coordination F.E.A.R. lacked.
- **Collaborative companion + player orders** — an allied companion auto-assists (and never targets a friendly), taking orders routed through `Planner.setGoals` — the seam an LLM later drives.
- **Glass-box & deterministic** — structured `TraceEvent`s + `explainFailure` expose each NPC's plan + route and *why a branch was rejected*; a seeded, fixed-timestep rollout makes the whole engagement a deterministic replay.

Run it: the browser demo in [`examples/web`](./examples/web) renders four squad scenarios in 3D — the fluid grid, each unit's **searched route**, sight lines, and a live glass-box AI-director panel (per-NPC plan, live step, "why not X"); [`tests/squad.ts`](./tests/squad.ts) pins every behaviour above as a ground-truth assertion.

## Install & develop

```bash
npm install htn-ai        # ⚠ v2 is alpha; pin exact versions

npm install               # dev setup
npm test                  # uvu test suite (core, HTN semantics, ground-truth
                          #   puzzles, temporal scenarios, exec/repair, squad combat)
npm run typecheck && npm run lint && npm run build
```

The test suite doubles as documentation: `tests/puzzles.ts` (water jug / blocks world / river crossing / sokoban solved *by search* against known optima), `tests/temporal.ts` (deadlines, time windows, maintain-for-15s, escort), `tests/htn.ts` (FluidHTN-lineage semantics), `tests/exec.ts` (repair, reactivity, budgets, determinism, scheduler), `tests/squad.ts` (F.E.A.R.-style squad combat: emergent searched-route flanking, single-occupancy cells, reactive replanning, timed breach, companion orders).

## License

MIT — see [LICENSE](./LICENSE). Lineage: inspired by [FluidHTN](https://github.com/ptrefall/fluid-hierarchical-task-network) (semantics) and [GTPyhop](https://github.com/dananau/GTPyhop) (goal+task unification); v2 is an independent implementation.
