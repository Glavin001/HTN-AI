# Planner performance: analysis & proposal

> Scope: the planning **core** (`src/search.ts`, `src/compile.ts`, `src/state.ts`)
> — the hot path that `Planner.tick` / `planOnce` run every frame. Methodology,
> findings, the one optimization landed in this change, and a ranked proposal for
> the rest. Reproduce everything with `npm run bench`.

## TL;DR

- The runtime was **dominated by the delete-relaxation heuristic** (`hAdd`):
  **~77% of CPU** on the heaviest workload (the quarry GOAP search), because it
  rebuilt the relaxed planning graph from scratch on every state using
  **per-atom string keys** in a `Map<string,number>`. A *single* quarry solve
  allocated **~1.04 million transient strings**.
- **Landed here:** rewrote the heuristic to run over **compile-time interned
  integer atom ids** into a **reusable numeric buffer** — zero strings, zero
  maps, zero allocation on the hot path. Same algorithm, **identical search**
  (every expansion count and the exact-optimal-plan tests are unchanged).
  **Result: 4–9.5× faster**, e.g. quarry **176 ms → 44 ms**.
- **Proposed next (evidence below):** an **applicable-action index** so each
  node expansion stops scanning *all* ground operators (now the #1 remaining
  cost at ~35%), plus **grounding-time slot specialization** and a few
  allocation cleanups. Estimated another **2–4×** on top.

## How this was measured

- `npm run bench` — wall-clock per solve **plus the engine's own counters**
  (`decompositions` / `expansions` / `heuristicEvals`). The decisive metric is
  **ms ÷ expansions = per-node cost**: a "real-time, frame-budget" planner lives
  or dies on it.
- `bench/profile.ts` under V8's `--cpu-prof`, parsed for self-time per function.
- Scalable instances (blocks-world reverse-a-tower at N=4/5/6, Hanoi at
  3/4/5 disks) to see how cost grows with the ground-operator count.

## Baseline findings

Per-solve, `main` before this change:

| Workload | ms/iter | expansions | **µs / expansion** |
|---|--:|--:|--:|
| quarry (hmax, w=1, optimal) | 176.3 | 1524 | **~116** |
| scavenger (hmax, w=1) | 14.1 | 110 | ~128 |
| hanoi 5 (w=1) | 6.72 | 185 | ~36 |
| blocks reverse 6 (w=1) | 4.14 | 7 | — |

**~116 µs per node** for a planner that advertises "plans in microseconds." A
16 ms frame budget would be blown by a single moderate problem, and a
`Scheduler` of agents far sooner.

### The smoking gun

CPU profile of the quarry search (80 iters, self-time):

| Function | Self |
|---|--:|
| `hAdd` (`search.ts`) | **49.3%** |
| `(anon)` (`search.ts`) — `hAdd`'s inner closures / `atomKey` | **19.0%** |
| `heuristic` (memo wrapper) | **8.7%** |
| garbage collector | 3.8% |
| `goalSearch` + compiled-formula closures (`compile.ts`) | ~13% |

So **~77% of all CPU was the heuristic.** Instrumenting one quarry solve:

```
groundOps: 136
hAdd calls: 1482        (one per distinct generated state; memoized by state hash)
fixpoint rounds: 4194   => avg 2.8 rounds/call   (the 64-round cap is irrelevant)
ground-op iterations inside hAdd: 570,384
atomKey string allocations: 1,039,833   ← ~1.04M throwaway strings per solve
```

Root cause (was `src/search.ts`):

- `hAdd` recomputed the full relaxed planning graph for **every** state.
- Every atom touch built a string key `` `${slot}:${value}` `` and hit a
  `Map<string,number>` — ~1M times per solve. That string churn (and its GC)
  *was* the cost; the fixpoint itself is only ~2.8 rounds.

### Why some domains barely moved

Hanoi got the **smallest** win (1.9×). Its `move` precondition uses an **opaque**
`canMoveTo` predicate, which the relaxation skips — so Hanoi's per-node cost is
**precondition evaluation**, not the heuristic. That's the tell for the
*next* bottleneck (below).

## What landed in this change

Rewrote the heuristic to be allocation-free while preserving the exact algorithm
(`src/compile.ts` + `src/search.ts`):

1. **Compile-time atom interning** (`Model.buildRelaxTables`, in
   `groundOperators()`). Every distinct `(slot,value)` atom appearing in any
   ground op's pre/add sets gets a dense integer id. Emitted once:
   - `relaxAtomSlot` / `relaxAtomValue` / `relaxAtomFuzzy` (typed arrays), and
   - per-ground-op `preIds` / `addIds` (`Int32Array`).
2. **`relaxCore`** runs h_add / h_max over those typed arrays into a **reusable
   `Float64Array` cost buffer** held by the `Engine` — no strings, no maps, no
   per-call allocation. Goal atoms are resolved to ids **once per search**, not
   per node. Novelty tie-breaking switched from a `Set<string>` to a
   `Set<number>` of interned ids.
3. The public `hAdd(model, s, goalAtoms, mode)` export keeps its signature
   (builds descriptors + a scratch buffer per call).

Semantics are intentionally identical — the fuzzy-atom optimism, the
`missing===0` early-out, and h_add-vs-h_max combination all match the original,
which is why **all 80 tests pass unchanged**, including the ones that assert
*exact optimal* plan lengths/costs under `hmax` + `weight: 1`.

### Result

