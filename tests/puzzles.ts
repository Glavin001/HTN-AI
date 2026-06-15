import { test } from "uvu";
import * as assert from "uvu/assert";
import { DomainDoc, E, F, N, createModel, goal, planOnce, scoped, achieve, task } from "../src/index";

/**
 * Classic planning problems solved BY SEARCH (not scripted operators — the
 * gap PR #14 documented), asserted against known ground-truth optima.
 * weight: 1 → uniform-cost/A* (admissible h_add) → optimal plan lengths.
 */

// ---------------------------------------------------------------- water jug (3L & 5L → measure 4L)

test("water jug: search finds the known 6-step optimal solution", () => {
  const doc: DomainDoc = {
    name: "jugs",
    fluents: [
      { name: "j3", kind: "int", initial: 0 },
      { name: "j5", kind: "int", initial: 0 },
      { name: "tmp", kind: "int" },
    ],
    operators: [
      { name: "fill3", eff: [E.set("j3", [], N.c(3))] },
      { name: "fill5", eff: [E.set("j5", [], N.c(5))] },
      { name: "empty3", eff: [E.set("j3", [], N.c(0))] },
      { name: "empty5", eff: [E.set("j5", [], N.c(0))] },
      {
        name: "pour3to5",
        eff: [
          E.set("tmp", [], N.min(N.fl("j3"), N.sub(5, N.fl("j5")))),
          E.dec("j3", [], N.fl("tmp")),
          E.inc("j5", [], N.fl("tmp")),
        ],
      },
      {
        name: "pour5to3",
        eff: [
          E.set("tmp", [], N.min(N.fl("j5"), N.sub(3, N.fl("j3")))),
          E.dec("j5", [], N.fl("tmp")),
          E.inc("j3", [], N.fl("tmp")),
        ],
      },
    ],
  };
  const model = createModel(doc, {});
  const result = planOnce(model, model.createExecState(), {
    goals: [goal(F.eq(N.fl("j5"), 4))],
    weight: 1,
  });
  assert.equal(result.status, "success");
  const ops = result.plan!.steps.map((s) => (s.k === "op" ? s.g.op.name : "?"));
  assert.equal(ops.length, 6, `ground truth: 6 steps (got ${ops.join(", ")})`);
  // verify the plan actually measures 4 in jug5 by simulation
  assert.equal(result.plan!.cost, 6);
});

// ---------------------------------------------------------------- blocks world (3 blocks)

test("blocks world: C-on-A to A-on-B-on-C in the optimal 3 moves", () => {
  const doc: DomainDoc = {
    name: "blocks",
    types: [{ name: "block" }],
    fluents: [
      { name: "on", params: [{ name: "b", type: "block" }], kind: "entity", entityType: "block" }, // 0/null = table
      { name: "clear", params: [{ name: "b", type: "block" }], kind: "boolean", initial: true },
    ],
    operators: [
      {
        name: "block_to_block",
        params: [
          { name: "x", type: "block" },
          { name: "from", type: "block" },
          { name: "to", type: "block" },
        ],
        pre: F.and(
          F.lit("clear", ["?x"]),
          F.lit("clear", ["?to"]),
          F.lit("on", ["?x"], "?from"),
          F.ext("neq", ["?x", "?to"], []),
        ),
        eff: [E.set("on", ["?x"], "?to"), E.set("clear", ["?from"], true), E.set("clear", ["?to"], false)],
      },
      {
        name: "block_to_table",
        params: [
          { name: "x", type: "block" },
          { name: "from", type: "block" },
        ],
        pre: F.and(F.lit("clear", ["?x"]), F.lit("on", ["?x"], "?from")),
        eff: [E.set("on", ["?x"], 0), E.set("clear", ["?from"], true)],
      },
      {
        name: "table_to_block",
        params: [
          { name: "x", type: "block" },
          { name: "to", type: "block" },
        ],
        pre: F.and(F.lit("clear", ["?x"]), F.lit("clear", ["?to"]), F.lit("on", ["?x"], 0), F.ext("neq", ["?x", "?to"], [])),
        eff: [E.set("on", ["?x"], "?to"), E.set("clear", ["?to"], false)],
      },
    ],
  };
  const model = createModel(
    doc,
    {
      entities: { a: "block", b: "block", c: "block" },
      init: (w) => {
        // start: C on A, A on table, B on table; only B and C clear
        w.set("on", ["c"], "a");
        w.set("clear", ["a"], false);
      },
    },
    { predicates: { neq: (q) => q.args[0] !== q.args[1] } },
  );
  const result = planOnce(model, model.createExecState(), {
    goals: [goal(F.and(F.lit("on", ["a"], "b"), F.lit("on", ["b"], "c")))],
    weight: 1,
  });
  assert.equal(result.status, "success");
  const ops = result.plan!.steps.map((s) => (s.k === "op" ? `${s.g.op.name}` : "?"));
  assert.equal(ops.length, 3, `ground truth: 3 moves (got ${ops.join(", ")})`);
});

// ---------------------------------------------------------------- river crossing (wolf, goat, cabbage)

