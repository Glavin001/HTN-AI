# Planner performance: analysis & optimization log

> Scope: the planning **core** (`src/search.ts`, `src/compile.ts`, `src/state.ts`)
> — the hot path `Planner.tick` / `planOnce` run every frame. Methodology, the
> findings, the optimizations landed, and what's left. Reproduce with `npm run bench`.

## TL;DR

The planner was **~10–80× slower than it needed to be**, dominated by the
delete-relaxation heuristic, by re-doing per-node work the compiler could do
once, and by grounding/searching operators that can never apply. A stack of
semantics-preserving optimizations (all tests pass unchanged, **expansion counts
identical**) brought:

| Workload | baseline | now | speedup |
|---|--:|--:|--:|
| quarry (hmax, w=1, optimal GOAP) | 176.3 ms | **~11 ms** | **~16×** |
| scavenger (hmax, w=1) | 14.1 ms | **1.34 ms** | 10.5× |
| blocks reverse-6 (w=1) | 4.14 ms | **0.24 ms** | **17×** |
| hanoi-5 (w=1) | 6.72 ms | **2.4 ms** | 2.8× |
| nav grid K=12 (relational) | 168.9 ms | **4.4 ms** | **38×** |
| Scavenger XL (4×3, pushed) | 448 ms | **22 ms** | **20×** |
| Scavenger HUGE (6×4, pushed) | 6150 ms | **78 ms** | **79×** |

**Per-node cost on quarry: 116 µs → ~8 µs.** The uvu suite went 707 ms → ~150 ms
(now 84 tests incl. Scavenger XL). The biggest single wins: the allocation-free
interned heuristic (≈4–9×), and **static-fluent pruning** (nav 38×, HUGE another
4×). (Node 22, single machine; ratios stable, absolute ms vary ±10%.)

### Optimizations landed (each preserves the search exactly)

1. Allocation-free relaxation heuristic via compile-time interned atom ids
2. Indexed successor generation (most-selective precondition atom)
3. Adaptive copy-on-write state collapse (≈ slotCount/32)
4. Flat-buffer heuristic reads (`materializeInto`)
5. Grounding-time slot specialization (no per-eval lookups/allocs)
6. Reusable `ExtQuery` for external/opaque predicate evaluation
7. Arg-only external folding (empty read set ⇒ prune at grounding)
8. Symbolic relaxation hints (`relax` over-approximations)
9. **Static-fluent pruning** (`static: true` ⇒ drop dead groundings)
10. Pure-atom precondition skip; heap/`freeBindings`/sort allocation cleanups

## How this was measured

- `npm run bench` — robust stats: warm up, auto-calibrate the inner loop, run
  several trials and report the **min** ms/iter (least contaminated by
  GC/scheduler/CPU-freq noise), plus median and **spread%** so the noise is
  visible, and **µs/node = min ÷ expansions** (size-normalized cost — what a
  frame budget cares about). `--expose-gc` collects between trials for less
  noise. *(Earlier single-batch means undersold the noise; medians ran ~40%
  above the min on the heavier GOAP solves.)*
- `npm run bench:scale` — sweeps each workload along one axis (hanoi disks,
  blocks count, nav-grid size, HTN width, agent count, search weight) so
  super-linear scaling is visible (`×prev` growth factor per step).
- `bench/profile.ts` under V8 `--cpu-prof`, parsed for self-time per function.

### Scaling findings (`bench:scale`)

| Axis | What scales | Observed |
|---|---|---|
| Hanoi disks 3→8 | exponential search | expansions ×~4/disk, **µs/node ~flat (7→15)** ✓ |
| Blocks 4→12 | grounding O(n³) | search trivial, but **µs/node 10→239** — heuristic sweeps all ground ops |
| **Nav grid K 4→12** | relational adjacency | **µs/node 18→7342 (~O(K⁴))** — successor generation can't index `adj(from,to)`; gathers all `K²` moves/node |
| HTN tour 8→128 | decomposition width | ~linear ✓ |
| Scheduler 1→32 | multi-agent | ~linear ✓ |

