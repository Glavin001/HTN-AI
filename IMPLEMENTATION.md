# Implementation status vs. SPEC.md

**As of v2.0.0-alpha.0.** Everything listed as *implemented* is covered by the test suite (`npm test`, **107 tests across 17 files; ~96% line / ~90% branch coverage on `src/`**, gated in `npm run test:coverage`). Deferred items note where the architecture already prepares for them.

## Test inventory & evaluation methodology

| File | Layer | What it pins down |
|---|---|---|
| `tests/core.ts` | unit | IR validation diagnostics, JSON round-trip, packed-state encodings (all 7 fluent kinds), COW hashing, axioms, durations/costs, clock slot |
| `tests/unit.ts` | unit | seeded RNG, deep COW chains/collapse/materialize, formula/numeric printers, JSON error paths, type hierarchy (subtype grounding), T2 numeric/effect externals + opaque predicates, vec3/setVec, `T.hold`, encoding edge cases |
| `tests/htn.ts` | behavioral | FluidHTN-lineage semantics kept by choice: method priority order, MTR replan-only-if-better, planOnly vs planAndExecute timing, utility selection, free-variable binding with backtracking, executing-condition aborts |
| `tests/edges.ts` | engine edges | node-budget/depth-cap/relaxation-unreachable failures, decomposition cycle detection, failed/idle/satisfied planner statuses, async (Promise) executors incl. rejection recovery, drift detection, validatePlan over scopes/waits, scheduler edge cases |
| `tests/exec.ts` | integration | suffix repair from the failure point, fluent-precise reactivity (irrelevant vs relevant changes), budget-sliced resumable sessions, byte-identical determinism, 25-agent scheduler |
| `tests/temporal.ts` | integration | the four target scenarios: deadline route-flip in search, time windows + waits, maintain≥15s with cleanup-on-abort, escort abort/recover |
| `tests/puzzles.ts` | ground truth | water jug (6), blocks world (3), river crossing (7, safety via maintain-in-search), sokoban corridor (exact plan), Tower of Hanoi (7, T2 movability), Bridge & Torch (cost-optimal 15) |
| `tests/ipc.ts` | research canon | IPC staples hand-encoded with known optima: **Gripper** (11, h_max-admissible mode), **Logistics** (6, type hierarchy + entity-valued NumExpr effects), **Satellite** (5, HTN method with search-bound calibration target), **Transport** (HTN-IPC TO domain, achieve+operator methods, 6) |
| `tests/scenario.ts` | scenario ports | v1 intents: bunker raid chains, dynamic-cost vehicle choice; fps-lite utility switching; nested scopes (deadline ⊃ maintain) planned + executed |
| `tests/classics.ts` | search scenarios | remaining PR #14 puzzles as real planning: **word ladder** (dictionary graph search, 3 steps), **crafting** (numeric resource production, optimal 7), **treasure hunt** (clue-gated navigation) |
| `tests/csp.ts` | constraint search | PR #14 constraint puzzles as backtracking search with first-unfilled ordering + forward checks: **sudoku 4×4** (verified valid completion), **logic grid** (unique seating from relational clues), **crossword** (intersecting slots with letter agreement) |
| `tests/scheduling.ts` | temporal scenario | PR #14 **scheduling**: sequence jobs on one machine meeting per-job deadlines + precedence, with projected-clock pruning of infeasible orderings (and an infeasibility proof) |
| `tests/director.ts` | acceptance | the "discrete executive" spec: a ~6-operator tactical demo domain (GoTo/Breach/TakeCover/Suppress/Regroup/Idle, in `scenarios/director.ts`; live demos: `npm run demo:director` and the web preview's `/director` page) with live-query external preconditions and an external cost oracle — correct plans, improve/repair replans, every `PlanEventStream` failure cause as structured data, multi-agent stream merge, and a <10ms replan perf gate |

**On the PR #14 puzzle canon:** all 15 titles were reviewed; the ones that are genuine action-planning or constraint problems are now solved *by the planner* (blocks world, sokoban, river crossing, Tower of Hanoi, water jug, bridge & torch in `puzzles.ts`; word ladder, crafting, treasure hunt in `classics.ts`; sudoku, logic grid, crossword in `csp.ts`; scheduling in `scheduling.ts`). Two are deliberately omitted because they are not planning problems the engine should solve: **bridge-math** (an arithmetic word problem, no action structure) and **full scrambled Rubik's cube** (search-infeasible without pattern-database heuristics — a 2–3 move scramble is blind-solvable but would add large, brittle sticker-permutation encoding for coverage that sudoku already provides).

**How the field evaluates (and how we map to it):** the IPC scores *coverage* (problems solved within a time limit), *plan quality* (cost ratio vs best known; optimal track requires proofs), and *agility* (time-to-first-plan); papers additionally report node expansions. Until the M4 harness imports real HDDL/PDDL suites and runs reference planners (pandaPIengine, Fast Downward, pyperplan), this suite pins the same properties at small scale: exact known optima (quality/optimality, using `heuristic: "hmax"` + `weight: 1` where admissibility is required), `PlanResult.stats` (expansions/decompositions/heuristic evals), budget-slicing tests (agility), and determinism hashes.

## Implemented (spec section → code)

| Spec | Status | Where |
|---|---|---|
| §4.1–4.2 types, entities, typed fluents (boolean/enum/int/float/entity/vec2/vec3) | ✅ | `src/ir.ts`, `src/compile.ts` (interning, dense tables) |
| §4.3 formulas (and/or/not/lit/cmp, arithmetic incl. min/max/dist/clock) | ✅ | `src/ir.ts`, `src/compile.ts` (compiled closures) |
| §4.4 effects (set/setVec/inc/dec, external) with planOnly / planAndExecute / permanent timing | ✅ | `src/compile.ts` (timing masks) |
| §4.5 axioms (derived predicates, cycle-checked, write-protected) | ✅ | `src/ir.ts` validation, `src/compile.ts` |
| §4.6 lifted operators (params, pre, verify, cost, duration, executor binding) | ✅ | `src/compile.ts` |
| §4.7 TO methods (free params bound by search, utility ordering, implicit compounds) | ✅ | `src/compile.ts`, `src/search.ts` |
| §4.8 goals as agenda items (task + state goals unified, GTPyhop-style) | ✅ | `src/search.ts` (`AgendaItem`) |
| §4.9 three tiers: T1 symbolic / T2 declared-reads externals / T3 opaque | ✅ | `F.ext`/`N.ext` (reads), `F.opaque`, registry |
| §4.11 canonical IR + lossless JSON serialization | ✅ | `domainToJSON` / `domainFromJSON` |
| §4.13 temporal-lite: durations, projected clock, deadline/window pruning **in search**, waitUntil/hold, minHold, timeline drift detection | ✅ | `src/search.ts`, `src/exec.ts`, `tests/temporal.ts` |
| §5 compile pipeline: validate (structured diagnostics) → intern → layout → evaluators → eager grounding → relaxation atoms | ✅ | `src/compile.ts` |
| §6 packed state (one Float64 slot space), COW StateViews, incremental hashing, fluent-level dirty tracking, planned-write suppression | ✅ | `src/state.ts` |
| §7 search: agenda engine, cycle detection on decomposition, binary-heap weighted A*, h_add, novelty tie-break, deterministic ordering, budgeted resumable generator sessions (ms or nodes) | ✅ | `src/search.ts` |
| §7.5/§8 determinism: seeded RNG, injectable clock, byte-identical traces | ✅ | `src/rng.ts`, `tests/exec.ts` |
| §8 execution: MTR replan-only-if-better, fluent-precise + method-reads replan triggers, executing conditions (`verify`), scopes (deadline/maintain/minHold/onExit incl. cleanup-on-abort), suffix **repair from the failure point** with full-replan fallback, async (Promise) executors, multi-agent `Scheduler` | ✅ | `src/exec.ts` |
| §9 trace events; `validatePlan` / `simulatePlan` / `applicableActions` / `explainFailure` / `planSummary` | ✅ | `src/exec.ts`, `src/trace.ts` |
| §9 structured plan-event stream (`PlanEventStream`): plan created / step started / plan invalidated / plan failed with machine-readable reasons (`world-changed` fluents, `step-failed` cause, `search-exhausted` rejections), agent + plan-id + seq stamping, multi-planner merge | ✅ | `src/events.ts` (adapter over the trace seam; `exec.ts` trace events additively carry `TracePlanInfo` + `StepFailCause`) |
| §11 ground-truth correctness suite (water jug 6 steps, blocks world 3 moves, river crossing 7, sokoban 3) + scenario ports (bunker-lite, dynamic-cost vehicle) | ✅ | `tests/` |

## Deferred (architecture prepared)

| Spec | Plan | Preparation in current code |
|---|---|---|
| §4.12 HDDL/PDDL import/export (M1/M2 in spec) | next milestone | importers only need to emit `DomainDoc` IR; fragments documented in spec |
| §5.3 lazy grounding for `dynamic`/large universes | M2 | grounding isolated in `Model.enumerateBindings` + `groundOperators` with an explosion guard; swap point is one function |
| §5.4 deeper analysis: mutex/invariant synthesis, relevance pruning, compound look-ahead (PandaDealer), TDG/landmark heuristics | M3 | `GroundOp.preAtoms/addAtoms` already extracted; heuristics are pluggable via `Engine.heuristic` |
| §7.3 anytime improvement loop (ARA*-style ε schedule) + numeric interval relaxation | M3 | sessions are already generators; `weight` is per-request; h slot isolated |
| §8 multiple intention lanes (true parallel execution) | M4 | scopes/agenda design keeps per-lane state in instances, not tasks |
| §9 devtools inspector UI | M5 | versioned `TraceEvent` union is the contract; events are plain serializable data |
| §10 `@htn-ai/llm` (method-miss hook, incremental authoring loop, NL rendering) | M6 | `validateDomain` returns per-element structured diagnostics; `agendaOverride` shows the pause-and-extend pattern; `OperatorDecl.meta` reserved for provenance |
| §11.2 reference-planner CI (PANDA/Fast Downward/pyperplan/ENHSP) | M4 | plan format is introspectable; ground-truth asserts stand in meanwhile |
| §12 perf hardening: node pooling, monomorphic evaluator specialization, hCache eviction, benchmark suite | M3/M4 | hot paths concentrated in `StateView`, `Heap`, `hAdd`; `stats` already reported per session |
| Worker adapter / packages split (§13) | M4 | core is zero-dependency and isomorphic; domains/states are structured-clone-safe |

## Heuristic notes

- Default goal-search heuristic is **h_add** (`heuristic: "hadd"`): informative and fast, but can overestimate (inadmissible) — fine for the default greedy weight (1.4).
- For guaranteed-optimal plans use `heuristic: "hmax"` (admissible) or `"none"` (Dijkstra) with `weight: 1` — the Gripper test demonstrates the difference (h_add yields 13 steps, h_max the optimal 11).
- Effects that assign from runtime expressions (NumExpr sets, inc/dec, setVec, externals) are tracked as **fuzzy writes**: the relaxation treats their fluents as optimistically settable instead of unreachable (the Logistics `unload: pkgAt := vehAt(v)` pattern).

## Known divergences from FluidHTN (deliberate, per SPEC §13)

- `permanent` effects no longer leak into the live world during planning; they behave like `planAndExecute` at execution (speculative rollout is always isolated).
- Partial-plan pausing (`PausePlanTask`) is subsumed by budgeted resumable sessions.
- Slots (runtime domain splicing) are not yet reimplemented; runtime method registration (M6) is the planned replacement.
- MTR indices are positions in the *candidate ordering* (after utility sort), not raw declaration indices.
