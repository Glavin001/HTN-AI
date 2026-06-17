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

## Soundness vs completeness — what we guarantee

- **Sound:** with protection on (the default), the planner never reports success
  with the conjunction violated. If a subgoal genuinely can't be added from the
  committed state, it reports `failed` — never a wrong result.
- **Serializable-under-protection:** protected serialization solves any goal where
  some order lets each prefix be (re-)achieved while protecting the rest — which
  includes the classic non-serializable puzzles like Sussman.
- **Not a completeness guarantee in general.** In a *reactive* executor, commitment
  means *executed* actions, which can't be un-executed; a pathologically bad static
  order could strand the planner (it then fails soundly). Two standard extensions
  close the remaining gap and are good future work:
  - **Reasonable goal orderings** (Koehler-Hoffmann): derive an order so prefixes
    stay achievable (for Sussman, order `on(b,c)` before `on(a,b)`), so even blind
    serialization succeeds and protected serialization needs no re-work.
  - **Landmark heuristics** (Hoffmann/Porteous/Sebastia 2004; LAMA): extract
    intermediate landmarks and an LM-count/LM-cut heuristic to guide search and
    derive orderings automatically.

## When to reach for what

| Situation | Approach |
|---|---|
| You can encode independence into the domain | Model it away first (e.g. the wall's source-gated `grab` + reach-one-up `place`) |
| Subgoals serializable; speed > optimality | `goalAgenda` serialization (protection on) |
| Lots of interchangeable objects; need completeness/optimality | Symmetry breaking (orbit pruning) |
| General goals; want a principled heuristic + ordering | Landmarks / factored planning |
| You have reliable expert know-how on *how* | HTN control knowledge |

The wall demo combines the first two: domain rules make the subgoals independent,
and `goalAgenda` (with protection, free here) exploits it.
