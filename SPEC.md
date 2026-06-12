# HTN-AI v2 — Software Specification

**Draft 1 · for review and alignment — do not implement until §17 decisions are signed off.**

> Companion to [`ROADMAP.md`](./ROADMAP.md), which carries the evidence base (verified market/algorithm research) and phased strategy. This document specifies *what we build*: the representation, compilation pipeline, search core, execution runtime, observability contract, LLM surface, and the evaluation harness that proves we match or surpass best-in-class planners within our goals.

---

## 1. Goals & non-goals

### 1.1 Product goals

- **G1 — Online planner.** Interruptible, budgeted, anytime planning and execution suitable for 60fps game loops and tick-driven agent sims. First valid plan fast; quality improves while budget remains; never blocks a frame.
- **G2 — LLM-optional companion.** An LLM (or human) sets goals, constraints, and authors/extends domains; the planner provides the low-latency, low-cost, deterministic, auditable action layer underneath. The core never calls a model provider.
- **G3 — Rich, realistic representation.** Boolean, enum, numeric, entity-valued, and spatial (position) state; lifted (parameterized) operators with lazy grounding; hierarchy (HTN methods) and goals (GOAP-style) in one engine; semi-symbolic escape hatches for native computations (navmesh distance, line-of-sight) that still declare what they read/write.
- **G4 — Every optimization the representation enables, in one system.** Packed state, indexed successor generation, model-derived heuristics (delete-relaxation, landmarks, TDG), invariant/mutex analysis, look-ahead pruning, novelty tie-breaking, cycle detection, plan repair, memoization. Each action gets whatever optimizations its declaration tier permits.
- **G5 — Standards-aligned interchange & head-to-head evals.** A canonical JSON format that round-trips with HDDL (TO fragment) and PDDL (STRIPS+typing+costs+numeric fragment), so IPC benchmark suites run on our planner and our domains validate against reference planners (PANDA, Fast Downward, ENHSP) and validators (pandaPIparser, VAL). We publish the comparison.
- **G6 — Reusable TypeScript web library.** Zero-dependency core, isomorphic (browser/Node/workers/edge), tree-shakeable, deterministic, serializable.

### 1.2 Non-goals (v2)

- Partial-order method execution semantics (we import PO-HDDL only via documented linearization or rejection; see D6).
- Temporal/durative planning (PDDL 2.1 durative actions, HDDL 2.1). Deadlines/`maintain` are *execution-layer* features, not temporal search.
- Probabilistic/FOND planning — nondeterminism is handled by repair/replan at execution.
- Optimal-track guarantees under real-time budgets — we provide anytime convergence with reported suboptimality bounds instead.
- Visual *editor* (authoring GUI). The inspector (read/debug) is in scope via the trace contract; editing UI is later.
- Built-in pathfinding — we integrate with navmesh/grid libraries as cost/feasibility *providers*.

---

## 2. Primary use cases

1. **Game NPC / squad AI (browser or Node server):** 50–500 agents, shared immutable domains, per-agent contexts, staggered replans at 1–10Hz, ≤1–2ms planning budget per frame total, deterministic for lockstep/replays.
2. **Agent simulations (AI-Town-class):** long-horizon daily behavior compiled from goals; async LLM cognition feeding goals/constraints; coherent execution between LLM decisions; explainable traces.
3. **LLM tool/workflow agents:** the planner as verifier + sequencer under LangGraph/Vercel-AI-style orchestrators — `validatePlan`, `applicableActions`, `simulate`, plan → step-DAG export; durable execution via Temporal/Inngest adapters.
4. **Research/benchmarking:** IPC HDDL domains imported and run; results compared against reference planners in CI.

---

## 3. System overview

