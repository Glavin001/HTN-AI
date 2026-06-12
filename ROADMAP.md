# HTN-AI — Research & Roadmap Proposal

**Status: proposal, for discussion · June 2026 · Companion: [`SPEC.md`](./SPEC.md) (v2 software specification)**

> How this was produced: full review of the repo and all 5 open draft PRs (+ merged-PR trajectory and issue #13), followed by a five-angle research sweep (academic planning, LLM×planner hybrids, game-industry practice, JS/TS ecosystem, browser engineering) with adversarial verification of ~36 load-bearing claims against primary sources. Claims that failed verification are listed in §3.6 and not used elsewhere. All npm download figures are weekly, measured 2026-06-05 → 06-11; GitHub stars as of 2026-06-12.

---

## 1. TL;DR

**The goal — "best real-time advanced AI planner TypeScript web library" — is an open, winnable category.** Adversarially verified: there are exactly **three** TypeScript HTN repos on GitHub — the only production-grade one ([mahler](https://github.com/balena-io-modules/mahler), balena's infra-orchestration HTN) was **archived in 2025**, the second is dead since 2019, and the third is this repo. The largest JS GOAP library ever is an 88-star proof-of-concept. The closest spiritual competitor, [yuka](https://github.com/Mugen87/yuka) (1,344★, goal-driven game AI for three.js), hasn't shipped an npm release since **September 2022**. Meanwhile TS LLM-agent frameworks doing "planning" as LLM-written to-do lists move **15M+ downloads/week** combined (`ai` 12.45M, `@langchain/langgraph` 2.56M) with **zero plan semantics** — no preconditions, no validation, no simulation.

**The recommended bet — three pillars on one engine:**

1. **Real-time core** — budgeted, interruptible, anytime planning with plan *repair* (not just replanning) and guaranteed determinism. No planner anywhere — academic or commercial — ships a deadline-aware interruptible HTN; the IPC "agile" track only measures time-to-first-plan. This is the technical moat.
2. **Glass-box tooling** — an event-sourced decomposition trace feeding a live visual inspector ("why was this branch rejected?"), time-travel replay, blackboard diffing. Verified repeatedly: planners lost to behavior trees on *debuggability*, not algorithms, and every surviving planner product (Guerrilla's Decima, Maisak's UE plugin, crashkonijn's Node Viewer) leads with visual debugging. This is the adoption moat.
3. **LLM-native seams** — a validator/affordance/simulation API for LLM agents (the "sound critic" of LLM-Modulo), a declarative JSON domain schema LLMs can author and we can verify (issue #13's lifted operators are the foundation), and a ChatHTN-style "method-miss" hook where an LLM proposes decompositions that get verified, generalized, and cached. This is the growth market.

**What the five draft PRs got right:** the *direction* — generative action spaces (#9), predicate goals (#10), informed search (#11), an instruction→HTN compiler (#12), a classic-AI benchmark suite (#14). **What they got wrong:** the implementations (regressions hidden by edited tests, O(n²) "performance" features, fake parallelism, benchmarks that bypass the planner). Recommendation: close all five, collapse #9/#10/#11 into one unified-search refactor, and re-derive #12/#14 on top of new core primitives (§6).

**Decisions needed from us:** audience priority (games vs. LLM agents), package architecture, naming, FluidHTN-parity policy, HDDL timing, tooling business model (§7).

---

## 2. Where we are

### 2.1 What we have — and what's already right

The core is a faithful FluidHTN port: total-order forward decomposition with Method-Traversal-Record plan-priority comparison, partial plans/slots, dirty-flag replanning, three-tier effect semantics (`Permanent`/`PlanAndExecute`/`PlanOnly`), plus post-fork additions: strong generics over world state, utility selectors, and GOAP sequences with dynamic costs.

Two findings from the research validate this foundation:

- **Total-order progression search is the *winning* paradigm, not a pragmatic compromise.** At [IPC 2023's HTN tracks](https://ipc2023-htn.github.io/results), PandaDealer won all three total-order tracks — and the partial-order Agile/Satisficing tracks were won by planners that *linearize PO problems into TO* and hand them to TO planners. [HyperTensioN](https://github.com/Maumagnaguagno/HyperTensioN) (Ruby!) won IPC 2020's TO track, proving dynamic-language planners can be competition-grade.
- **FluidHTN's reactive machinery (MTR, partial plans, replan-only-if-better) is the industry-validated answer to GOAP's replan-churn problem** — the exact complaint that made AAA abandon GOAP.

### 2.2 What the drafts were reaching for

All five open PRs are Codex-generated drafts; #9–#12 share one base commit and mutually conflict. Read as signals rather than code:

| PR | Surface | Underlying goal |
|---|---|---|
| [#9](https://github.com/Glavin001/HTN-AI/pull/9) Dynamic successors | `.generate(fn)` merges generated children into HTN/GOAP | **Parameterized actions** — action sets as a function of state (movement graphs, doors, deliveries); PDDL-style grounding |
| [#10](https://github.com/Glavin001/HTN-AI/pull/10) Custom goal satisfaction | `goalEvaluator` on GOAP sequences | **Predicate goals** — "at least N", inequalities; exact numeric equality is toy-only |
| [#11](https://github.com/Glavin001/HTN-AI/pull/11) GOAP heuristics + weighted A* | `.goapHeuristic(fn)`, `.goapHeuristicWeight(w)` | **Informed, bounded-suboptimal search** — "good plan fast" anticipating frontier explosion from #9 |
| [#12](https://github.com/Glavin001/HTN-AI/pull/12) Goal planning API | `GoalProgram` AST (`DoInOrder`, `WhileConditionHolds`, `WithOperators`…) compiled to domains; 1,647-line robot-sim test with deadlines, constraint stacks, escort/follow | **An instruction language that compiles to reactive HTN execution** — the clearest signal: built for an LLM-instructs-agent pipeline |
| [#14](https://github.com/Glavin001/HTN-AI/pull/14) Puzzle scenarios | 15 classic problems (sokoban, blocks world, river crossing, sudoku…) | **A benchmark suite** measuring the library against general problem solving |
| [Issue #13](https://github.com/Glavin001/HTN-AI/issues/13) | Lifted operators, axioms, predicate register, lazy grounding | **Expressive, declarative domains** — the formal foundation #9/#10 approximate ad-hoc |

Tellingly, every #14 puzzle "solution" is hand-scripted inside operators (BFS inside a single action; the river-crossing solution hard-coded as seven fixed actions) because the planner on `main` cannot derive them. The benchmark suite is a to-do list, and #12's `ScenarioContext` (deadline stacks, scoped constraints, cleanup-on-abort emulated via operator callbacks) is a to-do list for the core `Context`/`Planner`.

### 2.3 Architectural debts that block the vision

1. **Closures everywhere.** Conditions/effects/goals are opaque functions — no introspection, serialization, diffing, or explanation. This is the single biggest blocker for LLM-authored domains, the visual inspector, and save-games. (Issue #13 is the right fix.)
2. **No search engine, three ad-hoc searches.** `src/Tasks/goapSequenceTask.ts` is a linear-scan open list (no priority queue), JSON-stringify visited-set keys, full world-state snapshots per node, and `Object.assign` virtual contexts. #9/#10/#11 each rewrite the same ~80 lines.
3. **Unbounded, synchronous planning.** `Domain.findPlan` runs to completion on the calling thread; `Planner.tick` recursively self-invokes on immediate replans. No budget, no resumability (beyond authored `PausePlanTask`), no cycle detection — and A*-style TO-HTN search is **provably incomplete** without visited/cycle checking ([Yousefi, Schmautz, Haslum & Bercher, ICAPS 2025](https://ojs.aaai.org/index.php/ICAPS/article/view/36107)).
4. **No scoped execution semantics.** No try/finally for plans: when an executing condition fails, `abortCurrentTask` wipes the whole plan and any cleanup is the operator's problem. #12 had to emulate scopes with closure state on shared task instances (which breaks multi-agent domain sharing).
5. **GC-hostile state model.** String-keyed record world state with per-key change stacks; GOAP search clones everything. Fine for dozens of agents; will not survive real search spaces or hundreds of agents.
6. **Incomplete public API & packaging.** `CompoundTask`, `Slot`, `PausePlanTask`, GOAP/utility types unexported from `src/index.ts`; `package.json` `repository`/`homepage`/`bugs` still point at `TotallyGatsby/GamePlanHTN` (misdirecting npm provenance and the dependents graph); CI targets Node 16/18.
7. **No observability.** Debug output is strings (`DecompositionLog`, `MTRDebug`); planner callbacks exist but there's no structured, serializable trace of *why* decisions were made.

---

## 3. What the research says

### 3.1 The market gap (verified)

| Niche | Leader | Status (verified 2026-06) |
|---|---|---|
| TS HTN | **this repo** (3★, 19 dl/wk) | mahler **archived** 2025 (12 dl/wk); benjohns1/htn-planner dead since 2019. GitHub TS-HTN search returns exactly 3 repos. |
| JS GOAP | wmdmark/goap-js 88★ | "Proof-of-concept," no substantive work since ~2017–18; 2025-era TS GOAP libs are 1–3★ |
| JS game-AI suite | yuka 1,344★, 4.3k dl/wk | **No npm release since 2022-09**; goal-driven layer but no HTN/GOAP. The category throne is vacant. |
| JS behavior trees | behaviortree 1.7k dl/wk; mistreevous 133★ (active, has web visualizer); fluent-behavior-tree 2.1k dl/wk (last publish **2017**) | Adoption ceiling for the niche ≈ low-thousands dl/wk; maintenance itself is a differentiator |
| FSM/statecharts | **xstate 4.50M dl/wk** | No planner; `@statelyai/agent` stalled (last prerelease 2025-02) → interop target, not competitor |
| TS LLM-agent frameworks | `ai` 12.45M, `@langchain/langgraph` 2.56M, `@openai/agents` 1.03M, `@mastra/core` 887k dl/wk | "Plan-and-execute" = LLM writes a step list; zero preconditions/effects/search anywhere. **Plan representation without plan semantics.** |
| Durable execution | `@temporalio/workflow` 2.09M, `inngest` 1.26M dl/wk | Execute plans but don't generate them — "planner in front, durable executor behind" is an unshipped integration |
| Movement layer | pathfinding 85.7k, three-pathfinding 32.8k dl/wk | Execution-layer AI sustains six-figure downloads; the *decision layer above it* is the empty shelf |
| C#/engine planners | FluidHTN 439★ (v0.4.1, 2026-02); crashkonijn GOAP 1,733★ (job-system threaded + Node Viewer debugger, demos **2,000 agents**); Maisak HTN UE plugin (shipped in **Metro Awakening**, 2024) | Demand for planners persists cross-engine; winners win on **threading + visual debugging** |
| In-browser solvers | z3-solver 57k dl/wk, clingo-wasm 1.7k | npm-installed heavyweight solvers are normal; no planning-specific one exists. Academic planning's answer is cloud APIs (solver.planning.domains: 10s/500MB legacy limits) — useless per-frame. |

Demand-side evidence: [AI Town](https://github.com/a16z-infra/ai-town) (10,001★, TypeScript) runs agents on a rule-based tick loop + LLM calls — zero hits for "planner" or "behavior tree" in the repo; [Excalibur.js published a build-your-own-GOAP tutorial](https://excaliburjs.com/blog/goal-oriented-action-planning/) (2024) because nothing existed to install; Altera's [Project Sid](https://arxiv.org/abs/2411.00114) (10–1000+ Minecraft agents) names *spatial reasoning and physical coordination* — exactly what planners do — as its primary limitation.

### 3.2 Why planners lost — and what fixes it

The canonical practitioner history: AAA studios abandoned GOAP because it "requires too much babysitting" — replan churn, unpredictable emergent plans, hard QA. Behavior trees won on *control and debuggability*, not capability. Every planner that survived treats inspection as the product:

- Guerrilla's [HTN in the Decima engine](https://www.guerrilla-games.com/read/htn-planning-in-decima) (Killzone → Horizon; talk Nov 2024): headline features are the **flow visualization of precondition backtracking** and **in-game decomposition debugging** (plus domain-language → generated C++).
- [Maisak's UE HTN plugin](https://maksmaisak.github.io/htn/front.html) (backbone of Metro Awakening's enemy AI): graph editor, **breakpoints with planned-worldstate inspection**, per-frame plan recording in Unreal's Visual Logger, EQS spatial queries *during planning*.
- [crashkonijn GOAP](https://github.com/crashkonijn/GOAP): the most-starred OSS game planner wins on **multithreading + the Node Viewer**.
- Epic's trajectory: [StateTree](https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-state-tree-in-unreal-engine) (selection **on-demand** instead of BT-style continuous re-evaluation → predictable per-tick cost) is on the official roadmap as "Production-Ready StateTree", while Epic's own in-engine `HTNPlanner` plugin has sat "[EXPERIMENTAL]", undocumented, for years. Even Epic believes in the algorithm and hasn't built the tooling.
- Same pattern in JS: behavior3's editor outstars its runtime; mistreevous's visualizer is its main asset; [XState/Stately](https://stately.ai/blog/2023-11-20-stately-studio-2-0) built a business on "free inspector → paid visual studio".

**Implication:** the inspector is not an accessory; it is co-equal with the engine. "Too much babysitting" is fixed by *showing the babysitter everything*.

### 3.3 The LLM era assigns us a seat

The verified division of labor (2023–2026 literature + shipped products):

| Function | Proven owner | Evidence |
|---|---|---|
| Goal selection, persona, strategy | LLM (even 0.5–8B SLMs) | [NVIDIA ACE](https://www.nvidia.com/en-us/geforce/news/nvidia-ace-autonomous-ai-companions-pubg-naraka-bladepoint/) autonomous teammates (PUBG Ally on Mistral-NeMo-Minitron-8B; inZOI; NARAKA mobile): "given the finite actions that can be taken in the game, the SLM can choose the best appropriate action" — game code executes |
| Domain/method authoring | LLM drafts → **symbolic validates** → LLM repairs | The dominant working pattern per the [ACL 2025 formalizers survey](https://aclanthology.org/2025.findings-acl.1291/), which names **HTN as a gap** no tool covers; [LLM+P](https://arxiv.org/abs/2304.11477), [NL2Plan](https://arxiv.org/abs/2405.04215) |
| Decomposition fallback | LLM proposes when no method applies; planner **verifies**; system generalizes & caches | [ChatHTN](https://arxiv.org/abs/2505.11814) (provably sound; NeuS 2025) + [online method learning](https://arxiv.org/abs/2511.12901) that amortizes LLM calls toward zero |
| Search heuristics | LLM writes code **offline**; planner runs it online | [LLM-generated HTN heuristics](https://arxiv.org/abs/2605.07707): Claude-Opus-4-written heuristics solved 131/139 IPC-2020 TO problems vs PANDA RC^FF's 134, with less search on 83% of instances |
| Plan validation / critique | **Symbolic only** | LLM self-critique *degrades* plans; sound external verification restores/improves them ([Stechly et al. 2024](https://arxiv.org/abs/2402.08115)) — and the *soundness* of the verifier, more than feedback richness, is the active ingredient |
| Real-time execution & replanning | Symbolic, always | o1-preview: 97.8% on Blocksworld but 52.8% obfuscated, 23.6% on 20–40-step plans, **$42 per 100 instances vs Fast Downward's 100% at ~0.27s avg** ([Valmeekam et al. 2024](https://arxiv.org/abs/2409.13373)); GOAP explicitly used to mask LLM latency ([IEEE CoG 2024](https://ieeexplore.ieee.org/document/10645549)) |

Two honesty notes that shape the pitch:

- **Don't build the positioning on "LLMs can't plan."** The May 2026 revision of [arXiv 2511.09378](https://arxiv.org/abs/2511.09378) ("Frontier LLMs Rival State-of-the-Art Planners") reports Gemini 3.1 Pro solving 245/360 freshly generated, VAL-verified tasks vs 234 for the strongest classical baseline. The durable case is **latency, cost, determinism, auditability, and guarantees at runtime** — true regardless of offline LLM skill.
- **The architecture every shipped system converges on** (Stanford generative agents' regenerate-from-interruption, AI Town's sync-tick/async-LLM split, ACE's SLM-over-finite-actions): *slow asynchronous cognition above, fast synchronous execution below*. The library's job is to be the bottom layer — and today, in TypeScript, that layer literally does not exist.

### 3.4 Algorithms: adopt vs. watch

**Mature — adopt:**
- **Goal+task unification** ([GTPyhop](https://github.com/dananau/GTPyhop) semantics): one totally-ordered progression engine where the agenda holds both tasks (HTN decompose) and goals (GOAP search) — the principled merge of our two halves, replacing the `goap_sequence` special case.
- **Cycle detection / visited checking** in decomposition (required for completeness — ICAPS 2025), plus the IPC-2023 winner's [precondition/effect look-ahead pruning](https://www.uni-ulm.de/fileadmin/website_uni_ulm/iui.inst.090/Publikationen/2023/Olz23PandaDealer.pdf).
- **Anytime weighted A* (ARA*-style)** for goal search: first plan fast at high ε, improve under remaining budget, explicit suboptimality bound.
- **Plan repair over replanning** for small perturbations (repair is faster and more plan-stable — [Fox et al. 2006](https://lpg.unibs.it/lpg/pubblications/ICAPS06.pdf)), with the decomposition-trace/backtrack approach validated as cheapest-overhead among repair algorithms ([Zaidins et al., ICAPS 2025](https://arxiv.org/abs/2504.16209)); fall back to full replan on large deltas.
- **Novelty-1 tiebreaking** on open lists (BFWS/IW line) — a few lines, escapes heuristic plateaus.
- **HDDL** ([Höller et al., AAAI 2020](https://ojs.aaai.org/index.php/AAAI/article/view/6542)) as interchange: official IPC language; parsers exist in C++/Rust/Ruby/Python and **none in JS/TS** — a TS parser is first-of-kind and unlocks ~30 IPC domains as a correctness/perf harness against PANDA.
- **GDA-style execution loop** (expectations on steps → discrepancy detection → goal re-selection) as the layer above the planner.

**Research-grade — watch, don't build:** lifted SAT-based HTN (Lilotane), TOAD-style compilation to classical planning, learned HTN heuristics (AAAI 2025 — note: hand-coded heuristics remain practical SOTA), FOND policy synthesis, MCTS-HTN hybrids (viable per SoCS 2020 but unproven in real-time), HDDL 2.1 temporal extensions.

### 3.5 Browser/runtime engineering facts

- **Time-slicing:** generator-based stepping with per-slice budget checks is the proven JS pattern (js-coroutines); [`scheduler.yield()`](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield) resumes at the front of its priority level's queue but is Chromium-only — feature-detect, don't depend.
- **Workers:** plans/world-deltas are <10KiB plain data → plain `postMessage` is risk-free at 60fps ([Surma's benchmarks](https://surma.dev/things/is-postmessage-slow/)); SharedArrayBuffer requires COOP/COEP cross-origin isolation (deployment-hostile; `require-corp` is the only broadly compatible COEP) → **worker support yes, SAB opt-in only**.
- **WASM:** the [Zaplib post-mortem](https://zaplib.com/docs/blog_post_mortem.html) — incremental Rust/WASM ports yielded "~2x some of the time, not 10x most of the time" (one sim port: +5%) — well-written typed-array TS is defensible. A pure-TS core also keeps the no-toolchain DX. WasmGC is now baseline everywhere and Wasm 3.0 complete (Sept 2025) if we ever revisit.
- **GC is the real enemy:** pool plan/task/search nodes; offer a compact state backend (typed arrays/bitsets — bitECS-style SoA is the JS-game norm; FluidHTN itself uses a byte-array world state for exactly this reason).
- **Determinism is cheap and compounding:** seeded injected RNG + stable orderings ⇒ lockstep-multiplayer-safe, replayable traces, snapshot-diff debugging. (JS hazards: `Math.random`, implementation-defined `Math.sin/pow`, Map iteration order.)
- **Serialization pattern from shipped middleware:** persist world state + active goals as JSON, **replan on load** — never snapshot mid-decomposition. Keeps everything structured-clone-safe for workers too.
- **Throttle by default:** decision/replan cadence of 5–10Hz staggered across agents, planning budget ~1–2ms/frame — the qualitative consensus across game-AI practice (precise public benchmark numbers don't exist; see §3.6).

### 3.6 Claims we checked and rejected

For intellectual honesty, findings that did **not** survive adversarial verification, and are *not* relied on above:

- ❌ "PANDA swept all six IPC 2023 HTN tracks" → PandaDealer won the three TO tracks; PO Agile/Satisficing went to linearization-based planners; PANDApro took PO-Optimal (4/6 PANDA-family).
- ❌ "ICAPS 2025 found repair beats replanning" → that's [Fox et al. 2006](https://lpg.unibs.it/lpg/pubblications/ICAPS06.pdf); the 2025 paper compares *which repair algorithm* wins.
- ❌ A widely-surfaced May 2026 Unity benchmark ("GOAP 12.4ms at 50 agents…") → source is a high-volume AI-generated SEO blog, no methodology/hardware/code; numbers treated as fabricated. No credible public planner-vs-BT frame-time data exists — an opportunity for *us* to publish the reference benchmark.
- ❌ "A 2024 IEEE ToG hybrid HTN-GOAP paper" and "AIIDE 2025 LLM-GOAP paper" → could not be traced to primary sources; excluded.
- ⚠️ "No TS/JS HDDL parser exists" → universal negative; held up under thorough GitHub/npm search (the one TS hit is a VS Code client around a Rust language server).

---

## 4. Positioning

> **HTN-AI is the real-time planning and execution runtime for TypeScript agents — the deterministic, debuggable action layer that sits under LLM cognition and above your world.**

Three concentric audiences, one engine:

1. **Web/TS game developers** (Phaser, Excalibur, Babylon, three.js communities) — the beachhead that proves real-time credibility. Today they hand-roll FSMs or port GOAP from tutorials.
2. **Agent-sim builders** (AI Town forks, Minecraft/Mineflayer bots, colony/social sims) — need many cheap concurrent planners with explainable traces; currently brute-force with if-statements and LLM calls.
3. **LLM-agent builders** (LangGraph.js / Vercel AI / Mastra users) — the 100–1000× larger adjacent market that has plan *representations* but no plan *semantics*. We are the verifier and executor under their cognition loop.

**What we are not** (scope discipline): not an optimal/partial-order academic planner; not a behavior-tree library; not an LLM client (hooks accept *your* model — the core never calls a provider); not a pathfinding library (we integrate with `pathfinding`/`three-pathfinding`/recast as executors); not (initially) a visual *editor* — inspector first, authoring later.

---

## 5. Capability roadmap

Phases are sequential but overlappable; each lists **what**, **why (evidence)**, and **done-when**.

### P0 — Foundations: one engine, declarative bones *(prerequisite for everything)*

- **Unified search core.** Extract a single engine: agenda of tasks *and* goals (GTPyhop semantics); pluggable `{successors, isGoal, heuristic, cost}`; binary-heap open list with f computed at push; hashed visited set with **cycle detection** (completeness requirement); object-identity child semantics. `select`/`sequence`/`utility_select`/`goap_sequence` become thin configurations. This single refactor *replaces* PRs #9, #10, #11.
- **Declarative IR for conditions/effects/goals** (= issue #13, phase 1): predicate registry, lifted operators with typed parameters, lazy grounding via successor generation; closures remain as an escape hatch (`FuncCondition` et al.), but data-form domains are fully JSON-serializable and introspectable. Goals become a union: state-record | predicate-expression.
- **Context v2:** pluggable state backends — ergonomic object record (default) and compact typed-array/bitset backend (perf); copy-on-write search snapshots + state hashing (kills `serializeWorld` JSON keys); remove the non-generic casts gluing `utilitySelectorTask`/`goapSequenceTask` to bare `Context`.
- **Hygiene:** export `CompoundTask`/`Slot`/`PausePlanTask`/GOAP & utility types from `src/index.ts`; fix `package.json` `repository`/`homepage`/`bugs` → `Glavin001/HTN-AI` (npm currently credits the upstream fork); CI Node 20/22/24; add a `tinybench` micro-benchmark suite; ask FluidHTN to list htn-ai among its README ports (free distribution).
- **Done when:** FluidHTN-parity tests stay green; #14's sokoban / blocks world / water jug / river crossing are solved **by search** (no scripted operators) through `Planner.tick`; bunker/FPS domains plan with ≥10× node throughput vs. today's GOAP path (measured).

### P1 — Real-time core: the technical moat

- **Budgeted, resumable planning.** `planner.tick(domain, ctx, { budgetMs })` / generator-based `session.step(budget)`: decomposition and goal search pause mid-stream and resume next tick (generalizing the existing partial-plan machinery). No academic or commercial HTN ships this; IPC "agile" only measures time-to-first-plan.
- **Anytime improvement.** ARA*-style: emit first valid plan fast (high ε / depth-first decomposition), keep improving while budget remains, expose the suboptimality bound. Add novelty-1 tiebreaking and PandaDealer-style look-ahead pruning as cheap accelerators.
- **Plan repair.** Keep the decomposition trace; on execution failure or world delta, backtrack from the failure point and re-decompose minimally (IPyHOPPER pattern); fall back to full replan above a perturbation threshold (Fox 2006). Pairs with the existing MTR replan-only-if-better logic.
- **Scoped execution semantics.** First-class enter/exit (try/finally) scopes, deadlines, and `maintain` conditions in `Context`/`Planner` — promoting what #12 emulated in test code; this is also what makes a *real* `DoInParallel` (multiple intention lanes, BDI-style) possible later.
- **Determinism.** Injected seeded RNG, stable orderings everywhere, documented hazards; replay = initial state + event log.
- **Multi-agent scheduler.** One shared (immutable) domain, N contexts; round-robin replan staggering with a global budget pool; per-agent cadence (LOD).
- **Async operator adapter.** Operators stay sync in the core loop; an adapter maps Promise-returning operators (LLM/tool calls) onto `TaskStatus.Continue` lanes — the AI-Town sync-tick/async-cognition split as a library primitive.
- **Done when:** planning honors a 0.5ms budget without dropped frames in a browser demo; repair beats replan on perturbation benchmarks (cost + plan stability); two runs with the same seed produce byte-identical traces; 100+ agents plan concurrently in the demo sim.

### P2 — Glass-box tooling: the adoption moat

- **Event-sourced trace (the contract).** Every decision emits structured events: task tried, condition evaluated (which predicate, result), method chosen/rejected (why), MTR comparison outcome, node expanded, plan emitted/repaired/aborted. Serializable, replayable, versioned — the foundation for *everything* below and for `explainFailure`.
- **Inspector (`@htn-ai/devtools`).** Browser panel fed by trace events (BroadcastChannel/WebSocket): live decomposition graph with active-branch highlighting (React Flow + dagre/elkjs), **why-rejected explanations**, blackboard/world-state diff view, time-travel scrubber, per-agent selection. Embeddable in any host app.
- **Why this bar:** Decima's flow visualization, Maisak's breakpoints + per-frame recording, crashkonijn's Node Viewer, Unreal BT's live debugger, Stately's inspector — every winner in this space; and in JS the editor/visualizer repeatedly outdraws the runtime (behavior3, mistreevous).
- **Done when:** a first-time user can answer "why didn't the agent do X?" from the inspector alone, on the demo, without reading library code; traces round-trip (record → file → replay).

### P3 — LLM-native seams: the growth market

- **Validator-first API** (the LLM-Modulo "sound critic"): `validatePlan(domain, state, plan)` → typed diagnoses (unsatisfied precondition, step, binding); `simulate(plan, state)` dry-run; `applicableActions(state)` / `applicableGoals(state)` affordance queries (the SayCan→ACE invariant: models choose among *verified-applicable* options). Soundness is the proven active ingredient; diagnoses also feed human tooling.
- **LLM-authorable domains.** JSON Schema for the declarative IR with **incremental, per-element validation** and human-readable errors (the generate→validate→repair loop is the field's dominant pattern; HTN named as the gap by the ACL 2025 survey); NL rendering of domains/plans for prompting; domain diffing.
- **ChatHTN-style method-miss hook.** `onDecompositionMiss(async (task, state) => proposal)`: planner pauses that branch (partial-plan machinery), verifies the proposal by simulation, executes — and optionally **lifts/generalizes and caches** it as a reusable method with provenance, amortizing LLM calls toward zero (the 2025 result line).
- **Heuristic harness.** Sandboxed `(state, agenda) => number` heuristic slot + an evaluation harness over benchmark domains (LLM-written heuristics rival PANDA's; cross-model variance demands measurement).
- **Orchestrator bridges.** Export plans as dependency DAGs/step lists for LangGraph.js / Vercel AI tools; "planner in front, durable executor behind" recipes for Temporal/Inngest.
- **Done when:** a scripted demo shows an LLM (mocked in CI) authoring a domain extension that's rejected→repaired→accepted; method-miss demo solves a task no static method covers, then solves it again with zero LLM calls; one agent-framework integration published.

### P4 — Interop, scale & reach

- **HDDL import/export** (TO fragment) + an IPC benchmark harness in CI comparing against PANDA reference plans — first-of-kind in JS/TS, and it makes our correctness claims testable.
- **Worker adapter** (Comlink-style; plain postMessage payloads; SAB opt-in).
- **Ecosystem adapters:** XState interop (planner drives statechart actors — 4.5M dl/wk surface), ECS systems for bitECS/miniplex, plugins for Phaser/Excalibur, executor bridges to pathfinding libs.
- **The demo that markets itself:** a browser-playable agent-sim (AI-Town-like village or a colony vignette) with the inspector docked — every adopted library in this space won attention through a visual demo; ours doubles as the LLM-integration showcase.
- **Done when:** ≥20 IPC domains import and validate; the demo runs 100+ planning agents at 60fps on a mid-range laptop with the inspector live; two engine adapters + one agent-framework adapter shipped.

---

## 6. Open PRs & issue — dispositions

| Item | Disposition | Salvage |
|---|---|---|
| #9 dynamic successors | **Close.** Name-based child dedup breaks replan semantics (`tests/selectorTask.ts` expectations were edited to absorb the regression); repeated unmemoized `getChildren()`; `Parent` mutation during planning | Successor-generation concept → P0 lifted operators/lazy grounding; the `WorldStateBase` typing overhaul of the GOAP path |
| #10 goal evaluators | **Close.** Vestigial mandatory goal record; evaluator receives the live context (wrong state during search) | Predicate goals → P0 goal union |
| #11 heuristics/weighted A* | **Close.** Recomputes f for every open node on every pop (O(n²) + a fresh virtual context each evaluation); no heap | Heuristic API + sanitization + README admissibility docs → P0/P1 search config |
| #12 goal-program compiler | **Close; re-derive.** `DoInParallel` compiles to a sequence; exit/cleanup emulation never runs on abort; closure state on shared tasks breaks multi-agent | The AST/compiler kernel pattern and the *concepts* (deadlines, constraint scopes, maintain) → P1 scoped execution + a future `programs` layer; it's the embryo of the LLM-instruction story |
| #14 puzzle scenarios | **Close; re-derive.** Solutions are hand-scripted in operators; `executePlan` bypasses `Planner` entirely | The benchmark suite idea + typed world-state modeling → P0 done-criteria & P4 harness, executed via `Planner.tick` |
| Issue #13 lifted operators/axioms/lazy grounding | **Keep — promote.** This is the architectural keystone | Becomes the P0 declarative-IR workstream (and the P3 LLM-authoring surface) |

Also recommended: collapse the three GOAP-search drafts' intent into **one** tracking issue ("unified search core") so the history is legible.

---

## 7. Open questions — to align on

1. **Audience emphasis: games-first or agents-first?** One core either way; this decides docs, demo, and launch narrative. *Recommendation:* build the real-time core on game-sim credibility (it's falsifiable and demo-able), but market "the action layer under your LLM agent" — the agents market is orders of magnitude larger and provably underserved.
2. **Package architecture.** Single `htn-ai` vs. scoped monorepo (`htn-ai` core + `@htn-ai/devtools`, `/react`, `/langgraph`, `/phaser`, `/hddl`). *Recommendation:* monorepo with a small, dependency-free core; adapters as separate packages.
3. **Naming/branding.** "htn-ai" names the implementation technique, not the value; "ai" suffix is noisy in 2026. Worth a rename before traction exists (downloads are ~19/wk, so the cost is near-zero)? Candidates worth brainstorming around "plan/intent/resolve" concepts. *No recommendation yet — discuss.*
4. **FluidHTN parity policy.** Parity tests are an asset; the v2 engine will deviate (unified search, IR). *Recommendation:* keep parity for v1.x in maintenance; declare v2 semantics ours, with a migration guide.
5. **HDDL timing.** P4 in this proposal; pulling it into P0 would give an immediate correctness harness but delays the moat work. *Recommendation:* a minimal HDDL *reader* for ~5 IPC domains early (test-only, not public API), full interop in P4.
6. **Tooling business model.** Inspector OSS forever; is a hosted/collaborative studio (Stately model) a future intent? Affects trace-format licensing and how much polish the OSS inspector gets. *Discuss.*
7. **Public performance claims.** No credible public planner benchmarks exist (§3.6) — do we commit to publishing a reproducible benchmark suite (agents × budget × domain) as a flagship asset? *Recommendation:* yes; it's cheap given P0's bench harness and nobody else has it.

---

## 8. Appendix — key sources

**Repo trajectory:** merged #4 (TS port) → #5 (packaging) → #6/#8 (typed state) → GOAP/utility commits → #7 (FPS scenarios); drafts #9–#12 (2025-11), #14 (2026-06); issue #13.

**Academic:** [IPC 2023 HTN results](https://ipc2023-htn.github.io/results) · [PandaDealer](https://www.uni-ulm.de/fileadmin/website_uni_ulm/iui.inst.090/Publikationen/2023/Olz23PandaDealer.pdf) · [HDDL (AAAI 2020)](https://ojs.aaai.org/index.php/AAAI/article/view/6542) · [A* incompleteness for TO-HTN (ICAPS 2025)](https://ojs.aaai.org/index.php/ICAPS/article/view/36107) · [HTN repair comparison (ICAPS 2025)](https://arxiv.org/abs/2504.16209) · [Fox et al. 2006](https://lpg.unibs.it/lpg/pubblications/ICAPS06.pdf) · [GTPyhop](https://github.com/dananau/GTPyhop) · [HyperTensioN](https://github.com/Maumagnaguagno/HyperTensioN) · [Width-based planning](https://arxiv.org/abs/1801.03354) · [MCTS in HTN (SoCS 2020)](https://fai.cs.uni-saarland.de/wichlacz/papers/socs20.pdf)

**LLM×planning:** [LLM-Modulo (ICML 2024)](https://arxiv.org/abs/2402.01817) · [LRMs on PlanBench](https://arxiv.org/abs/2409.13373) · [Frontier LLMs rival planners (v2 2026)](https://arxiv.org/abs/2511.09378) · [Self-verification limits](https://arxiv.org/abs/2402.08115) · [ChatHTN](https://arxiv.org/abs/2505.11814) · [Online HTN method learning](https://arxiv.org/abs/2511.12901) · [LLM-generated HTN heuristics](https://arxiv.org/abs/2605.07707) · [Formalizers survey (ACL 2025)](https://aclanthology.org/2025.findings-acl.1291/) · [Generative agents](https://arxiv.org/abs/2304.03442) · [Project Sid](https://arxiv.org/abs/2411.00114) · [LLM Reasoner + planner NPCs](https://arxiv.org/abs/2501.10106)

**Industry:** [HTN in Decima (Guerrilla)](https://www.guerrilla-games.com/read/htn-planning-in-decima) · [Maisak HTN plugin](https://maksmaisak.github.io/htn/front.html) · [Game AI Pro ch.12 (Humphreys)](https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter12_Exploring_HTN_Planners_through_Example.pdf) · [StateTree](https://dev.epicgames.com/documentation/en-us/unreal-engine/overview-of-state-tree-in-unreal-engine) · [NVIDIA ACE autonomous characters](https://www.nvidia.com/en-us/geforce/news/nvidia-ace-autonomous-ai-companions-pubg-naraka-bladepoint/) · [crashkonijn GOAP](https://github.com/crashkonijn/GOAP) · [FluidHTN](https://github.com/ptrefall/fluid-hierarchical-task-network)

**Ecosystem & engineering:** [mahler (archived)](https://github.com/balena-io-modules/mahler) · [yuka](https://github.com/Mugen87/yuka) · [AI Town architecture](https://github.com/a16z-infra/ai-town/blob/main/ARCHITECTURE.md) · [Excalibur GOAP tutorial](https://excaliburjs.com/blog/goal-oriented-action-planning/) · [LangGraph plan-and-execute](https://www.langchain.com/blog/planning-agents) · [Is postMessage slow? (Surma)](https://surma.dev/things/is-postmessage-slow/) · [COOP/COEP](https://web.dev/articles/coop-coep) · [scheduler.yield](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield) · [Zaplib post-mortem](https://zaplib.com/docs/blog_post_mortem.html) · [Wasm 3.0](https://webassembly.org/news/2025-09-17-wasm-3.0/) · [Stately Studio](https://stately.ai/blog/2023-11-20-stately-studio-2-0) · [bitECS](https://bitecs.dev/docs/introduction) · [js-coroutines](https://github.com/miketalbot/js-coroutines)
