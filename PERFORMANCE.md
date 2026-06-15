# Planner performance: analysis & optimization log

> Scope: the planning **core** (`src/search.ts`, `src/compile.ts`, `src/state.ts`)
> — the hot path `Planner.tick` / `planOnce` run every frame. Methodology, the
> findings, the optimizations landed, and what's left. Reproduce with `npm run bench`.

## TL;DR

The planner was **~10–20× slower than it needed to be**, dominated by the
delete-relaxation heuristic and by re-doing per-node work the compiler could
do once. A stack of semantics-preserving optimizations (all **80 tests pass
unchanged**, expansion counts identical) brought:

| Workload | baseline | now | speedup |
|---|--:|--:|--:|
| quarry (hmax, w=1, optimal GOAP) | 176.3 ms | **14.1 ms** | **12.5×** |
| quarry (hadd, w=2, greedy) | 178.9 ms | **13.2 ms** | 13.6× |
| scavenger (hmax, w=1) | 14.1 ms | **1.55 ms** | 9.1× |
| staircase (hmax, w=1) | 0.78 ms | **0.21 ms** | 3.7× |
| blocks reverse-6 (w=1) | 4.14 ms | **0.20 ms** | **20.3×** |
| blocks reverse-5 (w=1) | 1.87 ms | **0.18 ms** | 10.2× |
| hanoi-5 (w=1) | 6.72 ms | **2.42 ms** | 2.8× |

**Per-node cost on quarry: 116 µs → 9.2 µs (12.6×).** The uvu suite went
707 ms → ~145 ms. (Node 22, single machine; ratios are stable, absolute ms vary.)

## How this was measured

- `npm run bench` — wall-clock per solve **plus engine counters** (`decompositions`
  / `expansions` / `heuristicEvals`). The decisive metric is **ms ÷ expansions =
  per-node cost**: a "real-time, frame-budget" planner lives or dies on it.
- `bench/profile.ts` under V8 `--cpu-prof`, parsed for self-time per function.
- Scalable instances (blocks reverse-a-tower N=4/5/6, Hanoi 3/4/5) to watch cost
  grow with the ground-operator count, and HTN-decomposition + multi-agent
  `Scheduler` workloads so the non-GOAP paths are covered too.

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
