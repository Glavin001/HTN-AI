# Implementation status vs. SPEC.md

**As of v2.0.0-alpha.0.** Everything listed as *implemented* is covered by the test suite (`npm test`, 34 tests). Deferred items note where the architecture already prepares for them.

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

## Known divergences from FluidHTN (deliberate, per SPEC §13)

- `permanent` effects no longer leak into the live world during planning; they behave like `planAndExecute` at execution (speculative rollout is always isolated).
- Partial-plan pausing (`PausePlanTask`) is subsumed by budgeted resumable sessions.
- Slots (runtime domain splicing) are not yet reimplemented; runtime method registration (M6) is the planned replacement.
- MTR indices are positions in the *candidate ordering* (after utility sort), not raw declaration indices.