```
            ┌─────────────────────────────────────────────────────────────┐
            │                      @htn-ai/devtools                       │
            │        inspector UI · trace viewer · time-travel            │
            └────────────────────────────△────────────────────────────────┘
                                         │ trace events (versioned schema)
┌───────────────┐   ┌────────────────────┴────────────────────────────────┐
│ @htn-ai/hddl  │   │                    htn-ai (core)                    │
│ @htn-ai/pddl  │──▷│  ┌──────────────┐  ┌────────────┐  ┌─────────────┐  │
│ import/export │   │  │ Representation│─▷│ Compilation│─▷│ Search core │  │
└───────────────┘   │  │  (IR, §4)    │  │  (§5)      │  │  (§7)       │  │
┌───────────────┐   │  └──────────────┘  └────────────┘  └──────┬──────┘  │
│ @htn-ai/llm   │──▷│  ┌──────────────┐  ┌────────────┐         │         │
│ authoring,    │   │  │ State runtime │◁─│ Execution  │◁────────┘         │
│ method-miss   │   │  │  (§6)        │  │ layer (§8) │ plans/repairs     │
└───────────────┘   │  └──────────────┘  └────────────┘                   │
┌───────────────┐   └─────────────────────────────────────────────────────┘
│ @htn-ai/eval  │──▷ benchmark harness, reference-planner drivers (§11)
└───────────────┘
 adapters: @htn-ai/react · /xstate · /phaser · /excalibur · /langgraph · /worker
```

Package layout (D2): monorepo; `htn-ai` core has **zero runtime dependencies** (current `loglevel` dependency is removed in favor of the trace bus).

---

## 4. Representation layer (IR)

The IR is the load-bearing decision: it is simultaneously the optimization substrate (what the compiler/heuristics can see) and the LLM substrate (what models can author, validate, diff, and repair).

### 4.1 Entities & types

- A domain declares a **type hierarchy** (`unit ⊑ actor ⊑ object`) and problems declare typed **entities** (objects). Entities are interned to integer ids at compile time.
- Entity universes may be declared `dynamic` (entities added/removed at runtime → affects grounding strategy, §5.3).

### 4.2 Fluents

A **fluent** is a typed, optionally parameterized state variable. Kinds:

| Kind | Example | Packed storage |
|---|---|---|
| `boolean` | `holding(actor, item)` | bitset |
| `enum` (multi-valued, SAS+-style) | `stance(unit): {stand,crouch,prone}` | Uint8/16 array |
| `int` / `float` | `ammo(unit): int`, `health(unit): float` | Int32/Float64 array |
| `entity` | `target(unit): unit \| null` | Int32 array (entity id) |
| `vec2` / `vec3` (positions) | `pos(player): vec2` | interleaved Float64 array |
| `external` (semi-symbolic read) | `navDistance(a, b): float` | not stored — computed via provider, declared reads |

Notes:
- Parameterized fluents ground to dense tables indexed by entity ids (row-major). This is the SAS+/Fast-Downward lesson: multi-valued variables, not seas of booleans.
- `vec2/vec3` get built-in comparison sugar (`dist(pos(a), pos(b)) ≤ r`) which compiles to a semi-symbolic expression with declared reads `{pos(a), pos(b)}`.
- v1 compatibility: the current string-keyed `WorldState` maps to an auto-declared bag of `boolean|int|unknown` fluents (tier-3, §4.9).

### 4.3 Formulas (precondition / goal / axiom-body language)

Optimizer-friendly core, deliberately small:

```
F ::= lit | comp | and(F…) | not(lit|comp) | exists(v:T, F)   // exists: bounded, compile-expanded
lit ::= fluent(args…) [= value]           // boolean/enum/entity equality
comp ::= numexpr (= | ≠ | < | ≤ | > | ≥) numexpr
numexpr ::= fluent(args…) | const | numexpr (+ - * /) numexpr | dist(vecexpr, vecexpr) | extfn(args…)
```

- **No disjunction in the core** (D7): `or` is accepted by the authoring layer and compiled away (method/operator duplication), keeping the search/heuristic core conjunctive.
- `exists` is expanded over the (typed) entity universe at grounding; rejected over `dynamic` universes unless bounded by a provider.

### 4.4 Effects