| Workload | before | after | speedup |
|---|--:|--:|--:|
| quarry (hmax, w=1, optimal) | 176.3 ms | **44.1 ms** | **4.0×** |
| quarry (hadd, w=2, greedy) | 178.9 ms | **42.2 ms** | **4.2×** |
| scavenger (hmax, w=1) | 14.1 ms | **2.62 ms** | **5.4×** |
| staircase (hmax, w=1) | 0.78 ms | **0.35 ms** | 2.3× |
| blocks reverse 5 (w=1) | 1.87 ms | **0.30 ms** | 6.3× |
| blocks reverse 6 (w=1) | 4.14 ms | **0.44 ms** | **9.5×** |
| hanoi 4 / 5 (w=1) | 1.73 / 6.72 ms | **0.91 / 3.62 ms** | 1.9× |

Expansion counts are **identical** before/after (same search, faster nodes). The
uvu suite went from ~707 ms to ~255 ms.

## Proposal: the next wins (ranked)

After the heuristic fix, the quarry profile re-balanced — proving where to go
next:

| Function | Self (after) | What it is |
|---|--:|---|
| `relaxCore` (`search.ts`) | 35.2% | the heuristic — still #1, but 4× cheaper |
| **`(anon)` (`compile.ts`)** | **25.3%** | **compiled precondition closures** |
| `dyn` (`compile.ts`) | 9.3% | dynamic lit compare in pre/eff |
| `goalSearch` (`search.ts`) | 8.0% | A* loop / child creation |
| `slotOf` (`compile.ts`) | 4.8% | slot computation from bindings |
| `fn` / `fluent` (`compile.ts`) | 5.2% | more formula eval |

### 1. Applicable-action indexing — biggest remaining win (~30–40% of CPU)

**Problem.** `goalSearch` expands a node by looping over **every** ground
operator and testing its precondition (`src/search.ts`, the `for (const g of
model.groundOps)` loop). Quarry does `1524 expansions × 136 ground ops ≈ 207k`
precondition evaluations, **the vast majority of which fail** — that is the
`(anon) compile.ts` 25.3% + `dyn` 9.3%.

**Fix.** A successor generator that only yields *plausibly applicable* ops:

- Index ground ops by their precondition atoms: `consumersOf[atomId] → ops`.
  Maintain, per state, a count of satisfied precondition atoms per op
  (decrement/increment as atoms flip between parent and child) so only ops whose
  symbolic preconditions hold are even considered — the classic
  match-tree / counter-based successor generator the SPEC already calls for
  (§5.4 "indexed successor generation", §12).
- Cheaper intermediate step with most of the benefit: index by **one selective
  precondition atom per op** (e.g. `agentAt(from)` / `on(x,from)`), and skip any
  op whose selector doesn't currently hold. Ops with no indexable (all-external)
  precondition fall back to "always consider," preserving correctness — this
  also finally speeds up Hanoi.

**Expected:** removes most of the ~35% precondition cost → roughly **1.5–2×**
overall; compounding, quarry ≈ **25–30 ms**.

### 2. Grounding-time slot specialization (`slotOf` 4.8% + part of the closures)

For a **ground** op the operand slots are constant, yet the compiled
`slot(b)` closures recompute them every evaluation via nested
`indexInType.get(...).get(gid)` map lookups (`Model.slotOf`). Specialize each
ground op's pre/eff evaluators against its fixed bindings at grounding time
(precomputed slot constants), as SPEC §5.5 ("monomorphic evaluator
specialization") anticipates. Removes `slotOf` from the hot path and shrinks the
precondition-closure cost. **Expected:** ~1.1–1.2×, and it stacks with #1.

### 3. Heuristic, round two (`relaxCore` still 35%)

Two independent options, only if #1/#2 aren't enough:

- **Inverted-index worklist** for the fixpoint (Dijkstra-style relaxation over
  `consumersOf` from #1) instead of re-scanning all ops each round. With only
  ~2.8 rounds the upside is modest here but grows with operator count.
- **`h_max` reuse:** under `hmax`+`w=1` the heuristic is recomputed for states
  that differ trivially; landmark/`h_max` caching keyed on the changed atoms
  could amortize it. (Note: `hCache` is currently keyed by **state hash only**,
  ignoring which goal is being searched — fine within one search, but a latent
  correctness risk across multiple inline goals in one HTN agenda. Worth a
  goal-id in the key when this area is next touched.)

### 4. Allocation / micro cleanups (small here, real for HTN-heavy & multi-agent)

These don't show up in the GOAP-dominated quarry profile but matter for
decomposition-heavy and `Scheduler` workloads:

- **`Engine.expandTask` recomputes `model.freeBindings(method)` every
  expansion** — re-enumerates and allocates binding arrays each time. Cache per
  compiled method at compile time (free-param types are fixed).
- **`seek` builds plans with `[step, ...sub.steps]` at every recursion level** —
  O(n²) in plan length. Collect into one array (or parent pointers) and reverse
  once.
- **`Heap` swaps via array destructuring** `[a[i],a[p]] = [a[p],a[i]]`, which
  allocates a 2-element array per swap. Use a temp local.
- **`agendaSignature` builds a string per task expansion** for cycle detection;
  a structural/numeric key avoids the allocation.

### 5. Worth having regardless: regression gating

The SPEC asks for benchmark-gated CI (§12). `npm run bench` is the start; wiring
a small `tinybench` job that fails on >10% per-node regressions would lock in
these wins.

---

*Reproduce:* `npm run bench` (numbers above: Node 22, single run; absolute ms
vary by machine, ratios are stable).
