# Goal serialization & protection (combinatorial blow-up of conjunctive goals)

A common, deceptively hard situation in planning: the goal is a **conjunction**
`g₁ ∧ g₂ ∧ … ∧ gₙ` whose conjuncts are *individually easy* but, handed to one
search, **blow up combinatorially**. The wall demo (`scenarios/wall.ts`) is the
worked example — "every cell of this ring ends up two blocks tall" — but the
shape is generic. This note explains why it blows up and what htn-ai does about
it.

## Why one joint search blows up

Two independent causes compound (different techniques attack different ones):

- **Depth.** The combined plan is long (the 12-cell, 2-tall wall is ≈ 96 steps).
  Search cost is exponential in depth for any imperfect heuristic.
- **Symmetry.** Blocks are interchangeable and target cells are interchangeable,
  so every *ordering* of the n subgoals and every *block↔slot assignment* is a
  distinct search path (~n! of them) that all collapse to the same essential
  plan. A better heuristic sharpens the gradient but removes neither cause —
  empirically, even very greedy weighted-A\* still dies on the flat 12-cell goal.

The fix is **decomposition**, not a cleverer heuristic.

## The technique: goal-agenda serialization (with protection)

htn-ai's reactive `Planner` takes two related options:

### `goalAgenda: true` — serialize the conjunction

Treat the goal set as an ordered agenda and solve it **one subgoal at a time,
committing** to each before the next (replanning from the reached state). A single
*declarative* conjunctive goal `goal(a ∧ b ∧ …)` is **auto-split into its
conjuncts** (`buildAgenda`, purely structural — the subgoals come from the goal's
own form, nothing is prescribed). This turns one n!-symmetric, depth-96 search
into n tiny depth-~7 searches: cost becomes **linear in cells** (the wall drops
from ~56 s / intractable to ~0.2 s).

### `protectAchieved` — keep it sound (default ON with `goalAgenda`)

Plain serialization with commitment is **unsound** on *non-serializable* goals:
it can report success after the last subgoal while an earlier one has been
clobbered. The canonical case is the **Sussman anomaly** (`on(a,b)` and
`on(b,c)`): achieving `on(b,c)` requires clearing `b`, which destroys `on(a,b)`.
Blind serialization happily returns `on(b,c)` true and `on(a,b)` *false* —
"succeeded" but wrong (see `tests/exec.ts`).

