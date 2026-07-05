# Plan: structured plan-event stream ("the discrete executive" gap)

Target spec (flagship integration doc, §4 HTN-AI):

> Role: valid multi-step plans over the fixed verb set. Feature-frozen; the demo
> domain lives in the flagship repo, not this library.
>
> Must provide: function-based preconditions calling live queries from layers
> 2/5, GOAP costs calling kinocat's oracle, replan on world-state change.
> The one thin addition: a structured plan-event stream — plan created / step
> started / plan failed or invalidated with reason — surfaced as data for the
> director, building on the existing decomposition logging.
> Replans for 3–5 step plans in <10ms.
>
> Done when: a ~6-operator demo domain (GoTo, Breach, TakeCover, Suppress,
> Regroup, Idle) plans and replans correctly in headless tests; failure reasons
> arrive as structured events; zero other library changes were needed.

## 1. Audit: what already exists on `main` (nothing to build here)

| Spec requirement | Status | Where |
|---|---|---|
| Function-based preconditions calling live queries | ✅ exists | `F.ext(name, args, declaredReads)` / `F.opaque` + registry `predicates` (`src/ir.ts`, `src/compile.ts`); declared reads keep reactive replanning fluent-precise |
| GOAP costs calling an external oracle | ✅ exists | operator `cost` is a compiled `NumExpr`; `N.ext` calls registry numerics — the kinocat-oracle plug-in point (squad scenario already uses dynamic `moveEngageCost`) |
| Replan on world-state change | ✅ exists | fluent-level dirty tracking + `methodReads` intersection → improve-session with MTR replan-only-if-better; suffix repair from the failure point (`src/exec.ts` `tick()` / `failStep()`) |
| Decomposition logging to build on | ✅ exists | `TraceEvent` union + per-planner `trace` callback (`src/exec.ts:17`); `collectRejections` + `explainFailure` (`src/trace.ts`) |
| Replans < 10ms for 3–5 step plans | ✅ almost certainly already true; **not yet pinned by a test** | `PERFORMANCE.md`: comparable searches solve in 0.2–4.4ms; squad sim runs 4 planners at 2ms/tick budgets |

## 2. Audit: open PRs — is anything un-merged useful for this spec?

**No. Recommend merging nothing for this task.** Reviewed all 13 open PRs (2026-07-05):

- **#9, #10, #11, #12, #14 (codex drafts, Nov 2025)** — target the *pre-rewrite v1*
  codebase (base `f204f60`/`1a97df8`); `main` is now the v2 clean-room rewrite and
  `IMPLEMENTATION.md` records that PR #14's puzzle canon was already re-implemented
  in `tests/classics.ts` / `tests/csp.ts` / `tests/scheduling.ts`. Obsolete;
  candidates to close.
- **#21 (Wall World), #27 (Bunker Heist), #25 (Dive), #22 (tactical positioning),
  #24 (solo combat + IAUS), #23 (combat visuals, draft)** — scenario/web-demo
  content. The spec explicitly moves demo domains to the flagship repo and
  declares this library feature-frozen; none of them touch trace/exec or contain
  a plan-event stream. Merge on their own merits later, not for this task.
- **#26 (protected goal-agenda serialization), #28 (BFWS search)** — real core
  features, but new planner/search surface (violates the freeze) and unnecessary
  for 3–5-step tactical replans, which weighted-A* already solves in ~1–5ms.

The plan-event stream exists in **no** open branch — it must be built, and it is
the *only* thing to build.

## 3. Gap: what the director cannot get today

- `plan.new` fires **before** `installPlan()` and carries only
  `{cost, steps, makespan}` — no step list, no correlation id. `plan.replaced`
  and `repair.success` carry no plan content at all.
- Step/plan failure reasons are pre-formatted **strings**
  (`"precondition of X no longer holds"`, `"scope Y violated"`, …) assembled at
  the five `failStep()` call sites — not machine-readable causes.
- "Plan invalidated because the world changed" must be inferred by correlating
  `replan.dirty` + `plan.replaced`; there is no single lifecycle event with a
  structured reason.
- Consumers get a raw callback per planner; a director over many agents must
  hand-roll aggregation/ordering (as `SquadSim.trace` does in
  `scenarios/squad-combat.ts:895`).

## 4. Work plan

### 4.1 `src/events.ts` — the plan-event stream (new file, ~150 LOC)

A thin adapter over the existing trace seam. No search/compile/state changes.

```ts
export type PlanEventReason =
  | { kind: "world-changed"; fluents: string[] }                    // invalidation trigger
  | { kind: "step-failed"; step: string; index: number;
      cause: "precondition" | "verify" | "executor" | "scope" | "drift";
      detail: string }
  | { kind: "replaced-by-better" }
  | { kind: "search-exhausted"; rejections: { at: string; reason: string }[] };

export type PlanEvent = { seq: number; at: number; agent: string; planId: number } & (
  | { t: "plan.created"; steps: { label: string; start: number; end: number }[];
      cost: number; makespan: number; via: "initial" | "improve" | "repair" }
  | { t: "step.started"; label: string; index: number }
  | { t: "step.completed"; label: string; index: number }
  | { t: "plan.completed" }
  | { t: "plan.invalidated"; reason: PlanEventReason }               // had a plan, lost it
  | { t: "plan.failed"; reason: PlanEventReason }                    // no plan could be found
);

export class PlanEventStream {
  attach(planner: Planner, agent: string): void;   // installs/wraps the trace fn
  drain(): PlanEvent[];                            // ordered, merged across agents
  onEvent?: (e: PlanEvent) => void;                // optional push mode
}
```