```
E ::= set(fluent(args…), valueexpr)          // assign (boolean/enum/entity/vec)
    | increase/decrease(fluent, numexpr)     // numeric
    | forEach(v:T where F, E…)               // bounded conditional/quantified effect (M3+, D8)
    | external(writeSet, fn)                 // semi-symbolic: declared writes, native compute
```

Effect timing semantics are preserved from v1/FluidHTN: `PlanOnly`, `PlanAndExecute`, `Permanent` — but now expressed *per effect* in data, so the planner can distinguish speculative rollout from world mutation symbolically.

### 4.5 Axioms (derived predicates)

Stratified rules deriving fluents from base fluents: `threatened(u) ⇐ ∃e:enemy · dist(pos(e),pos(u)) < 10 ∧ ¬inCover(u)`. Evaluated on demand, memoized per state layer, dependency-tracked for invalidation. Axiom heads are read-only to effects (write → compile error). Covers issue #13's "axioms + predicate register."

### 4.6 Operators (lifted primitive actions)

```ts
interface OperatorDecl {
  name: string;
  params: { name: string; type: TypeName }[];
  precondition: Formula;            // tiers per §4.9
  effects: EffectExpr[];
  cost?: NumExpr;                   // default 1; may read state (dynamic cost, as today)
  executor?: ExecutorRef;           // runtime binding: name → operator fn (Success/Failure/Continue)
  meta?: { provenance?, doc?, … }   // LLM-authored provenance lives here
}
```

The **executor** is the runtime behavior (what v1 calls the operator function); the symbolic effects are its *model*. Drift between model and reality is detected at execution (expectations, §9) — that discrepancy signal feeds repair and LLM model-repair.

### 4.7 Hierarchy: tasks, methods, task networks (total-order)

```ts
interface CompoundTaskDecl { name: string; params: Param[] }
interface MethodDecl {
  task: TaskRef;                    // which compound task this decomposes
  params: Param[];                  // method variables (⊇ task params)
  precondition?: Formula;           // method applicability
  subtasks: (TaskRef | OperatorRef | GoalSpec)[];  // totally ordered; goals allowed inline (§4.8)
  utility?: NumExpr;                // for utility-selection among methods
}
```

- v1's `select`/`sequence`/`utilitySelect` become method patterns (a select = one method per branch; sequence = one method with N subtasks); the fluent `DomainBuilder` API is preserved and now *emits IR*.
- Slots/`PausePlan` carry over unchanged in semantics.

### 4.8 Goals

`GoalSpec` is a first-class agenda item (GTPyhop unification — this replaces the `goap_sequence` special case):

```ts
type GoalSpec =
  | { kind: "state"; condition: Formula }                  // achieve F (search over operators)
  | { kind: "task";  task: TaskRef; args: Term[] }         // accomplish task (decompose via methods)
  | { kind: "maintain"; condition: Formula; while: GoalSpec } // execution-layer guard (§8)
```

State goals invoke the goal search (§7.3) with the full heuristic stack; PRs #10/#11's predicate-goals and heuristics land here natively.

### 4.9 Three evaluation tiers — the semi-symbolic contract

Every formula/effect node is classified at compile time:

| Tier | Declaration | Engine knowledge | Enabled optimizations |
|---|---|---|---|
| **T1 symbolic** | pure IR (fluents, comps, arithmetic) | full | everything: relaxation heuristics, landmarks, mutexes, regression/causal links, look-ahead pruning, perfect dirty-tracking, match-tree indexing |
| **T2 scoped-native** | native fn + **declared read set / write set** (fluent patterns) | reads/writes, not semantics | dirty-tracking, memoization, successor indexing on the symbolic part, causal-link repair, partial pruning; treated as "unknown but bounded" by relaxation heuristics |
| **T3 opaque** | bare closure (v1 compatibility) | none | none — evaluated every time; node-local; disables model-based heuristics on paths that depend on it |

Rule: **the engine exploits the best tier each node provides**; a domain's "optimization report" (§5.5) tells authors exactly what each T2/T3 node is costing them. This is the migration path: v1 closure domains run unmodified (all-T3), and every declaration upgrade buys measurable speed.