Protection fixes this: when a subgoal is committed, every *later* subgoal's search
goal becomes the **cumulative conjunction** of all subgoals achieved so far plus
the current one. A later subgoal may pass *through* states that break an earlier
one, but the committed result never violates it — the planner temporarily undoes
and restores as correctness demands (for Sussman: unstack `a`, stack `b` on `c`,
re-stack `a` on `b`). Because each step still starts from a state where the
protected prefix already holds, protection is **nearly free when subgoals are
independent** (it's never disturbed) and pays only for the local re-work when they
interact.

This is the soundness core of **agenda-driven / ordered-landmark planning**
(cf. Koehler & Hoffmann, *On Reasonable and Forced Goal Orderings*, JAIR 2000).

### `landmarks` — threshold landmarks for interfering build-up goals

Protection keeps serialization *sound*, but per-cell serialization can still
*fail* when the subgoals genuinely **interfere**. The worked example is the hard
wall (`wallInstanceHard`): under realistic physics a ring cell can only be topped
from a neighbour that's already been raised, so a lone 2-tall pillar is
unbuildable and committing cell-by-cell strands cells the agent can't reach.

The fix is **ordered landmarks**. A goal `f ≥ k` over a unit-step integer fluent
(changed only by ±1) can only be reached by passing through `f ≥ 1, …, f ≥ k-1`
— each lower threshold is a **landmark** (a fact every solution must establish
first). With `landmarks: true` the agenda is expanded into these threshold
landmarks and **ordered by level**: every cell's `≥ 1` before any cell's `≥ 2`.
For the wall that means *the whole base course is laid before any top course*, so
every upper course has a neighbour to stand on. The same hard instance that fails
10/12 under plain serialization finishes 12/12 in tens of milliseconds.

This is the agenda analogue of ordered landmarks in classical planning
(Hoffmann/Porteous/Sebastia, *Ordered Landmarks in Planning*, JAIR 2004). The
threshold landmarks (per fluent) are sound; the cross-variable *level* ordering is
a "build the lower courses first" heuristic that matches the support structure of
stacking domains.

### `heuristic: "lmcut"` — admissible landmark heuristic for *optimal* joint planning

Serialization buys tractability by **sacrificing optimality**: committing to one
subgoal at a time can force re-work that an all-at-once plan avoids. The Sussman
anomaly is the clean measurement — serialized (and protected, so *sound*) it costs
**10 actions; the optimal plan is 6**. Crucially this gap is *structural to
serializing*, not an artifact we can tune away: neither reordering the two
subgoals nor solving each subgoal optimally (weight 1) changes the 10 — both
orders still commit `b`-on-`c` while `c` is on `a` and must tear it down. Only a
**joint** search that sees the whole goal at once clears `a` first and finds the 6.

So when you want optimality, you want the joint search — but the joint search is
exactly what blows up (that's why we serialize). The bridge is a stronger
**admissible** heuristic. The engine's default admissible heuristic is `h_max`,
which is weak; `heuristic: "lmcut"` adds **LM-cut** (Helmert & Domshlak 2009),
which repeatedly extracts *disjunctive action landmarks* (the cheapest action
across each cut between the goal zone and the rest) and sums their costs. It
**dominates `h_max`** while staying admissible, so weight-1 A\* still returns the
optimal plan but expands a tiny fraction of the nodes. Measured on reversing an
`N`-tower (optimal joint planning, weight 1):

| instance | optimal cost | `h_max` expansions | `lmcut` expansions |
|---|---|---|---|
| Sussman | 6 | 12 | 10 |
| reverse-7 | 14 | 107 | 15 |
| reverse-8 | 16 | 347 | 17 |
| reverse-9 | 18 | 1253 | **19** |

LM-cut's expansions track the plan length (the heuristic is nearly perfect here)
while `h_max` blows up — a 66× cut on reverse-9. That is what makes the optimal
joint plan **affordable**: where you'd otherwise serialize and accept the
suboptimal-but-sound result, an admissible landmark heuristic lets you take the
optimal one for as long as the joint search stays in budget. It's an admissible
search heuristic (`planOnce(..., { weight: 1, heuristic: "lmcut" })`), independent
of and complementary to the agenda machinery above.

## Soundness vs completeness — what we guarantee

- **Sound:** with protection on (the default), the planner never reports success
  with the conjunction violated. If a subgoal genuinely can't be added from the
  committed state, it reports `failed` — never a wrong result.
- **Serializable-under-protection:** protected serialization solves any goal where
  some order lets each prefix be (re-)achieved while protecting the rest — which
  includes the classic non-serializable puzzles like Sussman.
- **Interfering build-up goals:** `landmarks: true` decomposes numeric `f ≥ k`
  goals into level-ordered threshold landmarks (base course before top course),
  which solves the hard, interdependent wall that plain per-cell serialization
  strands.
- **Not a completeness guarantee in general.** In a *reactive* executor, commitment
  means *executed* actions, which can't be un-executed; a pathologically bad static
  order could still strand the planner (it then fails soundly). Two further
  extensions would close the remaining gap:
  - **Reasonable goal orderings** (Koehler-Hoffmann): derive an order so prefixes
    stay achievable rather than relying on the agenda's input order. Note this does
    *not* help the Sussman optimality gap — both orders cost 10 (above); it is a
    *completeness/soundness-of-order* tool, not an optimality one.
  - **Optimality via admissible search** — *implemented*: `heuristic: "lmcut"`
    (above) makes optimal joint planning tractable, recovering the optimal plan
    that serialization gives up. The open extension is using these discovered
    landmarks to drive the *agenda* (cost-based ordering), not just the search.

## When to reach for what

| Situation | Approach |
|---|---|
| You can encode independence into the domain | Model it away first (e.g. the wall's source-gated `grab` + reach-one-up `place`) |
| Subgoals serializable; speed > optimality | `goalAgenda` serialization (protection on) |
| Need the **optimal** plan; problem moderate-sized | joint search + `heuristic: "lmcut"` (weight 1) |
| Build-up subgoals INTERFERE (top needs base) | `goalAgenda` + `landmarks` (threshold landmarks, base course first) |
| Lots of interchangeable objects; need completeness/optimality | Symmetry breaking (orbit pruning) |
| General goals; want a principled heuristic + ordering | Landmarks / factored planning |
| You have reliable expert know-how on *how* | HTN control knowledge |

The wall demo combines the first two: domain rules make the subgoals independent,
and `goalAgenda` (with protection, free here) exploits it.