Semantics:
- `planId` increments per installed plan per agent; every subsequent event
  correlates to it. `seq` is a global monotonic order across agents; `at` is the
  planner clock (deterministic under injected `now`).
- All payloads are plain JSON-serializable data (the §9 contract in
  `IMPLEMENTATION.md` already promises this for trace events).
- Lifecycle correlation lives in the adapter: it holds the last `replan.dirty`
  fluer set and the last `step.fail` cause, and emits exactly one
  `plan.invalidated` with the right structured reason when the plan is dropped
  (replaced-by-better / step-failed / world-changed), and `plan.created` with
  `via: "repair"` after `repair.success`.

### 4.2 `src/exec.ts` — additive-only trace enrichment (~30 LOC)

The minimum the adapter cannot reconstruct from outside (this *is* the allowed
"one thin addition"; strictly additive, no behavior change):

1. `plan.new` / `plan.replaced` / `repair.success` gain a `plan: Plan` field
   (or fire after `installPlan()` so `getPlan()` is the new plan — carrying the
   plan in the event is simpler and keeps the adapter stateless here).
2. `step.fail` gains `cause: "precondition" | "verify" | "executor" | "scope" | "drift"`
   alongside the existing human string — derived mechanically from the five
   existing `failStep()` call sites.
3. `plan.replaced` gains `{ reason: "better" | "repair" }` → already present; keep.

Existing `TraceEvent` consumers (`SquadSim`, web demo, tests) are unaffected —
fields are added, none renamed or removed.

### 4.3 `src/index.ts` — export `PlanEventStream`, `PlanEvent`, `PlanEventReason` (~5 LOC)

### 4.4 `tests/director.ts` — the acceptance fixture (~250 LOC)

A ~6-operator demo domain mirroring the flagship verb set — **as a test fixture
only** (the real domain lives in the flagship repo):

- Operators: `GoTo(dest)`, `Breach(door)`, `TakeCover(spot)`, `Suppress(target)`,
  `Regroup(rally)`, `Idle`.
- Preconditions via `F.ext` calling a **stub layer-2/5 live-query object** the
  test mutates (e.g. `nav.reachable(a,b)`, `cover.available(spot)`).
- `GoTo`/`TakeCover` costs via `N.ext` calling a **stub kinocat oracle**
  (traversal-time lookup the test can re-weight).

Headless assertions:
1. **Plans correctly** — three canned situations produce the expected verb
   sequences (e.g. contact behind a door → `GoTo → Breach → TakeCover → Suppress`).
2. **Replans correctly** — mid-execution world writes: door seals →
   `plan.invalidated {kind: "step-failed", cause: "precondition"}` (or
   `world-changed` when caught pre-step) followed by `plan.created {via: ...}`
   routing around; oracle re-weights a path → `plan.invalidated
   {kind: "replaced-by-better"}`; target down mid-`Suppress` →
   replan to `Regroup`.
3. **Failure reasons are structured** — goal made unsatisfiable →
   `plan.failed {kind: "search-exhausted"}` with non-empty rejections;
   assert exact event-type sequences and reason payloads, not strings.
4. **Stream mechanics** — `planId` correlation, `seq` monotonicity, cross-agent
   merge with two planners on one stream, events JSON-round-trip clean.

### 4.5 Perf gate (~60 LOC)

- Test (in `tests/director.ts`): force N=100 replans of the 3–5 step demo plans
  (dirty a read fluent, tick until `plan.created`); assert **median < 10ms**
  (and report p95) with an injected clock for determinism of *behavior* and
  `performance.now()` for wall time. Generous margin vs the expected ~1–2ms so
  CI noise can't flake it.
- Add a `bench/workloads.ts` entry so the number shows up in `npm run bench`
  reporting alongside the existing suites.

### 4.6 Docs (~30 lines)

- README feature-tour row + a short "Plan events for a director" snippet.
- `IMPLEMENTATION.md`: add the §9 row for the event stream; note the
  zero-other-changes guarantee (diff touches only `events.ts`, additive
  `exec.ts` fields, `index.ts`, tests, bench, docs).

## 5. Acceptance checklist (maps 1:1 to "done when")

- [x] 6-operator demo domain plans correct sequences in headless tests
      (`tests/director.ts` + `tests/director-fixture.ts`)
- [x] Replans correctly on live-query / oracle / world changes (all three paths:
      improve-on-belief-change, repair-on-silent-nav-break, improve-on-oracle-re-weight)
- [x] `plan.created` / `step.started` / `plan.failed` / `plan.invalidated`
      arrive as structured, JSON-serializable events with machine-readable reasons
      (final reason union: `world-changed` subsumes the sketched `replaced-by-better` —
      the improve path's root cause is the announced change; the new plan's
      `via: "improve"` carries the "better" half)
- [x] Median replan latency for 3–5 step plans asserted < 10ms in CI
      (measured ~0.2–1ms; bench row `director replan (w=1)`)
- [x] Diff audit: no changes to `search.ts`, `compile.ts`, `state.ts`, `ir.ts`,
      `rng.ts`; `exec.ts` changes additive-only; all existing tests pass unmodified

## 6. Non-goals (feature freeze)

- No merging of scenario PRs (#21–#27) or search features (#26, #28) as part of
  this task; no BFWS, no goal-agenda work.
- No demo-domain scenario file under `scenarios/` — the fixture lives in tests;
  the real domain ships in the flagship repo.
- No devtools UI; events are data, the director renders them.

Estimated size: ~450–550 LOC total including tests and bench.