Two clear next targets fall out: a **join/match-tree successor generator** for
relational preconditions (nav is O(K⁴) today), and **relevance-pruning the
heuristic** so it doesn't sweep every ground op when grounding is large (blocks).

### Validation on the larger pushed examples (`bench/huge.ts`)

Same-machine before/after on the bigger Scavenger instances (the baseline is the
pre-optimization engine on its own branch; planning only, model built once;
**identical expansion counts** ⇒ identical search, just faster nodes):

| Instance | baseline | optimized | speedup | expansions |
|---|--:|--:|--:|--:|
| Scavenger XL (4×3, h3, hadd w=5) | 448 ms | **35 ms** | **12.8×** | 1608 |
| Scavenger HUGE (6×4, h3, hadd w=6) | 6150 ms | **305 ms** | **20.2×** | 1716 |

The speedup is *larger* on the bigger grid — exactly the prediction: more cells ⇒
more ground ops ⇒ the per-node heuristic cost (what these optimizations cut
hardest) dominates more. The `scavengerGrid(W,D)` sweep shows that per-node cost
still grows with grounding even after the wins, motivating the static-pruning /
relevance work:

| W×D | cells | min ms | µs/node |
|---|--:|--:|--:|
| 4×3 | 12 | 65 | 43 |
| 5×3 | 15 | 113 | 61 |
| 6×3 | 18 | 181 | 105 |
| 6×4 | 24 | 319 | 186 |

## Baseline: where the time went

Baseline per-node cost was **~116 µs** on quarry — for a planner that advertises
"plans in microseconds," a single moderate problem already blew a 16 ms frame.

CPU profile (quarry), and instrumenting one solve:

| Function | Self | | one quarry solve |
|---|--:|---|--:|
| `hAdd` | 49.3% | | 1482 `hAdd` calls, ~2.8 fixpoint rounds each |
| `(anon)` (hAdd inner closures) | 19.0% | | 570k ground-op iterations in the heuristic |
| `heuristic` (memo wrapper) | 8.7% | | **1,039,833 `${slot}:${value}` strings allocated** |
| garbage collector | 3.8% | | |

**~77% of CPU was the heuristic**, which rebuilt the relaxed planning graph from
scratch on every state using per-atom **string keys** in a `Map<string,number>`
— over a million throwaway strings per solve. The fixpoint itself was cheap
(~2.8 rounds); the **allocation and map churn** was the cost.

## What was landed (7 optimizations, 3 commits)

Every change preserves the search exactly (same plans, same expansion counts) —
the exact-optimal-plan tests under `hmax`+`weight:1` are the regression net.

1. **Allocation-free heuristic via interned atoms** *(the big one — targeted the
   ~77%)*. Intern every distinct `(slot,value)` atom over the ground operators to
   a dense integer id at compile time (`Model.buildRelaxTables`); emit typed-array
   tables + per-ground-op `preIds`/`addIds`. `relaxCore` runs h_add/h_max over
   those into a **reusable `Float64Array`** — no strings, no maps, no per-call
   allocation. Goal atoms resolved to ids once per search; novelty switched to a
   `Set<number>`. → **4–9.5×**.

2. **Indexed successor generation**. Goal search was scanning **all** ground ops
   per node and testing each precondition (1524 × 136 ≈ 207k evals, mostly
   failing). Index each op by its **most-selective precondition atom**
   (`buildSuccessorIndex`); a node only considers ops whose selector currently
   holds. Candidates are processed in gid order, so the search is byte-identical
   to the full scan. A cheap atom-level fast-reject precedes the full precondition
   closure.

3. **Adaptive copy-on-write collapse** (`state.ts`). `get()` walks the delta
   chain via Map lookups (tens of ns); `materialize()` is a flat typed-array copy
   (~0.5 ns/elem). The fixed depth-24 chain over-walked small states. Collapse at
   **≈ slotCount/32** (clamped [2,32]) — near-O(1) reads for the common
   small-state case, deeper chains only where copying would dominate. (Quarry:
   30 ms → 19 ms.)