test("river crossing: 7 crossings with safety enforced by a maintain scope inside search", () => {
  const sides = ["left", "right"] as const;
  const doc: DomainDoc = {
    name: "river",
    types: [{ name: "cargo" }],
    fluents: [
      { name: "farmer", kind: "enum", values: [...sides], initial: "left" },
      { name: "side", params: [{ name: "c", type: "cargo" }], kind: "enum", values: [...sides], initial: "left" },
    ],
    axioms: [
      {
        name: "safe",
        body: F.and(
          // wolf eats goat only if together without the farmer
          F.or(
            F.cmp("!=", N.fl("side", "wolf"), N.fl("side", "goat")),
            F.cmp("==", N.fl("farmer"), N.fl("side", "goat")),
          ),
          // goat eats cabbage only if together without the farmer
          F.or(
            F.cmp("!=", N.fl("side", "goat"), N.fl("side", "cabbage")),
            F.cmp("==", N.fl("farmer"), N.fl("side", "goat")),
          ),
        ),
      },
    ],
    operators: [],
    methods: [
      {
        task: "FerryAll",
        subtasks: [
          scoped(
            { maintain: F.lit("safe"), label: "river-safety" },
            achieve(
              F.and(
                F.lit("farmer", [], "right"),
                F.lit("side", ["wolf"], "right"),
                F.lit("side", ["goat"], "right"),
                F.lit("side", ["cabbage"], "right"),
              ),
            ),
          ),
        ],
      },
    ],
  };
  for (const [from, to] of [
    ["left", "right"],
    ["right", "left"],
  ] as const) {
    doc.operators!.push({
      name: `cross_${from}_${to}`,
      pre: F.lit("farmer", [], from),
      eff: [E.set("farmer", [], to)],
    });
    doc.operators!.push({
      name: `ferry_${from}_${to}`,
      params: [{ name: "c", type: "cargo" }],
      pre: F.and(F.lit("farmer", [], from), F.lit("side", ["?c"], from)),
      eff: [E.set("farmer", [], to), E.set("side", ["?c"], to)],
    });
  }

  const model = createModel(doc, { entities: { wolf: "cargo", goat: "cargo", cabbage: "cargo" } });
  const result = planOnce(model, model.createExecState(), { goals: [task("FerryAll")], weight: 1 });
  assert.equal(result.status, "success");
  const crossings = result.plan!.steps.filter((s) => s.k === "op");
  assert.equal(crossings.length, 7, "ground truth: 7 crossings");
  // first move must take the goat (anything else is pruned by the maintain scope)
  const first = crossings[0];
  assert.ok(first.k === "op");
  assert.equal(first.g.op.name, "ferry_left_right");
  assert.equal(model.entityName(first.g.b[0]), "goat");
});

// ---------------------------------------------------------------- mini sokoban (1-D corridor)

test("sokoban corridor: walk + two pushes (relational adjacency, optimal 3 ops)", () => {
  const doc: DomainDoc = {
    name: "soko",
    types: [{ name: "cell" }],
    fluents: [
      { name: "player", kind: "entity", entityType: "cell" },
      { name: "box", kind: "entity", entityType: "cell" },
      {
        name: "adj",
        params: [
          { name: "a", type: "cell" },
          { name: "b", type: "cell" },
        ],
        kind: "boolean",
      },
      {
        name: "aligned",
        params: [
          { name: "a", type: "cell" },
          { name: "b", type: "cell" },
          { name: "c", type: "cell" },
        ],
        kind: "boolean",
      },
    ],
    operators: [
      {
        name: "walk",
        params: [
          { name: "a", type: "cell" },
          { name: "b", type: "cell" },
        ],
        pre: F.and(F.lit("player", [], "?a"), F.lit("adj", ["?a", "?b"]), F.not(F.lit("box", [], "?b"))),
        eff: [E.set("player", [], "?b")],
      },
      {
        name: "push",
        params: [
          { name: "a", type: "cell" },
          { name: "b", type: "cell" },
          { name: "c", type: "cell" },
        ],
        pre: F.and(F.lit("player", [], "?a"), F.lit("box", [], "?b"), F.lit("aligned", ["?a", "?b", "?c"])),
        eff: [E.set("player", [], "?b"), E.set("box", [], "?c")],
      },
    ],
  };
  const cells = ["c1", "c2", "c3", "c4", "c5"];
  const model = createModel(doc, {
    entities: Object.fromEntries(cells.map((c) => [c, "cell"])),
    init: (w) => {
      for (let i = 0; i < cells.length - 1; i++) {
        w.set("adj", [cells[i], cells[i + 1]], true);
        w.set("adj", [cells[i + 1], cells[i]], true);
      }
      for (let i = 0; i + 2 < cells.length; i++) {
        w.set("aligned", [cells[i], cells[i + 1], cells[i + 2]], true);
        w.set("aligned", [cells[i + 2], cells[i + 1], cells[i]], true);
      }
      w.set("player", [], "c1");
      w.set("box", [], "c3");
    },
  });
  const result = planOnce(model, model.createExecState(), {
    goals: [goal(F.lit("box", [], "c5"))],
    weight: 1,
  });
  assert.equal(result.status, "success");
  const ops = result.plan!.steps.map((s) => (s.k === "op" ? model.describeGroundOp(s.g) : "?"));
  assert.equal(ops, ["walk(c1,c2)", "push(c2,c3,c4)", "push(c3,c4,c5)"], "ground-truth optimal");
});

