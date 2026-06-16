# Performance roadmap — what's next (for future PRs)

> Companion to [`PERFORMANCE.md`](./PERFORMANCE.md) (what's already landed). This is
> a **decision document**: the remaining optimization opportunities, each with an
> honest **impact / risk / effort** estimate and trade-offs, grounded in this
> repo's profiles + scaling sweeps and recent (2024–2026) research. Nothing here
> is implemented yet. Read the profile first, then pick.

## Where the time actually goes now (post-optimization)

From `bench`/`bench:scale` + CPU profiles after the 10 landed optimizations:

| Regime | Examples | Dominant cost | What would move it |
|---|---|---|---|
| Heuristic-bound GOAP | quarry, scavenger, HUGE grids | `relaxCore`+`materialize` ≈ **42%** | better/incremental heuristic (§1, §2) |
| Inherent precondition eval | quarry geometry comparisons | `(anon)`/`fn`/`dyn` ≈ **21%** | mostly irreducible; helpful-actions (§3) |
| A* machinery | all GOAP | `goalSearch` ≈ **17%** | node pooling / lazy children (§7) |
| HTN decomposition | tour, htn, real hierarchies | **uninformed** (depth-first + MTR) | TDG/landmark HTN heuristics (§4) |
| Relational (dynamic) | none in suite yet | successor gen O(candidates) | match-tree / lifted (§6) |

Two facts shape everything below: (a) the **exact-optimal tests** (`hmax`+`w=1`)
pin plan length/cost, so any change to the *default/admissible* heuristic is
high-risk — most heuristic work should be **opt-in** for satisficing search; and
(b) the **HTN half is currently heuristic-blind** — the biggest untapped area.

## Quick-scan table

| # | Item | Impact | Risk | Effort | When |
|---|---|---|---|---|---|
| 1 | h_FF + helpful actions (opt-in) | **High** | Low–Med | Med | **Next** |
| 2 | Incremental delete-relaxation (parent→child Δ) | **High** | Med–High | High | Soon |
| 3 | Preferred-operator / dual-queue search | Med–High | Low | Med | **Next** |
| 4 | TDG + landmark heuristics for HTN | **High** | Med | High | Soon |
| 5 | LLM-authored domain heuristics + harness | **High** (strategic) | Low | Med | Soon |
| 6 | Match-tree / lifted successor generation | Med | Med | High | When a domain needs it |
| 7 | Node pooling / lazy child materialization | Low–Med | Med | Med | Opportunistic |
| 8 | BFWS / novelty-2 search mode (opt-in) | Med–High | Low–Med | Med | Soon |
| 9 | Landmarks for GOAP (LM-cut / count) | Med | Med | High | Later |
| 10 | Mutex / invariant synthesis | Med (enabler) | Med | High | Foundational |
| 11 | Partial-order reduction + symmetry (optimal) | Med–High (optimal only) | **High** | High | Research |
| 12 | Red-black / partial delete relaxation | Med | High | High | Research |
| 13 | Regression-gated CI (`tinybench`) | Low (infra) | Low | Low | **Cheap win** |

---

## Tier 1 — high ROI, manageable risk (do these first)

### 1. h_FF heuristic + helpful actions *(opt-in `heuristic: "ff"`)*

**What.** The engine has `h_add`/`h_max`/`none`. Add **h_FF**: build the relaxed
planning graph (already done in `relaxCore`), then extract a *relaxed plan* by
back-chaining from the goal over best supporters; `h_FF` = its size. Standard in
satisficing planning and typically **much more informative than h_add** → fewer
expansions. The same back-chain yields **helpful (preferred) actions** — the
first actions of the relaxed plan — for §3.

**Impact.** High on hard satisficing problems (the greedy default). On easy ones
(quarry is heuristic-saturated) it mainly helps via preferred operators.
Reduces *expansions*, which compounds with the per-node speedups already landed.

**Risk.** Low–Med. h_FF is **inadmissible** → it must be **opt-in**, never the
`hmax` path the optimal tests use. Extraction is well-understood; the main care
is reusing the existing interned-atom relaxation cleanly.

**Effort.** Med (~1 PR). Reuses `relaxCore`'s graph; adds a back-chain pass + a
`heuristic: "ff"` option + a test that it solves with fewer expansions than
`hadd` on a hard instance.

**Trade-offs.** Per-node cost rises slightly (extraction) but expansions drop —
net win on hard problems, neutral on easy. *Research:* FF (Hoffmann & Nebel);
the Datalog paper notes FF = back-chaining over supporting rules.

### 3. Preferred-operator / dual-queue search

**What.** Once §1 gives helpful actions, run a **dual open list**: one queue
restricted to preferred operators, one for all, alternating pops (LAMA-style).
Cheap, large practical speedups in satisficing planning.

**Impact.** Med–High (compounds with §1). Directly attacks expansion count, which
is the lever on the search-heavy scavenger grids.

**Risk.** Low (opt-in; doesn't affect optimal search). **Effort.** Med (small
once §1 lands). **Depends on §1.** *Research:* LAMA; [LAMA+BFWS 2024](https://arxiv.org/abs/2404.17648).

### 5. LLM-authored domain heuristics + evaluation harness *(strategic for htn-ai)*

**What.** Expose a sandboxed `(state, agenda) → number` heuristic slot (SPEC §11
already specs it) plus a harness that scores candidate heuristics on benchmark
instances (coverage / expansions / quality) and selects the best per domain.
Because this is an **LLM-first** planner, the heuristics are authored by an LLM
**offline** and run deterministically online.

**Impact.** High and **differentiated**. NeurIPS 2025 (Corrêa et al.) showed
**LLM-generated Python heuristics beat domain-independent heuristics** and rival
learned ones, expanding *fewer* states in several domains; an HTN-specific
result (Claude-Opus-written heuristics solved 131/139 IPC-2020 problems vs PANDA
RC^FF's 134, less search on 83%). This turns "the LLM writes a heuristic once"
into a real planning edge.

**Risk.** Low for the core (it's a pluggable slot + harness; doesn't touch the
default search). The risk is sandboxing/determinism of user/LLM code, which the
T3 escape-hatch machinery already half-solves.

**Effort.** Med. Mostly the harness + a clean heuristic-registration API + CSP-safe
sandbox. **Trade-offs.** Domain-dependent (needs per-domain authoring) — but
that's exactly the htn-ai workflow. *Research:*
[Classical Planning with LLM-Generated Heuristics, NeurIPS 2025](https://arxiv.org/abs/2503.18809);
[HTN Planning with LLM-Generated Heuristics](https://arxiv.org/html/2605.07707v1);
[Successor-Generator Planning with LLM Heuristics](https://arxiv.org/pdf/2501.18784).

### 13. Regression-gated CI (`tinybench`)

**What.** Wire `npm run bench`/`bench:scale` into CI; fail on >10% per-node
(µs/node) regressions. **Impact.** Low (infra) but **protects every win above**.
**Risk/Effort.** Low/Low. SPEC §12 asks for it. Do it early.

---

## Tier 2 — high value, more effort

### 2. Incremental delete-relaxation heuristic (parent→child Δ)

**What.** `relaxCore` rebuilds the relaxed graph from scratch every state
(~30–45% of GOAP CPU). A child differs from its parent by one operator's
effects, so its relaxed costs can be **updated incrementally** instead of
recomputed — the "semi-naive Δ evaluation" the 2026 Datalog paper formalizes
(only re-fire rules whose body touched a changed fact).

**Impact.** High — directly targets the single biggest remaining cost on the slow
spatial domains. **Risk.** Med–High: must produce **identical h** (or it perturbs
search and the optimal tests), and storing/reconstructing per-node relaxed state
is memory-heavy. Note: an *intra*-evaluation worklist was already tried and
reverted (dense small graphs); the *inter*-state Δ is a different, more promising
target but trickier. **Effort.** High.

**Trade-offs.** Big speedup *iff* the bookkeeping/memory stays below the recompute
cost — true for large grounding (scavenger HUGE, big grids), marginal for tiny
ones. Gate it on ground-op count. *Research:*
[Parallel Lifted Planning via Semi-Naive Datalog Evaluation (2026)](https://arxiv.org/html/2605.07584v1).

### 4. TDG + landmark heuristics for the HTN half

**What.** Today HTN decomposition is **uninformed** — depth-first method order +
MTR, no heuristic on task agenda items. Build the **Task Decomposition Graph**
(reachable hierarchy) and derive a **TDG heuristic** (relaxed reachability over
the hierarchy, admissible) and/or **HTN landmarks** to guide which method to try.

**Impact.** High for real hierarchical domains (deep/branchy method trees), which
the current toy `htn tour` doesn't stress but production HTNs will. It's the
largest *untapped* area (the GOAP half is now well-optimized; the HTN half isn't).

**Risk.** Med — new subsystem; integrating into the *unified* agenda search
(tasks + goals interleaved) is non-trivial. Admissible TDG keeps optimality.
**Effort.** High. *Research:* PANDA (dominated IPC-2023 HTN);
[Heuristics based on TDGs, SoCS 2024];
[Landmark Generation in HTN Planning Revisited (ICAPS)](https://ojs.aaai.org/index.php/ICAPS/article/download/36123/38277/40196).

### 8. BFWS / novelty-2 search mode *(opt-in)*

**What.** The engine has novelty-1 tie-breaking; **Best-First Width Search**
makes novelty the *primary* driver, partitioned by heuristic (`#unachieved goals`,
h), with novelty evaluated to width 2. SOTA exploration that **escapes heuristic
plateaus** — the failure mode on hard scavenger-style instances.

**Impact.** Med–High on hard/large satisficing problems; little on easy ones.
**Risk.** Low–Med (separate opt-in search mode; novelty-2 needs a compact pair
store). **Effort.** Med. *Research:*
[BFWS, Lipovetzky & Geffner](https://ojs.aaai.org/index.php/AAAI/article/view/11027/10886);
[LAMA+BFWS 2024](https://arxiv.org/abs/2404.17648).

### 9. Landmarks for GOAP (admissible LM-cut and/or count)

**What.** Extract fact/action landmarks; either **LM-cut** (admissible — could
strengthen the optimal `hmax` path) or **landmark-count** (inadmissible, greedy).

**Impact.** Med and **domain-dependent**. Prior analysis here: landmarks are
*complementary* to the symbolic hints already landed (both make the heuristic see
structure), but marginal for the current h_add-friendly suite; they shine on
landmark-rich domains we'd need to add. **Risk.** Med (LM-cut admissibility is
subtle; count must be opt-in). **Effort.** Med–High. Validate it beats h_add on a
landmark-rich domain *before* landing. *Research:* LM-cut (Helmert & Domshlak).

### 7. Node pooling / lazy child materialization

**What.** `goalSearch` allocates a `StateView`+delta `Map` per candidate *before*
the closed/heuristic prune may discard it (~10k discarded children/solve on
quarry). Compute the child hash incrementally from the effect writes, run the
`closed` check **before** committing the child, and pool discarded views.

**Impact.** Low–Med (~5–10% of GOAP). **Risk.** Med (incremental hashing is
correctness-sensitive). **Effort.** Med. Opportunistic — do it if touching
`goalSearch` anyway.

---

## Tier 3 — research-grade (watch / prototype, don't commit blindly)

### 6. Match-tree / lifted (join) successor generation

**What.** A precompiled decision tree over operator preconditions (Fast Downward
style), or full **lifted successor generation as a conjunctive-query/Datalog
join** (Powerlifted style), so per-node cost depends on *applicable* count, not
total ops, and **dynamic** relational preconditions are joined by the index.

**Impact.** Med — but **static-fluent pruning already captured the static-relation
case** (nav O(K⁴)→O(K²); the suite has no remaining dynamic-relational
bottleneck). Real value only when a domain joins two *changing* relations per
node, or when grounding itself explodes (lifted avoids grounding entirely).
**Risk.** Med (match tree) → High (lifted rewrite). **Effort.** High. **Trigger:**
build it when `bench:scale` shows a dynamic-relational domain regressing.
*Research:* [Lifted Planning survey, IJCAI 2024](https://www.ijcai.org/proceedings/2024/0886.pdf);
[Powerlifted](https://github.com/abcorrea/powerlifted);
[Lifted Successor Generation by Maximum Clique Enumeration].

### 10. Mutex / invariant synthesis

**What.** Infer mutual-exclusion groups / state invariants (h²-style or
monotonicity analysis), as SPEC §5.4 anticipates. **Impact.** Med as an
**enabler** — sharpens heuristics, shrinks grounding (collapse boolean groups to
enums), and underpins symmetry/POR (§11). **Risk/Effort.** Med/High. Foundational
but indirect; sequence before §11.

### 11. Partial-order reduction + symmetry elimination *(optimal search)*

**What.** Strong stubborn sets + symmetry (orbit) pruning. Research shows **>98%
of states pruned** in some optimal-planning domains. **Impact.** Med–High **but
only for optimal (`hmax`) search**; a real-time *greedy* engine benefits far less.
**Risk.** **High** — correctness-subtle (must provably preserve optimality &
completeness). **Effort.** High. Mostly relevant if optimal planning becomes a
first-class use case. *Research:* Wehrle & Helmert; "Faster Optimal Planning with
Partial-Order Pruning"; dominance pruning.

### 12. Red-black / partial delete relaxation

**What.** Interpolate between delete-relaxed and real planning by painting a
subset of variables "black" (real semantics). **Impact.** Med (more accurate h →
fewer expansions). **Risk.** High (black-variable planning can be intractable;
careful variable painting needed). **Effort.** High. *Research:*
[Red-black planning (Domshlak, Hoffmann, Katz)](https://www.sciencedirect.com/science/article/pii/S0004370214001581).

---

## Recommended sequencing

1. **One cheap-wins PR:** §13 regression CI + §7 if convenient.
2. **The satisficing-search PR:** §1 h_FF + §3 preferred operators (together;
   they share the relaxed-plan back-chain). Biggest expansion-count win,
   opt-in, low risk.
3. **The strategic PR:** §5 LLM-heuristic slot + harness — differentiated, low
   core risk, leans into what htn-ai *is*.
4. **The HTN PR:** §4 TDG/landmark heuristics — closes the biggest gap (the HTN
   half is uninformed).
5. **Then measure** and decide between §2 (incremental heuristic — hardest, but
   the deepest per-node win) and §8 (BFWS) based on which regime is hurting.
6. **Hold** §6/§10/§11/§12 until a benchmark demands them; keep `bench:scale` as
   the trigger.

### Cross-cutting guardrails

- **Heuristic changes are opt-in unless proven admissible** — the exact-optimal
  tests are the contract; never perturb the `hmax`+`w=1` path without an
  admissibility proof.
- **Every item ships with a benchmark** (a `bench:scale` row or a new domain) and
  must keep all tests' **expansion counts** explainable.
- **Prototype-before-land for uncertain wins** (§2, §9, §6) — measure it beats the
  status quo on a representative domain first, as we did for the worklist (which
  we reverted) and the relax hints (which we kept).

---

*Sources:*
[Lifted Planning survey (IJCAI 2024)](https://www.ijcai.org/proceedings/2024/0886.pdf) ·
[Powerlifted](https://github.com/abcorrea/powerlifted) ·
[Semi-Naive Datalog lifted planning (2026)](https://arxiv.org/html/2605.07584v1) ·
[Lifted Successor Generation in Numeric Planning (2025)](https://arxiv.org/pdf/2511.00673) ·
[BFWS](https://ojs.aaai.org/index.php/AAAI/article/view/11027/10886) ·
[LAMA + BFWS (2024)](https://arxiv.org/abs/2404.17648) ·
[Classical Planning with LLM-Generated Heuristics (NeurIPS 2025)](https://arxiv.org/abs/2503.18809) ·
[HTN Planning with LLM-Generated Heuristics](https://arxiv.org/html/2605.07707v1) ·
[Successor-Generator Planning with LLM Heuristics](https://arxiv.org/pdf/2501.18784) ·
[Landmark Generation in HTN Planning Revisited (ICAPS)](https://ojs.aaai.org/index.php/ICAPS/article/download/36123/38277/40196) ·
[PANDA framework](https://link.springer.com/article/10.1007/s13218-020-00699-y) ·
[Red-black planning](https://www.sciencedirect.com/science/article/pii/S0004370214001581) ·
[Faster Optimal Planning with Partial-Order Pruning](https://aaai.org/papers/00100-13562-faster-optimal-planning-with-partial-order-pruning/)