4. **Flat-buffer heuristic reads** (`materializeInto`). The relaxation **seed**
   read every atom through `StateView.get` (≈300k chain-walks/solve) — the real
   cost inside `relaxCore`. Materialize the state into a **reused flat buffer**
   once per eval; all seed/goal reads become O(1).

5. **Slot specialization** (`slotFn`). The variable-arg slot closure did a
   fluent-name lookup + per-type map lookup **and allocated two arrays** (a
   `getArgs` result and the spread/rest) on every precondition/effect/cost eval.
   Capture the fluent layout + per-param index maps at compile time; resolve the
   slot inline with zero allocation.

6. **Allocation cleanups**: cache `freeBindings` per compiled method (was
   re-enumerated every task expansion — helps HTN); swap heap nodes with a temp
   instead of array destructuring (no 2-elem array per sift); skip the
   candidate sort when a domain's candidates can only come from one
   gid-ordered bucket.

7. **Reusable `ExtQuery`** (`compile.ts`). External/opaque predicate & numeric
   evaluation allocated a fresh 5-closure object per call, and its `get()` did a
   `.map()` + spread/rest into `slotOf` — pure overhead around the user's
   predicate, and the dominant cost for predicate-bound domains. A single
   re-pointed `ExtQuery`/`ExtWriter` bound to mutable model state (external eval
   is a synchronous leaf call) + an allocation-free `slotOfArgs`. → **Hanoi-5
   3.43 → 2.42 ms (29%)**.

8. **Benchmark harness** (`bench/`, `npm run bench`) covering GOAP, scalable
   blocks/Hanoi, HTN decomposition, and the multi-agent Scheduler.

### Profile, after

`relaxCore` is back on top but ~7× cheaper than the old `hAdd`; the heuristic
seed is O(1), precondition scanning is gone, and string/GC churn is eliminated:

| Function | Self (after) |
|---|--:|
| `relaxCore` (heuristic fixpoint) | ~43% |
| `goalSearch` (A* expansion machinery) | ~18% |
| compiled precondition closures (`(anon)`/`fn`/`dyn`/`fluent`) | ~16% |
| `materialize` / `slotOf` / GC | ~12% |

## What was tried and reverted

- **Worklist (Dijkstra-style) relaxation** — re-enqueue only the ops that read a
  decreased atom. *Slower here* (29 → 31 ms): these relaxation graphs are small
  and dense (one shared atom like `agentAt` gates almost every op), so a single
  decrease re-enqueues nearly everything and the bookkeeping costs more than the
  ~2.8-round dense sweep. Kept the round-based fixpoint; noted in code. (Expected
  to win once domains get large and sparse — IPC-scale.)

## Where the time goes now, by scenario class

Profiling sorts the scenarios into three regimes, each with a different next move:

| Regime | Examples | Dominant cost (now) |
|---|---|---|
| Heuristic-bound GOAP | quarry, scavenger, staircase | `relaxCore` + `materialize` ≈ **57%** |
| Predicate-bound GOAP | hanoi, csp | external/opaque eval (`fn`/`canMoveTo`/`slotOf`) |
| Decomposition-bound HTN | tour, htn, scheduler | `seek`, `freeBindings`, agenda/cycle keys |

## Remaining opportunities (ranked)

### Landed since: static-fluent pruning

Fluents declared `static: true` (immutable after init — adjacency, maps,
alignment) have their precondition lits treated as compile-time constants, so
ground operators whose static precondition can never hold are **dropped at
grounding** — out of both search and the relaxation. Sound (a static-false lit is
unreachable in the relaxation too, so h is unchanged) and validated (writing a
static fluent is a compile error). Static must be *declared*, not inferred: a
fluent no operator writes can still be set by the host (e.g. `has_vehicle`), and
grounding is shared across plans.

| | before | after |
|---|--:|--:|
| nav grid 10×10 — ground move ops | 10 000 | **360** |
| nav grid K=12 — solve | 168.9 ms | **4.4 ms** (38×) |
| Scavenger HUGE — solve | 305 ms | **81 ms** (now **76× vs the original baseline**) |
| quarry (adj+buildable static) | 14.0 ms | **10.9 ms** (~16× vs baseline) |