### 4.10 Spatial support (positions of players, regions, movement)

- `vec2/vec3` fluents + `dist`/`within` sugar (T1-adjacent: comparisons are symbolic over declared reads).
- **Region** entities with `in(pos, region)` provided by a `SpatialProvider` (T2: declared reads `{pos(x)}`).
- **Movement cost/feasibility providers**: `NavProvider { reachable(a,b): bool; cost(a,b): number }` — plugs pathfinding libs (`pathfinding`, `three-pathfinding`, recast) into operator costs and preconditions as T2 externals. Planning-time spatial queries are the Maisak/Decima pattern, specified here as a first-class provider interface.

### 4.11 Canonical document format (D1)

- **`DomainDocument` / `ProblemDocument`**: versioned JSON (`"format": "htn-ai/domain@2"`), JSON-Schema published, fully describing §4.1–4.10 (T2/T3 nodes serialize as named refs resolved against a runtime registry — documents are always data; code is bound by name).
- Design properties: LLM-authorable (the schema *is* the prompt contract), diffable, structured-clone-safe (workers), and the unit of incremental validation (§10).
- Builder API, JSON documents, and HDDL/PDDL imports all normalize into the same IR.

### 4.12 Interchange & coverage (G5)

| Format | Import | Export | Coverage |
|---|---|---|---|
| **HDDL** (IPC standard) | ✅ M1 | ✅ M4 | TO methods, typing, STRIPS preconds (conj/neg/equality), method preconds. PO inputs: reject with clear error in M1; optional linearization pass later (D6). |
| **PDDL** (classical) | ✅ M2 | ✅ M4 | STRIPS + `:typing` + `:action-costs` + `:numeric-fluents` (PDDL 2.1 level 2 fragment). Pure-goal problems run on the goal search. |
| Plan output | — | ✅ M1 | IPC plan format → verified by **pandaPIparser --verify** (HTN) / **VAL** (PDDL) in CI. |

Out-of-fragment constructs fail imports with precise diagnostics (never silent semantic drift). Conversely, T2/T3 and spatial constructs are flagged "not exportable to HDDL/PDDL" per node.

---

## 5. Compilation pipeline

`compile(domainDoc, problemDoc?, options) → CompiledDomain` — stages, each emitting trace events and reusable artifacts:

