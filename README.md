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
| Structured plan-event stream for a director | `new PlanEventStream().attach(planner, "alpha")` → `stream.drain()` |
| Deterministic runs & serializable domains | seeded RNG, injected clock, `domainToJSON` / `domainFromJSON` |
| Escape hatches (semi-symbolic & opaque) | `F.ext(name, args, declaredReads)`, registry executors/predicates/effects |

### Plan events for a director

`PlanEventStream` correlates the low-level trace into plan-lifecycle events for a game director / mission narrator / LLM: `plan.created` (with the step list, cost and makespan), `step.started` / `step.completed`, `plan.completed`, and `plan.invalidated` / `plan.failed` carrying **structured reasons** — `world-changed` (with the fluents that changed), `step-failed` (with a `precondition` / `verify` / `executor` / `scope` / `drift` cause, plus the violated scope), or `search-exhausted` (with the search's rejection log). Events are plain JSON-serializable data stamped with agent, per-agent plan id, global sequence and the planner clock; many planners can share one stream so the director consumes a single merged feed.

```ts
import { PlanEventStream } from "htn-ai";

const stream = new PlanEventStream();
stream.attach(planner, "alpha"); // and attach the rest of the squad…

// each frame:
planner.tick({ ms: 1 });
for (const e of stream.drain()) director.observe(e); // typed PlanEvent union

// e.g. { t: "plan.invalidated", agent: "alpha", planId: 2, seq: 17, at: 6.1,
//        reason: { kind: "step-failed", step: "GoTo(room)", cause: "precondition", … } }
```

See it working: the web preview's **[`/director` page](./examples/web)** runs the ~6-operator demo domain ([`scenarios/director.ts`](./scenarios/director.ts): GoTo / Breach / TakeCover / Suppress / Regroup / Idle — live-query external preconditions, traversal-oracle costs) in the browser with sabotage buttons, and **`npm run demo:director`** ([`examples/director-feed.ts`](./examples/director-feed.ts)) prints a narrated feed of the same mission headlessly. [`tests/director.ts`](./tests/director.ts) pins the full contract — including a `<10ms` replan gate (measured ~0.2–1ms).

## Game AI: squad combat (F.E.A.R.-style)

[`scenarios/squad-combat.ts`](./scenarios/squad-combat.ts) is a vertical slice that drives this engine as **game AI** — the use case [F.E.A.R.](https://en.wikipedia.org/wiki/F.E.A.R._(video_game)) made famous, where the *illusion of intelligence* came not from a fancy per-agent planner but from **squad coordination** layered over modest GOAP. The headline scenarios pit **two autonomous squads (Red vs Blue)** against each other: every unit runs the real reactive `Planner` (one `Model` + `ExecState` each — the ExecState *is* that unit's private belief/working memory) and plans from **what it alone has perceived** — there is no shared memory across teams. A per-unit perception step (line-of-sight + hearing + memory decay) produces the dirty writes that drive fluent-precise reactive replanning, so as each side discovers the other's moves it **invalidates and readjusts** its plan in real time. Each team coordinates its own squad through a private blackboard. No core changes — it's all built from the existing extension points.

It matches F.E.A.R., then exceeds it:

- **Coordinated suppress-and-flank** — a coordinator promotes two NPCs in contact to a flank tactic; the suppressor lays covering fire inside `scoped({ maintain: !flankerReady })` while the flanker swings wide. Reaching position reactively releases the suppressor to push.
- **Emergent spatial tactics ★** — with the direct lane blocked, the flank is **not scripted**: method selection (`coverSeesThreat`) *derives* that the unit must reposition to a cover that geometrically sees the target — the library's "discover the staircase" emergence, turned on combat.
- **Cover reservation** — a `coverTaken` belief plus a `verify` on the move operators means a unit whose slot is stolen mid-move aborts and repairs to a free one; no two NPCs ever share cover.
- **Timed synchronized breach** — a fire-team stacks and breaches inside one `scoped({ deadline })` window; the projected-clock deadline prunes anyone who can't make it *in search* — temporal coordination F.E.A.R. lacked.
- **Collaborative companion + player orders** — an allied companion auto-assists (and never targets a friendly), taking orders routed through `Planner.setGoals` — the seam an LLM later drives.
- **Glass-box & deterministic** — structured `TraceEvent`s + `explainFailure` expose each NPC's plan and *why a branch was rejected*; a seeded, fixed-timestep rollout makes the whole engagement a deterministic replay.

Run it: the browser demo in [`examples/web`](./examples/web) renders four squad scenarios in 3D with a live glass-box AI-director panel (per-NPC plan, live step, "why not X", reservations); [`tests/squad.ts`](./tests/squad.ts) pins every behaviour above as a ground-truth assertion.

## Install & develop

```bash
npm install htn-ai        # ⚠ v2 is alpha; pin exact versions

npm install               # dev setup
npm test                  # uvu test suite (core, HTN semantics, ground-truth
                          #   puzzles, temporal scenarios, exec/repair, squad combat)
npm run typecheck && npm run lint && npm run build
```

The test suite doubles as documentation: `tests/puzzles.ts` (water jug / blocks world / river crossing / sokoban solved *by search* against known optima), `tests/temporal.ts` (deadlines, time windows, maintain-for-15s, escort), `tests/htn.ts` (FluidHTN-lineage semantics), `tests/exec.ts` (repair, reactivity, budgets, determinism, scheduler), `tests/squad.ts` (F.E.A.R.-style squad combat: emergent flanking, suppress-while-flank, cover reservation, timed breach, companion orders).

## License

MIT — see [LICENSE](./LICENSE). Lineage: inspired by [FluidHTN](https://github.com/ptrefall/fluid-hierarchical-task-network) (semantics) and [GTPyhop](https://github.com/dananau/GTPyhop) (goal+task unification); v2 is an independent implementation.