This **captures most of the relational successor-generation win** for static
relations (adjacency/maps/alignment) — the nav O(K⁴) wall is gone. A full
join/match-tree successor generator remains relevant only for **dynamic**
relational preconditions (two changing relations joined per node), which no
current benchmark exercises; it's demoted to "build when a domain needs it."

### Landed since: symbolic relaxation hints

External/opaque predicates were invisible to the heuristic. A predicate can now
carry a `relax` over-approximation — a T1 necessary condition the relaxation
folds in (feeds the heuristic only; search applicability is untouched, so a hint
can't make search incorrect, and a *sound* hint keeps `hmax` admissible). On an
opaque-gated benchmark this cut expansions **14376 → 23 at K=6** (and Hanoi-class
predicate domains can hint `canMoveTo`). See `tests/hints.ts`, GUIDE §22.

### A. Help most scenarios more

1. **Incremental / landmark heuristic** — the real ceiling for the *slowest*
   (spatial) domains, where `relaxCore` is ~50%. It is now allocation-free over a
   flat buffer, so the only way down is algorithmic: reuse the parent's relaxed
   graph across parent→child (incremental h_add), or a landmark-count heuristic.
   Both **change h values**, so they must be validated against the exact-optimal
   (`hmax`+`w=1`) tests — highest upside, highest care. *(A worklist variant was
   tried and reverted — see above — because the graphs are small and dense.)*
2. **Pure-atom precondition skip** — when an op's precondition is *exactly* a
   conjunction of positive lits, the existing atom fast-reject already proves
   applicability, so the full precondition closure can be skipped. Broad for
   plain STRIPS (blocks/sokoban/HTN ops); nil for spatial domains whose
   preconditions carry comparisons.
3. **Cut child allocation in `goalSearch`** (~17%). Each candidate allocates a
   `StateView`+delta `Map` and applies effects *before* the closed/heuristic
   prune may discard it (~10k discarded children/solve on quarry). Compute the
   child hash incrementally from the effect writes and run the `closed` check
   *before* committing the child; pool the discarded `StateView`s.
4. **`seek` plan assembly is O(n²)** (`[step, ...sub.steps]` per level) — matters
   for deep HTN; collect once and reverse. **`freeBindings`** is cached but the
   candidate `[...args, ...free]` arrays and `agendaSignature` cycle keys still
   allocate per task expansion.

### B. Opaque / external predicates specifically

External (T2, *declared* reads) and opaque (T3, *no* declared reads) predicates
share the `ExtQuery` machinery; the reusable query (landed) helps both. Further:

1. **Fold & prune arg-only externals at grounding.** A T2 external with an
   **empty read set** (e.g. `neq`) is a pure function of its arguments → constant
   per ground op. Evaluate it once at grounding and **drop the ground ops where
   it's false** (Hanoi: 27 → 18 `move` ops; blocks: all `x==to` ops) — they never
   enter search or the successor index. Safe because the relaxation already
   ignores externals, so dropping no-op/invalid groundings leaves h unchanged.
2. **Memoize state-dependent T2 externals.** Because a T2 external's result is a
   pure function of its *declared* read fluents + args, it can be cached keyed by
   (predicate, args, read-fluent values) and invalidated by the existing dirty
   tracking. Worth it for expensive predicates (`canMoveTo` scans all disks).
   **Opaque (T3) cannot be memoized** — it declares nothing and may read the
   outside world — but it still gets the reusable-query win, and should be
   **ordered last** within a conjunction so cheaper symbolic lits reject first.
3. **Precompiled fluent handles in `ExtQuery.get`.** User predicates call
   `q.get("peg", d)`, re-resolving the fluent name every call. A
   `q.handle("peg")` returning a closure that reads a fixed layout would remove
   the per-call name lookup from hot predicates.

### C. Lock it in

**Regression-gated CI** (SPEC §12): wire `npm run bench` into a `tinybench` job
that fails on >10% per-node regressions.

---

*Reproduce:* `npm run bench`. Per-node cost (`ms ÷ expansions`) is the number to
watch.