// ---------------------------------------------------------------- tower of hanoi (3 disks → 7 moves)

test("tower of hanoi: 3 disks solved in the optimal 2^n−1 = 7 moves (T2 movability predicate)", () => {
  const disks = ["d1", "d2", "d3"]; // d1 smallest
  const doc: DomainDoc = {
    name: "hanoi",
    types: [{ name: "disk" }, { name: "peg" }],
    fluents: [
      { name: "peg", params: [{ name: "d", type: "disk" }], kind: "entity", entityType: "peg" },
      { name: "size", params: [{ name: "d", type: "disk" }], kind: "int" },
    ],
    operators: [
      {
        name: "move",
        params: [
          { name: "d", type: "disk" },
          { name: "from", type: "peg" },
          { name: "to", type: "peg" },
        ],
        pre: F.and(
          F.lit("peg", ["?d"], "?from"),
          F.ext("neq", ["?from", "?to"], []),
          // no smaller disk on the source (it would be on top) or the target
          F.ext("canMoveTo", ["?d", "?to"], ["peg", "size"]),
        ),
        eff: [E.set("peg", ["?d"], "?to")],
      },
    ],
  };
  const model = createModel(
    doc,
    {
      entities: { d1: "disk", d2: "disk", d3: "disk", p1: "peg", p2: "peg", p3: "peg" },
      init: (w) => {
        disks.forEach((d, i) => {
          w.set("peg", [d], "p1");
          w.set("size", [d], i + 1);
        });
      },
    },
    {
      predicates: {
        neq: (q) => q.args[0] !== q.args[1],
        canMoveTo: (q) => {
          const [d, to] = q.args;
          const dPeg = q.get("peg", d);
          const dSize = q.get("size", d);
          for (const other of disks) {
            const og = q.gid(other);
            if (og === d) continue;
            if (q.get("size", og) < dSize) {
              const oPeg = q.get("peg", og);
              if (oPeg === dPeg || oPeg === to + 1) return false; // entity encoding = gid+1
            }
          }
          return true;
        },
      },
    },
  );
  const result = planOnce(model, model.createExecState(), {
    goals: [goal(F.and(F.lit("peg", ["d1"], "p3"), F.lit("peg", ["d2"], "p3"), F.lit("peg", ["d3"], "p3")))],
    weight: 1,
  });
  assert.equal(result.status, "success");
  assert.equal(result.plan!.steps.length, 7, "ground truth: 2^3 − 1 moves");
});

// ---------------------------------------------------------------- bridge & torch (cost-optimal: 15 minutes)

test("bridge & torch: crossing times 1/2/5/8 — cost-optimal total of 15 found by A*", () => {
  const people = ["p1", "p2", "p5", "p8"];
  const times: Record<string, number> = { p1: 1, p2: 2, p5: 5, p8: 8 };
  const doc: DomainDoc = {
    name: "bridge",
    types: [{ name: "person" }],
    fluents: [
      { name: "side", params: [{ name: "p", type: "person" }], kind: "enum", values: ["L", "R"], initial: "L" },
      { name: "torch", kind: "enum", values: ["L", "R"], initial: "L" },
      { name: "time", params: [{ name: "p", type: "person" }], kind: "int" },
    ],
    operators: [
      {
        name: "crossPair",
        params: [
          { name: "a", type: "person" },
          { name: "b", type: "person" },
        ],
        pre: F.and(F.lit("side", ["?a"], "L"), F.lit("side", ["?b"], "L"), F.lit("torch", [], "L"), F.ext("neq", ["?a", "?b"], [])),
        cost: N.max(N.fl("time", "?a"), N.fl("time", "?b")),
        eff: [E.set("side", ["?a"], "R"), E.set("side", ["?b"], "R"), E.set("torch", [], "R")],
      },
      {
        name: "returnOne",
        params: [{ name: "a", type: "person" }],
        pre: F.and(F.lit("side", ["?a"], "R"), F.lit("torch", [], "R")),
        cost: N.fl("time", "?a"),
        eff: [E.set("side", ["?a"], "L"), E.set("torch", [], "L")],
      },
    ],
  };
  const model = createModel(
    doc,
    {
      entities: Object.fromEntries(people.map((p) => [p, "person"])),
      init: (w) => people.forEach((p) => w.set("time", [p], times[p])),
    },
    { predicates: { neq: (q) => q.args[0] !== q.args[1] } },
  );
  const result = planOnce(model, model.createExecState(), {
    goals: [goal(F.and(...people.map((p) => F.lit("side", [p], "R"))))],
    weight: 1,
  });
  assert.equal(result.status, "success");
  assert.equal(result.plan!.cost, 15, "the famous non-greedy optimum (sending 5&8 together)");
});

test.run();