1. **Parse/normalize** — builder calls, JSON, or HDDL/PDDL → IR; `or`-elimination; name resolution.
2. **Validate/type-check** — arity/type errors, axiom stratification, effect-on-derived errors, T2 read/write-set sanity. Diagnostics are structured (code, location, suggestion) — the same payloads the LLM authoring loop consumes (§10).
3. **Ground** (hybrid, D5): static types ground **eagerly** to dense tables when `|instances| ≤ threshold`; `dynamic`/large types ground **lazily** — parameterized operators bind during successor generation via a lifted match tree (join over precondition literals, Powerlifted-style). Lazy grounding is the principled replacement for PR #9's generators (object-identity semantics, memoized per state).
4. **Analyze** — reachability/relevance (drop facts/actions that can't matter), mutex/invariant synthesis (boolean groups → enum fluents), compound-task precondition/effect inference for **look-ahead pruning** (the PandaDealer technique), Task Decomposition Graph construction (for TDG heuristics), landmark extraction (M3).
5. **Emit + report** — packed state layout (§6), successor-generator index, monomorphic evaluator functions for T1 formulas/effects (data-driven dispatch over typed arrays; **no `eval`/`new Function` by default** — CSP-safe; an optional Node-only codegen mode exists behind a flag if M1 benchmarks justify it, D9), and the **optimization report**: per-node tier, what was pruned, table sizes, heuristic availability.
6. **Incremental recompile** — `domain.addMethod/addOperator(decl)` patches tables and indexes without full recompilation (required by the method-miss/learning loop, §10; provenance recorded).

Compiled artifacts are serializable (cacheable, shippable to workers).

---

## 6. State runtime

- **Packed state**: one `WorldStateBuffer` per context — bitset segment (booleans), Uint8/16 (enums), Int32 (ints/entities), Float64 (floats/vecs); SoA layout; entity-indexed rows.
- **Rollout**: copy-on-write **layers** for search (`base + delta`), generalizing today's `WorldStateChangeStack`; O(changed) apply/undo; node pooling — steady-state search performs **zero allocations** per expansion (pool hit).
- **Hashing**: incremental Zobrist hash maintained per layer → O(1) visited-set keys (replaces JSON.stringify). Floats hash by quantized bits (D10 covers the lockstep/fixed-point profile).
- **Dirty tracking**: writes outside planning mark precise fluent-level dirt; replan triggers consult the *read sets* of the active plan's conditions (T1/T2) — "replan only if something the plan depends on changed," sharpening today's global `IsDirty`.
- **Facade**: `Context.getState/setState/hasState` remain, backed by the buffer; typed accessors generated from the domain (`ctx.fluents.health(unit)`).
- **Serialization**: state + active goals + RNG seed as JSON; **replan on load** (never persist mid-search internals).

---

## 7. Search core

### 7.1 Unified agenda

One engine processes a totally-ordered agenda of **tasks** (decompose via methods) and **state goals** (search via operators) — GTPyhop semantics under FluidHTN reactivity (MTR comparison, partial plans). Method selection strategies: ordered (default), utility-max, (pluggable: UCT later).

### 7.2 Decomposition search

- DFS progression with **visited/cycle detection** (Zobrist of ⟨state, agenda⟩) — completeness requirement (ICAPS 2025), replacing nothing-today.
- **Look-ahead pruning** via inferred compound preconditions/effects (§5.4).
- MTR recording as today (plan-priority comparison preserved bit-for-bit for v1 parity tests).

### 7.3 Goal search

- A\* family on grounded/lazily-grounded operator space: binary-heap open list (f at push), closed set by state hash, deterministic tie-breaking (f, then g-high, then stable id).
- **Anytime driver**: weighted A\* with decreasing ε schedule (ARA\*-style); emits best-plan-so-far + current bound; resumable.
- **Heuristics roster** (per-goal pluggable): `h_add`/`h_FF` (delete relaxation over T1; T2 treated as bounded-unknown), landmark count (M3), TDG-c/TDG-m for agenda items under hierarchy, **novelty-1 tiebreak**, user/LLM-written heuristics via sandboxed `(state, agenda) → number` slot with the evaluation harness (§11) scoring them.
- Numeric support: interval relaxation for `h_add` over numeric conditions (ENHSP-lineage, simplified; M3).

### 7.4 Budgeted sessions

```ts
const session = planner.beginPlanning(ctx, goalOrTask, opts);
loop: const r = session.step({ budgetMs: 0.5 /* or budgetNodes */ });
// r: { status: "working" | "plan" | "improved" | "exhausted", plan?, bound?, stats }
```

Generator-based; every stage (grounding, decomposition, goal search, repair) checkpoints against the budget. `planner.tick(domain, ctx, { budgetMs })` drives a session internally. Main-thread by default; `@htn-ai/worker` runs sessions in a Worker over plain `postMessage` (SAB not required).

### 7.5 Determinism

Injected seeded RNG only; stable iteration everywhere; no wall-clock reads inside search (budgets measured via injected clock); identical ⟨domain, problem, seed, budget-in-nodes⟩ ⇒ byte-identical trace hash across platforms (float caveats per D10). CI asserts this.

---

## 8. Execution layer

- **Planner v2 tick**: as today (run operator, executing conditions, effects on success) plus: budget pass-through, **fluent-precise replan triggers** (§6), and repair-first policy.
- **Plan repair**: decomposition trace retained per plan; on failure/relevant-delta, backtrack from the failure point and re-decompose minimally (IPyHOPPER pattern), validated against causal links (which effect supports which precondition — computable from T1/T2 declarations); fall back to full replan above a perturbation threshold (Fox 2006). MTR still arbitrates replace-vs-keep.
- **Scoped execution**: first-class scopes with `onEnter/onExit` (exit runs on success, failure, *and* abort — the try/finally PR #12 emulated), `deadline(ms)` and `maintain(condition)` guards that abort the scope (triggering exit handlers + repair). Scope state lives in the **context**, not task instances (multi-agent safe).
- **Concurrency**: M4+ — multiple intention lanes per agent (BDI-style) executing independent plan segments with conflict detection via write-set intersection; until then `DoInParallel` does not exist (no fake serialization).
- **Async operators**: executors may return `Promise` — adapter maps to `Continue` lanes; cognition (LLM calls) stays off the tick path (AI-Town split).
- **Multi-agent scheduler**: shared `CompiledDomain` (immutable), N contexts; round-robin replan staggering against a global per-frame budget; per-agent cadence/LOD.

---

## 9. Observability & validation contract

- **Trace bus**: every engine decision emits versioned, serializable events — `compile.*`, `ground.*`, `search.expand|prune(reason)|heuristic`, `decompose.try|reject(conditionId, bindings)`, `mtr.compare`, `plan.emit|repair|abort`, `exec.operator|expectationViolated(fluent, expected, observed)`. Replaces `loglevel` strings/`MTRDebug`. Ring-buffered; off by default per category; structured-clone-safe → devtools, files, CI.
- **Validator APIs** (the LLM-Modulo "sound critic" + test utilities):
  - `validatePlan(domain, state, plan) → Diagnosis[]` (unsatisfied precondition: step, condition, bindings, supporting-step analysis)
  - `simulate(domain, state, plan) → trajectory | Diagnosis`
  - `applicableActions(state) / applicableGoals(state)` (affordance queries)
  - `explainFailure(traceSlice) → structured + NL-renderable explanation`
- **Expectations**: executors' symbolic effects are checked against observed state post-execution; violations emit trace events and feed repair + LLM model-repair (§10).

---

## 10. LLM integration surface (`@htn-ai/llm`)

- **Authoring loop**: JSON-Schema'd `DomainDocument` + `validateIncremental(patch) → Diagnostics` (per-element, early), NL rendering of domains/plans/diagnoses for prompting, domain diff. Generate→validate→repair, with the library as the sound verifier.
- **Method-miss hook**: `onDecompositionMiss(async ({task, state, affordances}) => MethodDecl | null)` — branch pauses via partial-plan machinery; proposal is **verified by simulation** before use; optional **generalize & cache** (lift constants → parameters, minimal preconditions via goal regression) with provenance, amortizing LLM calls toward zero (ChatHTN + method-learning line).
- **Heuristic harness**: register candidate heuristics; harness scores them on benchmark domains (coverage/expansions/quality); best-per-domain selectable at runtime.
- **Exports**: plan → dependency DAG / step list for LangGraph/Vercel-AI tools; Temporal/Inngest execution recipes.

---

## 11. Evaluation & benchmarking plan (G5 — "match or surpass within our goals")

### 11.1 Suites

| Suite | Source | Validates |
|---|---|---|
| **IPC TO-HTN** | IPC 2020/2023 HDDL domains (≥20 by M4) | correctness vs pandaPIparser --verify; coverage/quality/time vs reference planners |
| **Classical** | IPC STRIPS + numeric subset via PDDL import | goal-search parity; VAL-verified plans |
| **Puzzles** | PR #14's 15 problems, re-derived (solved *by search*, executed via `Planner.tick`) | representation expressivity (sokoban/blocks/jugs/river) |
| **Game scenarios** | bunker, FPS, + new spatial escort/patrol (from PR #12's concepts) | T2 providers, repair, scopes, budgets |
| **Agent soak** | N agents × Hz × budget in headless sim + browser demo | scheduler, GC, determinism at scale |

### 11.2 Reference planners & validators (run natively in CI containers)

pandaPIengine (TO progression config), HyperTensioN, Fast Downward (`lama-first`; `A*+lmcut` for optimal sanity checks), pyperplan (interpreter-class baseline), ENHSP (numeric subset); pandaPIparser & VAL as ground-truth validators.

### 11.3 Metrics

Coverage; time-to-first-plan; **anytime quality curve** (plan cost vs. time at 10/50/100/500ms); plan-cost ratio vs best-known; expansions/sec; repair-vs-replan time and plan-stability on perturbation suites; p99 frame overrun at fixed budget; allocations/expansion; trace-hash determinism across runs/platforms.

### 11.4 Success criteria (provisional — finalized at M1 gate with measured baselines, D11)

**Must win (our goals — online/real-time):** best time-to-first-plan and best anytime-quality-at-≤100ms among all compared systems on game/agent suites; repair ≥5× faster than full replan on small perturbations with higher plan stability; 200 agents @60fps ≤2ms/frame aggregate planning in the browser demo; zero steady-state GC churn; deterministic traces. *(No compared system even offers budgeted operation — we must also be respectable in their arena:)*

**Must be respectable (their arena — offline batch):** ≥ HyperTensioN/pyperplan-class coverage on the IPC TO-HTN suite; within an order of magnitude of pandaPIengine wall-time on commodity hardware, with 100% verifier-valid plans. Native C++ total-coverage parity is explicitly *not* the bar (G1 is).

Results published as a versioned report generated by `@htn-ai/eval` in CI — the reproducible public benchmark the field currently lacks.

---

## 12. Performance engineering targets & tactics

Provisional targets (validated/adjusted at M1, D11): ≥50k–100k expansions/sec on grounded mid-size domains (M2-class laptop, V8); ≤1 pooled-object reuse (0 allocations) per expansion; `session.step({budgetMs:0.5})` overrun p99 <0.2ms; domain compile <100ms for FPS-scenario-class domains, incremental method add <5ms.

Tactics (specified, not optional): SoA typed-array state; pooling for nodes/layers/bindings; monomorphic evaluator shapes; incremental Zobrist; match-tree successor generation; heuristic value caching per state-hash; budget checks amortized (every K expansions); no exceptions on hot paths; benchmarks (`tinybench`) gating CI on regression >10%.

---

## 13. Packaging, compatibility & migration

- **Packages** (D2): `htn-ai` (core, 0-dep) · `@htn-ai/hddl` · `@htn-ai/pddl` · `@htn-ai/llm` · `@htn-ai/eval` · `@htn-ai/devtools` · `@htn-ai/worker` · adapters (`/react`, `/xstate`, `/phaser`, `/excalibur`, `/langgraph`).
- **v1 compatibility**: v1 API (Domain/Context/Planner/DomainBuilder, closure conditions/effects) ships as a compatibility layer over the v2 engine (all-T3 + facade); FluidHTN-parity test suite must stay green through v2.0. v1.x maintenance branch for fixes only.
- **Migration**: codemods optional; the real path is incremental tier-upgrading guided by the optimization report (§5.5).
- **Hygiene** (immediate, pre-M1): fix `package.json` `repository/homepage/bugs` → `Glavin001/HTN-AI`; CI Node 20/22/24 + browser (playwright smoke); request FluidHTN README listing.

---

## 14. Milestones & acceptance gates

| M | Scope | Gate (acceptance) |
|---|---|---|
| **M0** | This spec reviewed; §17 decisions signed off | Agreement on D1–D11 |
| **M1** | IR + compiler (T1/T2/T3, validate, ground eager+lazy, packed state, evaluators) + HDDL import + plan verification | 5 IPC HDDL domains import, solve (slow search OK), pandaPIparser-verified; v1 parity suite green on facade; baseline perf measured → finalize §11.4/§12 numbers |
| **M2** | Search core: unified agenda, cycle detection, heap A\*/weighted A\*, h_add/h_FF, novelty, budgeted sessions, PDDL import | Puzzle suite solved by search via `tick`; budget honored (p99); determinism CI |
| **M3** | Anytime driver, TDG heuristics, look-ahead pruning, landmarks, numeric relaxation, repair v1 (trace backtrack + causal links) | ≥20 IPC domains; anytime curves published; repair beats replan on perturbation suite |
| **M4** | Execution v2: scopes/deadlines/maintain, scheduler, async lanes, worker pkg, HDDL/PDDL export, eval harness public | Agent-soak gate (200 agents demo); first public benchmark report |
| **M5** | Trace bus everywhere + devtools inspector MVP (live graph, why-rejected, state diff, time-travel) | "Why didn't the agent do X?" answerable from inspector alone on the demo |
| **M6** | `@htn-ai/llm`: authoring loop, method-miss + learn/cache, heuristic harness, orchestrator exports + 1 framework adapter | Scripted CI demo: domain authored→rejected→repaired→accepted; method-miss solves novel task, second run zero LLM calls |

(M5 may swap before M3/M4 if we choose tooling-first — D12.)

---

## 15. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **IR scope creep** (full PDDL/HDDL is a tar pit) | Frozen fragments (§4.12) with precise rejection diagnostics; expressivity pressure routed to axioms + T2, not grammar growth |
| **JS perf ceiling vs native planners** | Targets framed on *our* goals (budgeted/anytime/repair) where no competitor exists; honest "respectable" bar offline (§11.4); typed-array discipline; optional codegen flag (D9); WASM consciously deferred (Zaplib evidence) |
| **Heuristic implementation complexity** (h_FF/landmarks/TDG are subtle) | Sequenced M2→M3; each heuristic validated against reference planner expansions on shared domains; pyperplan as readable cross-check |
| **Two-engine drift** (v1 facade vs v2) | v1 facade *is* v2 all-T3 — one engine; parity suite in CI |
| **LLM-authored domains are wrong** | That's the product: incremental validation + simulation verification + expectation monitoring; nothing unverified executes |
| **Determinism vs floats** | Quantized hashing; documented hazards; fixed-point profile decision (D10) |
| **Solo-maintainer bandwidth** | Milestones are independently shippable; eval harness + parity suite make contributions safe; benchmark report attracts contributors |

---

## 16. Explicitly out of scope (v2)

PO-HTN execution semantics · temporal/durative actions · FOND/probabilistic search · visual editor · built-in pathfinding/navmesh · multiplayer netcode (we provide determinism; transport is yours) · model training of any kind.

---

## 17. Open decisions for sign-off

- **D1 Canonical format**: JSON `DomainDocument` as source of truth with HDDL/PDDL converters (recommended) — vs HDDL-native. *Recommend JSON: web/LLM-native, supersets the standards, schema-validatable.*
- **D2 Packaging**: monorepo + scoped packages as in §13 (recommended) vs single package.
- **D3 Name**: ship v2 as `htn-ai@2` (recommended for now; revisit branding before public launch — downloads are ~19/wk, rename cost ≈ 0).
- **D4 Numeric fluents in M1 core** (recommended — retrofitting types is worse) vs M3 add-on.
- **D5 Grounding default**: eager-with-lazy-fallback threshold (recommended) vs lazy-always.
- **D6 PO-HDDL imports**: reject-with-diagnostic in M1 (recommended); linearization pass as M4 stretch.
- **D7 Disjunction**: compile-away only (recommended) vs native `or` in core formulas.
- **D8 Conditional/quantified effects (`forEach`)**: M3 (recommended) vs M1.
- **D9 Codegen (`new Function`) fast path**: benchmark-gated optional Node flag (recommended) vs never.
- **D10 Determinism profile**: float64 + quantized hashing default, optional fixed-point (scaled-int) profile for lockstep (recommended) — vs fixed-point everywhere.
- **D11 Performance numbers**: treat §11.4/§12 as provisional until M1 baselines (recommended) vs commit now.
- **D12 Milestone order**: engine-first as tabled (recommended) vs tooling-first (M5 before M3) for demo-ability.
