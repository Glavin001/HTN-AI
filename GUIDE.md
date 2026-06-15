# The htn-ai Guide

A complete, practical guide to **htn-ai** — a real-time AI planning & execution
runtime for TypeScript. This document teaches everything you need to use the
library, building from a five-line example to multi-agent, temporally-constrained,
self-repairing real-world scenarios.

It is written against the v2 source (`src/`) and mirrors the behaviour pinned by
the test suite (`tests/`). Every code block here is the same shape as code that
the tests actually run.

---

## Table of contents

1. [What this library is (and the mental model)](#1-what-this-library-is)
2. [Install & import](#2-install--import)
3. [The pipeline at a glance](#3-the-pipeline-at-a-glance)
4. [Your first plan (5 minutes)](#4-your-first-plan)
5. [Fluents: the world's state](#5-fluents-the-worlds-state)
6. [Types, entities & world setup](#6-types-entities--world-setup)
7. [Formulas: conditions over the world](#7-formulas-conditions-with-f)
8. [Numeric expressions](#8-numeric-expressions-with-n)
9. [Effects: how operators change the world](#9-effects-with-e)
10. [Operators: the primitive actions](#10-operators)
11. [Goals vs. tasks: the two ways to ask](#11-goals-vs-tasks)
12. [HTN methods: hierarchy, ordering, utility, free variables](#12-htn-methods)
13. [Axioms: derived predicates](#13-axioms-derived-predicates)
14. [Goal search: heuristics, weight, novelty, optimality](#14-goal-search-tuning)
15. [Temporal-lite: durations, deadlines, scopes, waits](#15-temporal-lite)
16. [Planning APIs: `planOnce` & budgeted `PlanningSession`](#16-planning-apis)
17. [Execution: the reactive `Planner`](#17-execution-the-reactive-planner)
18. [Writing executors (the `ExecutorApi`)](#18-writing-executors)
19. [Reactivity, replan-if-better, repair & drift](#19-reactivity-repair--drift)
20. [Multi-agent scheduling](#20-multi-agent-scheduling)
21. [Validation, simulation & explanation (LLM-ready)](#21-validation-simulation--explanation)
22. [Escape hatches: externals (T2) & opaque (T3)](#22-escape-hatches-externals--opaque)
23. [Determinism & serialization](#23-determinism--serialization)
24. [Worked complex scenarios](#24-worked-complex-scenarios)
25. [API cheat sheet](#25-api-cheat-sheet)
26. [Pitfalls & gotchas](#26-pitfalls--gotchas)

---

## 1. What this library is

htn-ai answers one question repeatedly and fast: **"Given the world as it is now,
what should I do next?"** — and then it *does it*, watches the world, and revises
the plan when reality diverges.

It unifies two classic AI-planning paradigms in a single engine:

- **HTN (Hierarchical Task Network)** — you write *methods* that decompose an
  abstract task ("Raid the bunker") into ordered subtasks. This is how you
  encode know-how and authored structure.
- **GOAP-style goal search** — you state a *goal condition* ("the box is at
  c5") and the engine searches over your operators (weighted-A\* with a
  relaxation heuristic) to find an action sequence. This is how you get
  emergent, unscripted solutions.

You can mix them freely: an HTN method can contain an `achieve(...)` subgoal that
is solved by search, and a top-level request can be either a task or a goal.

**The division of labour.** You (or an LLM) decide *what* to want and supply the
domain rules. htn-ai guarantees *how*, deterministically and in microseconds:
goals & constraints in, a verified executable plan out, repaired in real time as
the world changes.

**Key properties:**

- **Typed & symbolic.** State is typed fluents (boolean / enum / int / float /
  entity / vec2 / vec3). The engine derives heuristics, prunes deadlines *inside*
  search, explains failures, and serializes domains as plain JSON.
- **Real-time / budgeted.** Search runs in resumable sessions you can pause after
  half a millisecond and continue next frame.
- **Reactive & self-healing.** Execution re-checks preconditions, monitors
  maintained conditions and deadlines, repairs from the failure point, and
  replans only when a *better* plan exists (FluidHTN-style MTR).
- **Deterministic.** Seeded RNG + injectable clock ⇒ byte-identical plans and
  traces for identical inputs. Great for tests, replays, and lockstep netcode.

---

## 2. Install & import

```bash
npm install htn-ai     # ⚠ v2 is alpha — pin the exact version
```

Requires Node ≥ 20. Ships ESM + CJS + types. Everything is exported from the
package root:

```ts
import {
  // authoring helpers
  F, N, E, T, task, goal, doTask, achieve, scoped,
  // model & runtime
  createModel, Model, PlanningSession, planOnce, Planner, Scheduler,
  // validation / explanation
  validateDomain, validatePlan, simulatePlan, applicableActions,
  planSummary, explainFailure,
  // determinism / serialization
  createRng, domainToJSON, domainFromJSON,
  // types
  type DomainDoc, type GoalSpec, type Plan, type TraceEvent,
} from "htn-ai";
```

A naming convention used throughout: **`F`** builds Formulas (conditions),
**`N`** builds Numeric expressions, **`E`** builds Effects, **`T`** builds
Temporal subtasks. They are just factory objects that produce plain data nodes.

---

## 3. The pipeline at a glance

```
DomainDoc  ──createModel──▶  Model  ──planOnce / PlanningSession──▶  Plan
(plain data)               (compiled,            (search: HTN decompose
 + WorldSetup               grounded)             + GOAP goal search)
 + Registry                                            │
                                                       ▼
                                            Planner.tick(budget)
                                  (execute • monitor • repair • replan)
```

- A **`DomainDoc`** is plain, serializable data: fluents, operators, methods,
  axioms, types. No code lives inside it.
- **Code** (executors, external predicates/numerics/effects) is supplied
  separately in a **`Registry`** and referenced *by name* from the document — so
  documents stay JSON.
- **`WorldSetup`** lists the concrete entities and the initial state.
- **`createModel(doc, setup, registry)`** validates, interns entities, lays out
  packed state, compiles every formula/effect into a fast closure, and enumerates
  ground operators.
- From the model you either **plan once** or run a **`Planner`** that plans *and*
  executes tick by tick.

---

## 4. Your first plan

A hero must get into the lab. The lab is reachable only through a door that
starts closed. We state the goal (`at(hero) == lab`) and let search find the
sequence.

```ts
import { createModel, planOnce, F, N, E, goal, type DomainDoc } from "htn-ai";

const doc: DomainDoc = {
  name: "intro",
  types: [{ name: "agent" }, { name: "room" }],
  fluents: [
    { name: "at",     params: [{ name: "a", type: "agent" }], kind: "entity", entityType: "room" },
    { name: "energy", params: [{ name: "a", type: "agent" }], kind: "float", initial: 10 },
    { name: "door_open", kind: "boolean" },
  ],
  operators: [
    {
      name: "open_door",
      pre: F.not(F.lit("door_open")),
      eff: [E.set("door_open", [], true)],
    },
    {
      name: "walk",
      params: [{ name: "a", type: "agent" }, { name: "to", type: "room" }],
      pre: F.and(F.lit("door_open"), F.gte(N.fl("energy", "?a"), 5)),
      eff: [E.set("at", ["?a"], "?to"), E.dec("energy", ["?a"], 3)],
      cost: 2,
      duration: 1.5,
    },
  ],
};

const setup = {
  entities: { hero: "agent", hall: "room", lab: "room" },
  init: (w) => w.set("at", ["hero"], "hall"),
};

const model = createModel(doc, setup);

const result = planOnce(model, model.createExecState(), {
  goals: [goal(F.lit("at", ["hero"], "lab"))],
  weight: 1,            // optimal search (see §14)
});

console.log(result.status);                                  // "success"
console.log(result.plan!.steps.map(s => s.k === "op" ? s.g.op.name : s.k));
// ["open_door", "walk"]
console.log(result.plan!.cost);      // 3  (open_door 1 + walk 2)
console.log(result.plan!.makespan);  // 1.5 (open_door 0s + walk 1.5s)
```

What happened:

- `model.createExecState()` produced a live state buffer seeded from `initial`
  values and the `init` writer.
- The goal `at(hero) == lab` was not initially true, so the engine ran a goal
  search over the ground operators. `walk` needs the door open and ≥5 energy;
  `open_door` provides the door. The heuristic guided it to the 2-step plan.
- `cost` is the summed operator cost (default cost is 1 if you omit it).
- `makespan` is summed projected `duration` (default 0).

That's the whole loop in miniature. The rest of this guide unpacks every piece.

---

## 5. Fluents: the world's state

**Fluents** are the variables that make up world state. Each declares a `kind`,
an optional parameter signature, and an optional `initial` value. A fluent with
`params: []` (or omitted) is a single global cell; with params it is a *table*
indexed by entities.

```ts
fluents: [
  // global boolean
  { name: "door_open", kind: "boolean" },                      // default false

  // per-agent float, defaults to 10
  { name: "energy", params: [{ name: "a", type: "agent" }], kind: "float", initial: 10 },

  // per-agent enum
  { name: "stance", params: [{ name: "a", type: "agent" }],
    kind: "enum", values: ["stand", "crouch"] },               // default values[0]

  // per-agent entity-valued (points at a room; null when unset)
  { name: "at", params: [{ name: "a", type: "agent" }], kind: "entity", entityType: "room" },

  // 2-D / 3-D vectors
  { name: "pos", params: [{ name: "a", type: "agent" }], kind: "vec2" },

  // a relation: a 2-arg boolean table (graph edges, adjacency, …)
  { name: "road", params: [{ name: "a", type: "node" }, { name: "b", type: "node" }], kind: "boolean" },
]
```

### The seven kinds and how they encode

All state lives in one flat `Float64Array` of numeric *slots*. Values are encoded:

| Kind | Stored as | Default | Read back as |
|---|---|---|---|
| `boolean` | `0` / `1` | `false` | `boolean` |
| `enum` | value index (`0..n-1`) | `values[0]` | the string symbol |
| `int` / `float` | the number itself | `0` | `number` |
| `entity` | `gid + 1` (`0` = null) | `null` | entity name string (or `null`) |
| `vec2` / `vec3` | components in consecutive slots | `[0,0(,0)]` | use `dist()` / read slots |

The **entity `gid+1`** encoding matters whenever you compare entity fluents
numerically or write to them from raw code: `0` means "null / nothing", a real
entity is its global id plus one. (You rarely encode this by hand — the helpers
do it — but it shows up in external predicates, see §22.)

> **`initial`** sets a uniform default for *every* cell of the table. Per-entity
> starting values go in the `init` writer (next section), which overrides the
> default for specific entities.

### Reading state

```ts
const s = model.createExecState();
model.read(s, "at", "hero");      // "hall"  (entity name, or null)
model.read(s, "energy", "hero");  // 10
model.read(s, "door_open");       // false
model.read(s, "stance", "hero");  // "stand"

// raw slot access for vecs:
const slot = model.slotOf("pos", model.entityId("hero"));
s.get(slot);     // x component
s.get(slot + 1); // y component
```

`slot 0` is always reserved for the **clock** (`CLOCK_SLOT`), in seconds. During
planning it is the *projected* clock; during execution it is the *actual* elapsed
time. You can read it in formulas with `N.clock()`.

---

## 6. Types, entities & world setup

### Types

Types name the kinds of things in your world and may form a hierarchy:

```ts
types: [
  { name: "veh" },
  { name: "truck", parent: "veh" },   // a truck IS-A veh
  { name: "plane", parent: "veh" },
]
```

A fluent or operator parameter typed `veh` accepts **any subtype** (`truck`,
`plane`). This is real subtyping: a `truck` entity participates in every
`veh`-typed fluent table and grounds every `veh`-typed operator parameter.

### Entities & initial state (`WorldSetup`)

The second argument to `createModel` lists concrete entities and seeds state:

```ts
const setup = {
  // either a name→type map …
  entities: { hero: "agent", hall: "room", lab: "room" },
  // … or an array: [{ name: "hero", type: "agent" }, …]

  init: (w) => {
    w.set("at", ["hero"], "hall");      // entity value by name
    w.set("pos", ["hero"], [3, 4]);     // vec component array
    w.set("road", ["a", "b"], true);    // relation edge
    w.set("size", ["d1"], 1);           // number
  },
};
```

- `w.set(fluent, args, value)` — `args` are entity **names** (strings) or numeric
  indices; `value` is a plain JS value (`boolean | number | string | [x,y] | [x,y,z]`).
  Entity values are given by name; enum values by their symbol string.
- Entities are *interned* once at model construction. Adding/removing entities at
  runtime is not supported — declare every entity the domain will ever reference.

### Grounding & the entity-count budget

At construction the engine enumerates every **ground operator** — every operator
crossed with every legal binding of its typed parameters. A 3-parameter operator
over 10 entities each is 1000 ground ops. There is a hard guard: more than
**100 000** bindings for a single operator throws a "grounding explosion" error.
Keep operator arities and entity pools modest, or split large operators.

---

## 7. Formulas: conditions with `F`

Formulas express **preconditions**, **goals**, **maintained conditions**,
**method guards**, and **axiom bodies**. Build them with `F`:

```ts
F.lit("door_open")                       // boolean fluent is true
F.not(F.lit("door_open"))                // … is false
F.lit("at", ["hero"], "lab")             // entity/enum equality: at(hero) == lab
F.lit("stance", ["hero"], "crouch")      // enum equality
F.and(a, b, c)                           // conjunction
F.or(a, b)                               // disjunction
F.not(a)                                 // negation
F.cmp("<=", N.fl("energy", "hero"), 5)   // numeric comparison
F.lte(a, b)  F.lt(a, b)  F.gte(a, b)  F.gt(a, b)  F.eq(a, b)   // sugar for cmp
F.true()                                 // always true (an empty `and`)
```

### `F.lit` in detail

`F.lit(fluent, args, value?)` is the workhorse:

- **boolean fluent, no value** → "is true". Wrap in `F.not(...)` for "is false".
- **enum fluent + symbol** → equality against that enum value.
- **entity fluent + name** → equality against that entity (e.g.
  `F.lit("at", ["hero"], "lab")`).
- **`args`** are terms: an entity/enum **constant** is a bare string
  (`"hero"`), a **variable** is a `?`-prefixed string (`"?a"`), a **number** is a
  number. Variables are bound by the operator/method parameters or by search.
- A `lit` may also reference an **axiom** by name (see §13) — it reads as the
  axiom's truth value.

### Variables

Inside an operator or method, `"?a"` / `"?to"` refer to declared parameters; only
declared variables may appear:

```ts
{
  name: "walk",
  params: [{ name: "a", type: "agent" }, { name: "to", type: "room" }],
  pre: F.and(F.lit("at", ["?a"], "?from"), F.lit("path", ["?from", "?to"])),
  // ?from must also be declared (as a param or method free variable) — every
  // variable has to be bound somewhere, or validateDomain reports "unbound-var".
}
```

`validateDomain` flags any unbound variable, wrong arity, unknown fluent, or
out-of-range enum value before you ever run.

---

## 8. Numeric expressions with `N`

Numeric expressions appear inside `F.cmp`, in operator `cost`/`duration`, in
method `utility`, in scope `deadline`, and as `E.set` values. Build with `N`:

```ts
N.c(5)                              // constant 5  (a bare number also works in most spots)
N.fl("energy", "hero")              // read a numeric/enum/entity fluent
N.fl("energy", "?a")                // … with a variable arg
N.clock()                           // the projected/actual clock (seconds)
N.add(a, b)  N.sub(a, b)  N.mul(a, b)  N.div(a, b)  N.min(a, b)  N.max(a, b)
N.dist("pos", ["hero"], "pos", ["foe"])   // Euclidean distance between two vec fluents
N.ext("navCost", ["hero"], ["pos"])       // external numeric (see §22)
```

Examples in the wild:

```ts
// dynamic cost: walking is slower when injured
cost: N.mul(N.fl("distance"), N.add(1, N.fl("injured")))

// a time window precondition: clock must be within [losStart, losEnd]
pre: F.and(F.gte(N.clock(), N.fl("losStart")), F.lte(N.clock(), N.fl("losEnd")))

// bridge & torch: a pair's crossing time is the slower of the two
cost: N.max(N.fl("time", "?a"), N.fl("time", "?b"))
```

> **Vectors are not scalars.** You cannot use a `vec2`/`vec3` fluent directly in
> arithmetic — use `N.dist(...)`. `validateDomain` rejects scalar use of vec
> fluents.

> **Entity comparisons.** Entity fluents *can* appear in `N.fl(...)` and be
> compared with `==`/`!=` — they compare their `gid+1` encodings. `F.eq(N.fl("pkgAt"),
> N.fl("vehAt", "?v"))` means "the package and the vehicle are at the same node";
> `F.cmp("!=", N.fl("pkgAt"), 0)` means "the package is not null / is somewhere".

---

## 9. Effects with `E`

Effects are what an operator *does* to the world. An operator's `eff` is an array
applied in order.

```ts
E.set("at", ["?a"], "?to")          // assign: at(?a) := ?to (entity/enum/bool/number)
E.set("j5", [], N.c(4))             // assign a numeric expression
E.inc("energy", ["?a"], 3)          // numeric += 3
E.dec("energy", ["?a"], 3)          // numeric -= 3
E.setVec("pos", ["?u"], 10, 20, 30) // write vector components (z optional)
E.ext("burnFuel", ["fuel"])         // external effect, declares it writes `fuel` (see §22)
```

`E.set`'s value can be a literal (`true`, `"lab"`, `"?to"`, `0`) **or** a numeric
expression (`N.min(N.fl("j3"), N.sub(5, N.fl("j5")))`). Setting an entity fluent
to `0` means "null" (e.g. a block on the table, a gripper that's empty).

### Effect timing — the three tiers

Each effect has an optional `timing` controlling *when* it is applied:

| `timing` | Applied during planning? | Applied during execution? | Use for |
|---|---|---|---|
| `"planAndExecute"` *(default)* | ✅ | ✅ | normal world changes |
| `"planOnly"` | ✅ | ❌ | plan-time bookkeeping the executor will handle itself |
| `"permanent"` | ✅ | ✅ | (same mask both phases) |

```ts
{
  name: "sneak",
  eff: [
    E.set("scouted", [], true),          // real effect, happens for real
    E.inc("noise", [], 1, "planOnly"),   // search reasons about noise; live world untouched
  ],
}
```

At execution, the planner applies the operator's `planAndExecute`/`permanent`
effects automatically *after the executor reports success* — and it does so
**without** marking the world dirty (the change was anticipated, so it must not
trigger a replan). A `planOnly` effect is never written to the live world.

> **You cannot write a derived fluent.** Effects targeting an axiom name are a
> validation error — axioms are computed, not stored (§13).

---

## 10. Operators

An operator is a lifted primitive action — the smallest executable unit.

```ts
interface OperatorDecl {
  name: string;
  params?: { name: string; type: string }[];
  pre?: Formula;        // checked at plan time AND re-checked when the step starts executing
  verify?: Formula;     // executing condition: re-checked EVERY tick while the op runs
  eff?: EffectExpr[];
  cost?: number | NumExpr;    // default 1
  duration?: number | NumExpr; // seconds; default 0; advances the projected clock
  executor?: string;          // registry key; default executor succeeds instantly
  meta?: Record<string, unknown>;
}
```

The two condition slots are distinct and both matter:

- **`pre`** — must hold for the operator to be *selected* (during search) and is
  re-validated against the live world the moment the step *starts* (during
  execution). If it fails at execution, the step fails → repair/replan.
- **`verify`** — the *executing condition*. Re-checked on **every tick** while the
  operator is running. Use it for "this remains true the whole time I'm doing it"
  guarantees (e.g. "still safe while advancing"). A `verify` failure aborts the
  step mid-flight and triggers recovery.

```ts
{
  name: "advance",
  pre: F.lit("safe"),     // must be safe to begin
  verify: F.lit("safe"),  // must STAY safe throughout
  eff: [E.set("advanced", [], true)],
  executor: "slow",       // an executor that takes several ticks
}
```

If the world turns unsafe mid-advance, `verify` fails, the step aborts, and the
planner replans (e.g. into a `retreat` method).

### Default executor

If you omit `executor`, the operator "succeeds instantly" at execution: its
effects apply in the same tick. This is perfect for pure state-logic operators in
puzzles and tests. Real actions that take time supply an executor (§18).

---

## 11. Goals vs. tasks

A `PlanRequest.goals` is an array of `GoalSpec`s. There are two kinds, and they
are the heart of the HTN-vs-GOAP distinction:

```ts
import { task, goal } from "htn-ai";

task("Deliver", "p1")              // decompose the compound task `Deliver(p1)` via its methods
goal(F.lit("at", ["hero"], "lab")) // achieve this condition via operator search (GOAP)
```

- **`task(name, ...args)`** — run an HTN compound task. Its arguments must be
  **concrete** (entity names or numbers); top-level tasks cannot take variables.
  If `name` is actually an operator, it runs that operator directly.
- **`goal(condition)`** — solve a condition by goal search over operators. The
  condition is evaluated with no free variables (use concrete entity names).

You can list several — they are pursued **in order**, threading state forward.
For example `goals: [task("Deliver", "p1"), task("Deliver", "p2")]` plans both
deliveries sharing one truck's state.

Inside methods, the analogue of a top-level `goal` is `achieve(condition)`
(§12) — an inline subgoal solved by search at that point in the decomposition.

---

## 12. HTN methods

A **method** says: "to accomplish compound task *X*, do this ordered list of
subtasks (if my guard holds)." Multiple methods for the same task are
**alternatives**, tried in declared order (highest-priority first).

```ts
interface MethodDecl {
  name?: string;       // for traces; defaults to `Task#index`
  task: string;        // the compound task this method decomposes
  params?: ParamDecl[];// FREE variables, bound by search (beyond the task's own params)
  pre?: Formula;       // guard: method is eligible only if this holds in the current state
  utility?: number | NumExpr; // higher = preferred (see below)
  subtasks: SubtaskDef[];
}
```

### Subtask kinds

```ts
import { doTask, achieve, scoped, T } from "htn-ai";

doTask("take_cover")            // run an operator or another compound task (with args)
doTask("turn_to", "?c")         // … with arguments
achieve(F.lit("has_key"))       // inline subgoal solved by goal search at this point
scoped({ deadline: 10 }, ...)   // a temporal/constraint scope (see §15)
T.waitUntil(N.fl("losStart"))   // wait until an absolute clock value
T.hold(4)                       // wait a relative number of seconds
```

### Method ordering — "first applicable wins"

```ts
methods: [
  // declared first = higher priority. Combat requires a threat …
  { name: "combat", task: "Behave", pre: F.lit("threat"),
    subtasks: [doTask("take_cover"), doTask("fire")] },
  // … otherwise fall back to calm.
  { name: "calm", task: "Behave", subtasks: [doTask("patrol")] },
]
```

- No threat → `combat`'s guard fails → `calm` is chosen → `["patrol"]`.
- Threat present → `combat` is eligible and higher priority → `["take_cover", "fire"]`.

The engine backtracks: if a higher-priority method's subtasks cannot be completed
(a later subtask is unachievable), it tries the next method.

### Utility-based selection

If *any* method for a task declares `utility`, all its candidates are sorted by
utility (descending, stably) before the order above is applied. Utility is
evaluated **in the current state**, so it reacts to the world:

```ts
methods: [
  { name: "attack",  task: "Engage", pre: F.gte(N.fl("ammo"), 1), utility: N.fl("ammo"),     subtasks: [doTask("shoot")] },
  { name: "rearm",   task: "Engage", utility: 3,                                              subtasks: [doTask("reload"), doTask("shoot")] },
  { name: "survive", task: "Engage", utility: N.sub(12, N.fl("hp")),                          subtasks: [doTask("takeCover")] },
]
// ammo 5, hp 10  → attack  (utility 5 > rearm 3 > survive 2)
// ammo 1         → rearm   (3 > attack 1 > survive 2)
// hp 2           → survive (utility 10 > attack 5)
```

### Free variables bound by search

A method may declare extra `params` beyond the task's — *free variables* the
search fills in by trying every entity of the given type, backtracking on
failure:

```ts
{
  task: "Unlock",
  params: [{ name: "k", type: "key" }],   // which key? search decides
  pre: F.lit("have", ["?k"]),
  subtasks: [doTask("use_key", "?k")],
}
// With a rusty brass key and a good iron key, search binds ?k = iron
// (brass satisfies the method guard but use_key's precondition rejects it → backtrack).
```

This is how "calibrate against *some* calibration target" or "ferry *some* cargo"
works: declare the choice as a free param and let search bind it.

### MTR: replan only if strictly better

Every decomposition decision records the chosen candidate index. The full list is
the **Method Traversal Record (MTR)** — `plan.mtr`. Lower indices = higher
priority. When you replan with `lastMTR` set, the engine **rejects any plan that
is not strictly better** (i.e. equal or lower priority) than the one currently
running:

```ts
const first = planOnce(model, s, { goals: [task("Behave")] });
first.plan!.mtr;        // e.g. [1]  (chose the `calm` branch)

// replan, nothing changed → the identical plan is rejected, keep current:
planOnce(model, s, { goals: [task("Behave")], lastMTR: first.plan!.mtr }).status;  // "failure"

// world changes (threat!) → combat branch (index 0) beats it:
s.set(model.slotOf("threat"), 1);
planOnce(model, s, { goals: [task("Behave")], lastMTR: first.plan!.mtr }).plan!.mtr; // [0]
```

The reactive `Planner` does this for you automatically — it only swaps to a new
plan when that plan strictly wins, so agents don't thrash between equivalent
options.

---

## 13. Axioms: derived predicates

An **axiom** is a named boolean view computed from other fluents. It keeps your
operators DRY and lets the planner reason about high-level concepts.

```ts
axioms: [
  { name: "rested", params: [{ name: "a", type: "agent" }],
    body: F.gte(N.fl("energy", "?a"), 5) },

  // river-crossing safety, as a single reusable predicate:
  { name: "safe", body: F.and(
      F.or(F.cmp("!=", N.fl("side", "wolf"), N.fl("side", "goat")),
           F.cmp("==", N.fl("farmer"), N.fl("side", "goat"))),
      F.or(F.cmp("!=", N.fl("side", "goat"), N.fl("side", "cabbage")),
           F.cmp("==", N.fl("farmer"), N.fl("side", "goat")))) },
]
```

Reference an axiom anywhere a `lit` is allowed:

```ts
pre: F.lit("rested", ["?a"])          // uses the axiom
maintain: F.lit("safe")               // keep the world safe across a scope
```

Rules the validator enforces:

- **Acyclic.** An axiom may reference other axioms but not (transitively) itself.
- **Read-only.** No effect may write an axiom — they are computed on demand.
- **Distinct names.** An axiom may not share a name with a fluent.

Because axioms are read-only and tracked, changes to the fluents they depend on
correctly trigger reactive replanning.

---

## 14. Goal search tuning

When the engine hits a `goal(...)` / `achieve(...)`, it runs **weighted-A\*** over
ground operators. You control speed-vs-optimality via `PlanRequest`:

```ts
interface PlanRequest {
  goals: GoalSpec[];
  weight?: number;        // A* weight. 1 = (near-)optimal; >1 = greedier/faster. Default 1.4
  heuristic?: "hadd" | "hmax" | "none"; // default "hadd"
  novelty?: boolean;      // novelty tie-breaking on the open list. Default true
  maxNodes?: number;      // search node budget. Default 50_000
  maxDepth?: number;      // decomposition depth cap. Default 400
  collectRejections?: boolean; // record why branches were pruned (for explainFailure)
  lastMTR?: number[];     // replan-only-if-better (see §12)
}
```

### Choosing a heuristic

The heuristic is a delete-relaxation estimate (`h_add` family) over the positive
conjunctive atoms of the goal:

- **`"hadd"`** *(default)* — informative and fast, but can *overestimate*
  (inadmissible). Great for finding *a* good plan quickly. With the default
  `weight: 1.4` it is greedy and snappy.
- **`"hmax"`** — *admissible* (never overestimates). Pair it with **`weight: 1`**
  to get **guaranteed cost-optimal** plans. This is what you want for puzzles and
  benchmarks where plan quality is asserted.
- **`"none"`** — uniform-cost search (Dijkstra). Use when no useful heuristic
  exists, e.g. purely numeric goals.

```ts
// guaranteed-optimal gripper solve:
planOnce(model, s, { goals: [...], weight: 1, heuristic: "hmax" });

// fast "good enough" for real-time:
planOnce(model, s, { goals: [...] });   // weight 1.4, hadd, novelty on
```

> **Numeric & external & negative conditions are treated optimistically** by the
> relaxation (they're assumed reachable). That keeps the heuristic cheap; the real
> search still verifies them exactly. A consequence: a purely numeric goal (e.g.
> `j5 == 4`) gets *no* heuristic guidance and degrades to uniform-cost search —
> use `weight: 1` there for optimality.

### Failure modes (all clean)

`status: "failure"` with `collectRejections: true` gives you the reasons:

- **node budget exhausted** — raise `maxNodes` or use a better heuristic.
- **decomposition depth exceeded** — a recursive method without progress; raise
  `maxDepth` or fix the recursion.
- **goal unreachable under relaxation** — no operator can ever produce a required
  atom; the goal is genuinely impossible.
- **decomposition cycle** — a method expands to the exact same `(state, agenda)`;
  detected and pruned so unproductive recursion can't loop forever.

---

## 15. Temporal-lite

htn-ai models time with a **single projected clock** (`slot 0`, seconds). It is
not a full scheduler — it's "temporal-lite": durations advance a projected clock
during planning, and the same constraints are enforced against the real clock at
execution. Four building blocks cover the common real-time needs.

### 1. Durations advance the projected clock

```ts
{ name: "walk",  duration: 15, cost: 1, eff: [E.set("at", [], "dest")] }
{ name: "drive", duration: 6,  cost: 5, eff: [E.set("at", [], "dest")] }
```

With no deadline, search minimizes **cost**, so it picks the cheap-slow `walk`
(makespan 15). The plan's `makespan` is the total projected duration.

### 2. Deadlines prune inside search

`scoped({ deadline })` puts a relative time budget around a block of subtasks.
The deadline is checked against the **projected clock during search** — so a plan
that would blow the deadline is never even returned:

```ts
methods: [
  { task: "DeliverUrgent",
    subtasks: [ scoped({ deadline: 10, label: "within-10s" },
                       achieve(F.lit("at", [], "dest"))) ] },
]
// The 15s walk violates the 10s deadline and is pruned in search;
// the 6s drive is chosen instead. The constraint shapes the plan, it doesn't just
// report a violation afterward.
```

### 3. Maintained conditions + minimum hold + cleanup

A scope can also require a condition to hold *throughout*, last a minimum
duration, and run cleanup on exit:

```ts
interface ScopeDecl {
  deadline?: number | NumExpr;  // relative seconds; pruned in search, enforced at exec
  maintain?: Formula;           // must hold across the scope (checked between steps & every tick)
  minHold?: number;             // scope cannot complete before this many seconds elapse
  onExit?: string;              // registry executor run when the scope exits (success/fail/abort)
  label?: string;
}
```

```ts
scoped(
  { maintain: F.lit("holding"), minHold: 15, onExit: "release", label: "hold15" },
  doTask("finish"),
)
```

- During **planning**, the projected makespan is forced to be ≥ `minHold` even if
  the operators are instant — so the plan *models* the 15-second hold.
- During **execution**, the scope's `scopeExit` blocks until 15 real seconds have
  passed, then runs the `release` executor (`onExit`).
- If `maintain` is violated mid-hold (someone drops the thing), the scope is
  **aborted**, `onExit` still runs (cleanup-on-abort), and the planner recovers by
  replanning.

Scopes nest, with try/finally semantics — an inner `maintain` inside an outer
`deadline`, and aborts run cleanup from the innermost scope outward:

```ts
scoped({ deadline: 20, label: "mission-window" },
  scoped({ maintain: F.lit("undetected"), label: "stealth" }, doTask("infiltrate")),
  doTask("exfiltrate"),
)
```

### 4. Waits & time windows

`T.waitUntil(absoluteSeconds)` and `T.hold(relativeSeconds)` advance the clock:

```ts
// line-of-sight opens at t=20; wait for it, then observe:
methods: [
  { task: "Observe", subtasks: [ T.waitUntil(N.fl("losStart")), doTask("observe") ] },
]
```

At planning, the wait advances the projected clock (so the plan's first step is
`wait→20.00s`). At execution, the wait **blocks** until the real clock reaches the
target. Combined with a deadline scope, an impossible window ("observe before
t=10, but the window opens at t=20") is caught **at plan time** with a deadline
rejection — not discovered after wasting actions.

---

## 16. Planning APIs

### `planOnce` — plan to completion

```ts
const result = planOnce(model, state, request);
// result: { status, plan?, rejections?, stats }
```

Runs the search to a terminal result with no time budget (an internal large node
cap). Use it for one-shot planning, tests, and offline solving.

### `PlanningSession` — budgeted & resumable

For real-time use you don't want to block the frame. A `PlanningSession` pumps the
search in slices you control, by **milliseconds** or **node count**:

```ts
const session = new PlanningSession(model, state, {
  goals: [goal(F.eq(N.fl("j11"), 6))],
  weight: 1,
});

let result = session.step({ nodes: 8 });   // do ~8 nodes of work
while (result === null) {                   // null = budget spent, not done yet
  result = session.step({ nodes: 8 });      // resume next frame
}
// result.status === "success"
```

- `step({ ms })` runs until the wall-clock budget elapses; `step({ nodes })` until
  that many search nodes are expanded. Returns `null` if paused, or the
  `PlanResult` when finished.
- **Pausing is transparent.** A budgeted search and an unbudgeted one over the same
  inputs return the *identical* plan — slicing never changes the answer.
- `session.done` tells you if a result is ready.

### `PlanResult` & `Plan`

```ts
interface PlanResult {
  status: "success" | "failure";
  plan?: Plan;
  rejections?: Rejection[];       // when collectRejections was set
  stats: { decompositions; expansions; heuristicEvals };
}

interface Plan {
  steps: PlanStep[];   // op | scopeEnter | scopeExit | wait
  mtr: number[];       // method-traversal record (for replan-if-better)
  cost: number;        // summed operator cost
  makespan: number;    // projected elapsed seconds
  startClock: number;
  readFluents: Set<number>;  // fluents the plan's conditions depend on (replan triggers)
  readsClock: boolean;
}
```

Inspect a plan's steps:

```ts
for (const step of plan.steps) {
  if (step.k === "op") console.log(model.describeGroundOp(step.g)); // e.g. "walk(c1,c2)"
}
```

---

## 17. Execution: the reactive `Planner`

`planOnce` gives you a plan. The **`Planner`** *runs* it — planning, executing,
monitoring, repairing, and replanning, one tick at a time. One `Planner` drives
one agent.

```ts
const planner = new Planner(model, {
  goals: [task("Deliver")],
  now: () => performance.now() / 1000,  // seconds-resolution clock; inject for determinism
  seed: 42,
  weight: 1,
  driftTolerance: 1,        // replan if execution falls >1s behind projection (0 = off)
  trace: (e) => log(e),     // observe everything (see TraceEvent below)
  collectRejections: true,
});

// each frame / tick:
const status = planner.tick({ ms: 2 });   // budget for THIS tick's planning work
```

### The tick, step by step

Each `tick(budget)` does, in order:

1. **Advance the clock** from the injected `now()` (relative to the planner's epoch).
2. **React to world changes.** If fluents the current plan depends on (or any
   method guard reads) changed, start a background "find a better plan" session
   (keeps executing the current plan meanwhile).
3. **Pump any active planning session** within the tick budget (resumable).
4. **Enforce active scopes** — deadline/maintain violations abort and recover.
5. **Drive the current step.** Bookkeeping steps (scope enter/exit, waits) are
   free; at most **one operator executor** runs per tick.

`tick` returns the current `PlannerStatus`:

```ts
type PlannerStatus = "idle" | "planning" | "running" | "succeeded" | "failed";
```

- `idle` — no goals and no plan.
- `planning` — a planning session is in progress (no executable plan yet).
- `running` — executing a plan.
- `succeeded` — the plan completed.
- `failed` — planning is impossible (e.g. an unreachable goal).

A typical drive loop:

```ts
while (planner.getStatus() !== "succeeded" && planner.getStatus() !== "failed") {
  planner.tick({ ms: 2 });
  await nextFrame();
}
```

### Changing goals on the fly

```ts
planner.setGoals([task("Retreat")]);  // abandons the current plan, replans next tick
```

### Trace events

If you pass `trace`, you get a structured event stream — ideal for debugging,
telemetry, and LLM backprompting:

```ts
type TraceEvent =
  | { t: "plan.new"; cost; steps; makespan }
  | { t: "plan.replaced"; reason: "better" | "repair" }
  | { t: "plan.failed"; rejections? }
  | { t: "plan.completed" }
  | { t: "replan.dirty"; fluents: string[] }   // which fluent change triggered a replan
  | { t: "step.start"; label; index }
  | { t: "step.done"; label; index }
  | { t: "step.fail"; label; index; reason }
  | { t: "scope.enter"; label }
  | { t: "scope.exit"; label }
  | { t: "scope.violated"; label; reason: "deadline" | "maintain" }
  | { t: "drift"; label; behindSeconds }
  | { t: "repair.attempt"; from } | { t: "repair.success"; from } | { t: "repair.fallback" };
```

---

## 18. Writing executors

An **executor** is the real-world side of an operator: it does the actual work
(animate, move, call an API) and reports progress. Register it by name and point
the operator at it:

```ts
const model = createModel(doc, setup, {
  executors: {
    travel: (api) => {
      // …drive a real actuator, advance an animation, etc.…
      return api.elapsedInStep() >= 3 ? "success" : "continue";
    },
  },
});
// operator: { name: "travel", executor: "travel", eff: [...] }
```

An executor returns a **`TaskStatus`**:

- `"success"` — done. The planner then applies the operator's effects (automatically,
  without dirtying the world) and advances to the next step.
- `"continue"` — still working; call me again next tick. (Long actions span many ticks.)
- `"failure"` — abort this step → repair/replan.

It may also return a **`Promise<TaskStatus>`** for async work (network, file I/O).
The planner marks the step "in flight" and consumes the resolved status on a later
tick; a rejected promise is treated as `"failure"`:

```ts
executors: {
  fetch: () => fetch(url).then(r => r.ok ? "success" : "failure"),
}
```

### The `ExecutorApi`

```ts
interface ExecutorApi {
  args: number[];           // entity gids bound to the operator's parameters
  model: Model;
  read(fluent, ...args): number;                  // read live state (args by name or gid)
  write(fluent, args, value): void;               // write live state (triggers reactivity)
  clock(): number;                                 // execution clock, seconds
  elapsedInStep(): number;                         // seconds since THIS step started
  rng: Rng;                                        // deterministic RNG (seeded)
  remember<T>(init: () => T): T;                   // per-step scratch storage
}
```

- **`read`/`write`** operate on the live world. A `write` here *is* an
  un-anticipated change and will mark the world dirty (potentially triggering a
  replan) — that's how an executor feeds discoveries back into planning.
- **`elapsedInStep()`** is the clean way to implement timed actions
  (`>= duration ? "success" : "continue"`).
- **`remember(init)`** gives you scratch state scoped to the current step (reset
  when the step changes) — e.g. to cache a target you computed on the first tick.
- **`onExit` cleanup** executors (scope cleanup) receive the same API (with empty
  `args`).

---

## 19. Reactivity, repair & drift

This is what makes htn-ai a *runtime*, not just a planner. Three mechanisms keep
the agent's behaviour correct as the world moves.

### Fluent-precise reactive replanning

The world is dirty-tracked at fluent granularity. After each tick, the planner
checks whether any **changed** fluent is one the current plan's conditions depend
on (`plan.readFluents`) or that any method guard reads (`model.methodReads`).

- **Irrelevant change** (a fluent no condition reads) → ignored, no replan session
  even starts. (Cheap: a weather counter ticking won't disturb a combat plan.)
- **Relevant change** → a background "improve" session runs; if it finds a
  strictly-better plan (MTR), it swaps to it, abandoning the old plan's remaining
  work.

```ts
planner.state.set(model.slotOf("weather"), 7);  // nothing reads `weather`
planner.tick();                                  // no "replan.dirty" event

planner.state.set(model.slotOf("alarm"), 1);     // a method guard reads `alarm`
planner.tick();                                  // "replan.dirty" → switches to the panic branch
```

### Suffix repair from the failure point

When a step fails at execution — a precondition no longer holds, a `verify`
breaks, an executor returns `"failure"`, or a deadline/maintain scope aborts — the
planner first tries to **repair from that point** rather than replanning from
scratch. It re-runs the search on the *remaining agenda* captured at the failed
step:

```ts
// Plan: r1→r2→r3. After moving to r2, the r2→r3 door jams (discovered when the
// step's precondition is re-checked). Instead of replanning the whole route,
// the planner repairs the suffix and finds the detour r2→r6→r3.
//   trace: repair.attempt → repair.success
```

If suffix repair fails (or the failure is inside a scope, where suffix repair is
unsafe), it falls back to a **full replan** (`repair.fallback` → fresh session).

### Drift detection

Real execution can fall behind the projected timeline (an executor takes longer
than its `duration`). With `driftTolerance > 0`, if actual time exceeds the
step's projected end by more than the tolerance, the step is aborted with a
`drift` event and recovery kicks in:

```ts
new Planner(model, { goals: [...], driftTolerance: 1 });
// op with duration 2; executor never finishes; at t=5 (>2+1) → "drift" → "step.fail"
```

---

## 20. Multi-agent scheduling

Run many agents under one shared planning budget with `Scheduler`. Every agent's
**execution** advances every tick; **planning** time is staggered round-robin so
no single frame is dominated by one agent's search:

```ts
const scheduler = new Scheduler();
for (const agent of agents) {
  const planner = new Planner(agent.model, { goals: agent.goals, now: clock });
  scheduler.add(planner);
}

// each frame: hand the whole pool a total planning budget (ms); it divides fairly
scheduler.tick(4);   // 4ms of planning, split across all agents this frame
```

Out-of-budget agents still get their execution advanced (with zero planning time)
so nobody stalls. Each planner owns its own `Model`/state, so agents are fully
independent.

---

## 21. Validation, simulation & explanation

These APIs make plans inspectable and failures legible — designed for tests and
for LLM loops that author/repair domains.

### `validateDomain(doc)` — static domain checking

Returns an array of `Diagnostic`s (empty = valid). Catches unknown fluents,
arity mismatches, unbound variables, bad enum values, recursive axioms, writes to
derived fluents, name clashes, and more — each with a `path` like
`operators/walk/pre` so you (or an LLM) can pinpoint the error. `createModel`
throws a `DomainError` (carrying the diagnostics) if there are any *errors*
(warnings, like "compound task with no methods", don't block).

```ts
const diags = validateDomain(doc);
for (const d of diags) console.log(`[${d.code}] ${d.path}: ${d.message}`);
```

### `validatePlan(model, state, plan)` — symbolic dry-run

Rolls the plan forward from `state`, checking every operator precondition and
scope constraint. Returns structured `PlanDiagnosis[]` (empty = the plan is valid
from that state):

```ts
const diags = validatePlan(model, drainedState, plan);
// [{ step: 1, label: "enter()", message: "precondition of 'enter' is unsatisfied",
//    condition: "(and door_open() energy() >= 5)" }]
```

Use it to check whether a cached plan still applies after the world changed —
without executing anything.

### `simulatePlan(model, state, plan)` — roll forward & get the end state

```ts
const { ok, end, diagnoses } = simulatePlan(model, state, plan);
if (ok) console.log(model.read(end, "energy"));   // resulting state after the plan
```

### `applicableActions(model, state)` — affordance query

Every ground operator whose precondition currently holds. Great for "what can I do
right now?" UIs and for giving an LLM the legal action set:

```ts
applicableActions(model, s).map(a => a.label);   // ["open_door()"]  → after open: ["enter()"]
```

### `planSummary` & `explainFailure` — human/LLM-readable text

```ts
planSummary(model, plan);
// ["0. open_door() [t=0.00→0.00s]", "1. enter() [t=0.00→0.00s]"]

explainFailure(result);   // requires collectRejections: true
// ["leave: precondition failed (×3)"]   ← aggregated, most-common-first
```

---

## 22. Escape hatches: externals & opaque

Most logic should be pure symbolic IR (tier **T1**) — that's what the engine
reasons about best. But sometimes you need to call into your own code. Two tiers
exist for that, and you trade reasoning power for flexibility as you go down.

### T2 — externals with **declared** read/write sets

You provide a closure in the `Registry`, and you *declare which fluents it
reads/writes* so the engine still tracks dependencies (precise replanning) even
though it can't see inside the closure.

```ts
const model = createModel(doc, setup, {
  predicates: { neq: (q) => q.args[0] !== q.args[1],
                preflightOk: (q) => q.get("fuel") > 0 },
  numerics:   { travelCost: (q) => { const [x,y,z] = q.vec("pos", q.args[0]); return /* … */; } },
  effects:    { burnFuel: (w) => w.set("fuel", [], w.get("fuel") - 7) },
});
```

Reference them from the IR with declared reads/writes:

```ts
F.ext("neq", ["?x", "?to"], [])                       // external predicate, reads nothing extra
F.ext("preflightOk", [], [])  // (or F.opaque, below)
N.ext("travelCost", ["?u"], ["pos"])                  // external numeric, declares it reads `pos`
E.ext("burnFuel", ["fuel"])                           // external effect, declares it writes `fuel`
```

The query/writer API your closures receive:

```ts
interface ExtQuery {
  args: number[];                  // bound argument gids
  get(fluent, ...args): number;    // encoded value (entity = gid+1, enum = index, bool = 0/1)
  vec(fluent, ...args): number[];  // vector components
  clock(): number;
  gid(name): number;  name(gid): string;   // entity name ↔ gid
}
interface ExtWriter extends ExtQuery { set(fluent, args, value): void; }
```

> **Remember the encodings.** `get` returns *encoded* numbers: an entity reads
> back as `gid + 1`, so comparisons in your closure must account for it (e.g. the
> Tower-of-Hanoi movability check compares `otherPeg === targetGid + 1`).

Externals like `neq` (entity inequality) are the standard way to express "two
distinct entities" that pure equality can't.

### T3 — opaque predicates (prototyping)

`F.opaque(name)` calls a registered predicate with **no declared reads**. The
engine cannot track its dependencies, so changes won't trigger precise replans —
use it only for prototyping or for genuinely state-independent checks.

```ts
F.opaque("preflightOk")   // predicate registered under `predicates.preflightOk`
```

**Rule of thumb:** stay in T1 whenever you can (best heuristics, exact replan
triggers, fully serializable). Reach for T2 when you need real computation but can
still declare its fluent footprint. Reserve T3 for throwaway checks.

---

## 23. Determinism & serialization

### Deterministic runs

Identical inputs ⇒ byte-identical plans *and* traces. Two ingredients:

- **Seeded RNG.** All randomness flows through `createRng(seed)` (mulberry32). The
  `Planner` takes a `seed`; executors get it as `api.rng`.
- **Injected clock.** Pass `now: () => t` so time is data, not wall-clock. Tests
  step `t` manually; lockstep simulations feed a shared tick.

```ts
const planner = new Planner(model, { goals, now: () => t, seed: 42, weight: 1, trace });
// run twice with the same t-sequence and seed → identical trace strings
```

`createRng` is exported if you want deterministic randomness elsewhere:

```ts
const rng = createRng(123);
rng.next();   // float in [0,1)
rng.int(6);   // integer in [0,6)
```

### Serializing domains

A `DomainDoc` is plain data — serialize it, ship it, let an LLM author it:

```ts
const json = domainToJSON(doc);              // stamps format "htn-ai/domain@2"
const restored = domainFromJSON(json);       // parses + validates; throws DomainError if invalid
```

`domainFromJSON` rejects unknown formats and runs `validateDomain`, throwing a
`DomainError` (with diagnostics) on any error — so a malformed LLM-authored domain
fails loudly with actionable messages rather than misbehaving later. The
**registry** (executors/predicates/etc.) is *not* serialized — it's code, supplied
at `createModel` time by name.

---

## 24. Worked complex scenarios

The test suite is a curated gallery of fully-worked domains. Each is solved *by
search/decomposition* (not scripted) and asserted against known optima. Read them
as recipes:

| Scenario | File | Teaches |
|---|---|---|
| Water jug, blocks world, river crossing, sokoban, Tower of Hanoi, bridge & torch | `tests/puzzles.ts` | numeric effects, relations, `maintain` safety, free-var search, cost-optimal A\* (`hmax`+`weight 1`) |
| Gripper, Logistics, Satellite, Transport (IPC domains) | `tests/ipc.ts` | type hierarchies, entity-valued NumExpr effects, HTN methods mixing `achieve` + `doTask`, multi-goal threading |
| Deadlines, time windows, maintain-for-15s, escort | `tests/temporal.ts` | all four temporal-lite patterns, plan-time pruning vs. exec-time enforcement, `onExit` cleanup, recovery |
| Bunker raid, GOAP vehicle, FPS utility AI, nested scopes | `tests/scenario.ts` | method alternatives, dynamic costs, utility selection, nested deadline+maintain |
| Repair, reactive replace, budgets, determinism, scheduler | `tests/exec.ts` | suffix repair, fluent-precise triggers, resumable sessions, multi-agent |
| Search limits, async executors, drift, validation edges | `tests/edges.ts` | clean failure modes, promise executors, drift detection |
| FluidHTN-lineage semantics | `tests/htn.ts` | method order, MTR, `planOnly` timing, utility, free params, `verify` |

A representative end-to-end real-time example — escort a VIP, abort if the gap
opens, recover when they catch up:

```ts
const doc: DomainDoc = {
  name: "follow",
  fluents: [
    { name: "gap", kind: "float", initial: 1 },
    { name: "arrived", kind: "boolean" },
  ],
  operators: [{ name: "travel", eff: [E.set("arrived", [], true)], executor: "travel" }],
  methods: [{
    task: "Escort",
    subtasks: [ scoped({ maintain: F.lte(N.fl("gap"), 2), label: "escort-gap" }, doTask("travel")) ],
  }],
};
let progress = 0;
const model = createModel(doc, {}, {
  executors: { travel: () => (++progress >= 3 ? "success" : "continue") },
});

let t = 0;
const planner = new Planner(model, { goals: [task("Escort")], now: () => t, trace: console.log });

planner.tick();                                  // plan + start travelling
t = 2; planner.state.set(model.slotOf("gap"), 5); // VIP wanders off → gap 5 > 2
planner.tick();                                  // "scope.violated" (maintain) → travel aborted
planner.state.set(model.slotOf("gap"), 1);        // VIP catches up
progress = 0;
while (planner.getStatus() !== "succeeded") { t += 1; planner.tick(); }
// arrived === true — escort completed after recovery
```

---

## 25. API cheat sheet

### Authoring (build the `DomainDoc`)

```ts
// Formulas (conditions)
F.lit(fluent, args?, value?)  F.and(...)  F.or(...)  F.not(x)  F.true()
F.cmp(op, a, b)  F.eq/lt/lte/gt/gte(a, b)  F.ext(name, args, reads)  F.opaque(name)

// Numerics
N.c(x)  N.fl(fluent, ...args)  N.clock()  N.add/sub/mul/div/min/max(a, b)
N.dist(flA, argsA, flB, argsB)  N.ext(name, args, reads)

// Effects
E.set(fluent, args, value, timing?)  E.inc/dec(fluent, args, by, timing?)
E.setVec(fluent, args, x, y, z?, timing?)  E.ext(name, writes, timing?)

// Subtasks / goals
doTask(name, ...args)  achieve(formula)  scoped(scopeDecl, ...subtasks)
T.waitUntil(t)  T.hold(t)  task(name, ...args)  goal(condition)
```

### Building & planning

```ts
const model = createModel(doc, worldSetup?, registry?);   // → Model (throws DomainError if invalid)
model.createExecState();        // fresh live state seeded from initial values
model.read(state, fluent, ...args);  model.slotOf(fluent, ...gids);  model.entityId(name);
model.describeGroundOp(groundOp);

planOnce(model, state, planRequest);            // → PlanResult
const session = new PlanningSession(model, state, planRequest);
session.step({ ms?, nodes? });  session.done;   // → PlanResult | null
```

### Executing

```ts
const planner = new Planner(model, plannerOptions);
planner.tick(budget?);          // → PlannerStatus
planner.getStatus();  planner.getPlan();  planner.currentStep();  planner.clock();
planner.setGoals(goals);  planner.setTrace(fn);

const scheduler = new Scheduler();
scheduler.add(planner);  scheduler.tick(totalBudgetMs);
```

### Inspecting

```ts
validateDomain(doc);                       // Diagnostic[]
validatePlan(model, state, plan);          // PlanDiagnosis[]
simulatePlan(model, state, plan);          // { ok, end, diagnoses }
applicableActions(model, state);           // { op, label }[]
planSummary(model, plan);                  // string[]
explainFailure(result);                    // string[]  (needs collectRejections)

domainToJSON(doc);  domainFromJSON(json);  createRng(seed);
printFormula(f);  printNum(n);  printTerm(t);
```

---

## 26. Pitfalls & gotchas

- **Top-level `task(...)` args must be concrete.** Use entity names/numbers, not
  `"?x"`. Variables only make sense *inside* operators/methods. (For "pick some
  entity", declare a free method param and let search bind it.)
- **`weight` defaults to 1.4 (greedy).** For *optimal* plans use `weight: 1`, and
  pair it with `heuristic: "hmax"` to make the heuristic admissible. The puzzle
  tests all do this.
- **Numeric goals get no heuristic guidance.** `goal(F.eq(N.fl("x"), 6))` falls
  back to uniform-cost search — keep the operator branching modest and prefer
  `weight: 1`.
- **You can't write derived fluents.** Anything an effect targets must be a real
  fluent, not an axiom. (Validation catches this.)
- **Entity encoding is `gid + 1`; `0` = null.** Matters when you compare entity
  fluents numerically or read them inside external closures.
- **Vecs aren't scalars.** Use `N.dist(...)`; you can't do arithmetic on a vec
  fluent directly.
- **One executor per tick.** Bookkeeping (scope enter/exit, waits) is free and may
  chain in a single tick, but only one operator executor runs per `tick`. Size
  your tick budget accordingly.
- **`pre` vs `verify`.** `pre` gates selection and is re-checked when a step
  starts; `verify` is re-checked *every tick during* the step. Put "must stay true
  while doing it" in `verify`.
- **`planOnly` effects never touch the live world.** They exist purely so search
  can reason (e.g. accumulate projected noise). Don't expect them at execution.
- **Reactivity is fluent-precise *and* depends on declared reads.** A `F.opaque`
  predicate declares no reads, so changes to whatever it secretly depends on won't
  trigger a replan. Prefer T1/T2 with honest `reads` for anything the agent must
  react to.
- **Grounding explosion.** Operators with several entity-typed params over large
  pools blow up; the engine refuses >100k bindings for one operator. Keep arities
  small or restructure.
- **Determinism needs both seed and injected clock.** Wall-clock `now()` (the
  default) makes runs non-reproducible. Inject `now: () => t` for tests/replays.

---

*This guide tracks `src/` and `tests/` at v2.0.0-alpha. For design rationale see
[`SPEC.md`](./SPEC.md); for the research roadmap see [`ROADMAP.md`](./ROADMAP.md);
for spec-vs-implementation status see [`IMPLEMENTATION.md`](./IMPLEMENTATION.md).*
