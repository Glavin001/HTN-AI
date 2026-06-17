# Real-time / agile planning: BFWS, preferred operators, deferred evaluation

The optimal-planning heuristics (`heuristic: "lmcut"`, see
[goal-serialization.md](./goal-serialization.md)) prove plans optimal but spend
search effort to do it. A reactive, embedded planner running under a **tick
budget** usually wants the opposite trade: a *good* plan *fast*, with cheap
per-node work, scaling to large states. That is the **satisficing / agile**
lineage, and `search: "bfws"` brings its current state of the art into the engine.

## What it is

`search: "bfws"` (on `planOnce`'s `PlanRequest` and the reactive `Planner`'s
options) is **Best-First Width Search** (Lipovetzky & Geffner, *Best-First Width
Search: Exploration and Exploitation in Classical Planning*, AAAI 2017), bundled
with the two standard accelerators that make greedy search fast:

### 1. Novelty width as the primary key (exploration)

A state's **novelty width** is the size of the smallest tuple of facts it makes
*new* — width 1 if it carries a fact never seen before, width 2 if a never-seen
*pair*, and so on. BFWS orders the frontier by ⟨width, #unmet-goals, h⟩: prefer the
structurally novel first, break ties by goal progress, then by a cheap heuristic.
Novelty is measured *within a partition* keyed by the unmet-goal count (#g), and
capped (default 2, `noveltyWidth`). The striking empirical fact behind width-based
search is that most planning domains have **low width**, so this exploration term
alone carries the search through huge state spaces that defeat pure heuristic
hill-climbing. Novelty is computed over the interned **relaxation atoms**, so
numeric/clock fluents (which would make every state trivially "novel") are excluded
automatically.

### 2. Preferred operators (exploitation)

At each expanded node we extract a **relaxed plan** (back-chaining cheapest
achievers from the goals, h_add). An applicable operator that appears in that
relaxed plan is a **preferred operator** — FF's "helpful actions" (Hoffmann &
Nebel 2001). Their successors go into a *second* open list, and the search uses a
**boosted dual queue**: it favours preferred-operator nodes but keeps the regular
queue in rotation so width-based exploration never starves (Richter & Helmert,
*Preferred Operators and Deferred Evaluation*, ICAPS 2009).

### 3. Deferred heuristic evaluation

The relaxed plan is computed **once per expanded node**, not for every generated
child (a child is ordered using its parent's estimate until it is itself
expanded). Since the relaxed-plan/heuristic computation dominates per-node cost,
this is a large constant-factor win — and it is exactly why BFWS's heuristic
evaluations track its *expansions* rather than its (much larger) generated count.

## Measured (vs weighted-A\*, on hard blocks instances)

A deterministic 18-block instance (random initial layout → random goal), and a
22-block one, joint goal, no serialization:

| instance | search | status | expansions | heuristic evals | time |
|---|---|---|---|---|---|
| 18-block | weighted-A\* | success | 9101 | 41 331 | 2641 ms |
| 18-block | **BFWS** | success | **436** | **435** | **94 ms** |
| 22-block | weighted-A\* | success | 3211 | 25 606 | 1824 ms |
| 22-block | **BFWS** | success | **964** | **963** | **309 ms** |

Two effects are visible:

- **Deferred evaluation** collapses heuristic work: BFWS does ≈ one relaxed plan
  per *expanded* node (`heuristicEvals ≈ expansions`), where weighted-A\* evaluates
  every generated child — a **25–95× reduction** in heuristic computations.
- **Novelty + preferred operators** cut expansions and wall-clock by an order of
  magnitude on the instances where the delete-relaxation heuristic plateaus.

## The trade-off (read this before switching)

BFWS is **not cost-optimal**. On the same instances its plans are often longer
than weighted-A\*'s (e.g. it may return a 120-action plan where weighted-A\* finds
60). That is the agile bargain: a fast, scalable *first* solution instead of a
proven-optimal one. Use it when:

- you plan under a **tick / latency budget** and need an answer now;
- the state space is **large** (many objects) and pure heuristic search stalls;
- plan *length* is secondary to **getting a working plan** and to coverage.

Reach for weighted-A\* (default) — optionally with `heuristic: "lmcut"` at
`weight: 1` — when you need the optimal or a bounded-suboptimal plan and the
problem is small enough to afford it.

## What's intentionally *not* here yet

- **Anytime improvement** (ARA\* / restarting weighted-A\*): emit a fast plan, then
  keep improving it within the remaining budget with a shrinking suboptimality
  bound. This is the natural complement that would let BFWS's quick-but-long first
  plan be refined toward optimal as time allows.
- **Bounded-suboptimal search with a distinct distance-to-go estimate** (EES,
  Thayer & Ruml 2011).

These are the next rungs on the real-time ladder, deliberately left for a separate
change.

## API

```ts
// offline
planOnce(model, state, { goals: [goal(G)], search: "bfws" });            // width cap 2
planOnce(model, state, { goals: [goal(G)], search: "bfws", noveltyWidth: 1 });

// reactive executor (per-subgoal episodes use BFWS)
new Planner(model, { goals: [goal(G)], search: "bfws" });
```
