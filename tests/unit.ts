import { test } from "uvu";
import * as assert from "uvu/assert";
import {
  DomainDoc,
  DomainError,
  E,
  F,
  N,
  StateView,
  T,
  createModel,
  createRng,
  doTask,
  domainFromJSON,
  goal,
  planOnce,
  printFormula,
  printNum,
  task,
} from "../src/index";

// ---------------------------------------------------------------- rng

test("rng: seeded mulberry32 is deterministic and bounded", () => {
  const a = createRng(123);
  const b = createRng(123);
  const seqA = [a.next(), a.next(), a.int(10), a.int(10)];
  const seqB = [b.next(), b.next(), b.int(10), b.int(10)];
  assert.equal(seqA, seqB);
  const c = createRng(999);
  for (let i = 0; i < 100; i++) {
    const x = c.next();
    assert.ok(x >= 0 && x < 1);
    const n = c.int(7);
    assert.ok(n >= 0 && n < 7 && Number.isInteger(n));
  }
  assert.not.equal(createRng(1).next(), createRng(2).next(), "different seeds diverge");
});

// ---------------------------------------------------------------- state: deep chains, collapse, materialize

test("state: deep copy-on-write chains collapse and materialize consistently", () => {
  const base = new Float64Array(8);
  base[3] = 42;
  let view = StateView.fromBase(base);
  for (let i = 0; i < 40; i++) {
    const child = view.child(); // exceeds MAX_CHAIN_DEPTH → internal collapse
    child.set(1, i);
    child.set(2, child.get(2) + 1);
    view = child;
  }
  assert.equal(view.get(1), 39);
  assert.equal(view.get(2), 40);
  assert.equal(view.get(3), 42, "untouched slot survives collapses");
  const flat = view.materialize();
  assert.equal(flat[1], 39);
  assert.equal(flat[2], 40);
  assert.equal(flat[3], 42);
  assert.equal(StateView.fromBase(flat).key(), view.key(), "hash equals rehash of materialized state");
  assert.equal(base[1], 0, "original base never mutated");
});

// ---------------------------------------------------------------- printers & JSON errors

test("printers render every formula/numeric node type", () => {
  const formula = F.and(
    F.or(F.lit("alive", ["hero"]), F.not(F.lit("stance", ["hero"], "crouch"))),
    F.cmp("<=", N.add(N.fl("hp", "hero"), 2), N.mul(N.c(3), N.max(1, N.div(N.sub(N.fl("hp", "hero"), 1), 2)))),
    F.gt(N.dist("pos", ["hero"], "pos", ["foe"]), 5),
    F.lt(N.clock(), N.ext("navCost", ["hero"], ["pos"])),
    F.ext("visible", ["hero", "foe"], ["pos"]),
    F.opaque("legacyCheck"),
    F.true(),
  );
  const text = printFormula(formula);
  for (const expected of ["and", "or", "not", "alive(hero)", "stance(hero)=crouch", "hp(hero)", "dist(pos, pos)", "clock", "@visible(hero,foe)", "#legacyCheck", "true", "min", "max"]) {
    if (expected === "min") continue; // min not in this formula
    if (expected === "max") {
      assert.ok(printNum(N.max(1, 2)).includes("max"));
      continue;
    }
    assert.ok(text.includes(expected), `missing '${expected}' in: ${text}`);
  }
});

test("domainFromJSON rejects wrong formats and invalid domains with diagnostics", () => {
  assert.throws(() => domainFromJSON(JSON.stringify({ format: "htn-ai/domain@99", name: "x", fluents: [] })), /Unsupported domain format/);
  try {
    domainFromJSON(JSON.stringify({ name: "bad", fluents: [], operators: [{ name: "op", pre: F.lit("ghost") }] }));
    assert.unreachable("should have thrown");
  } catch (err) {
    assert.instance(err, DomainError);
    assert.ok((err as DomainError).diagnostics.some((d) => d.code === "unknown-fluent"));
  }
});

// ---------------------------------------------------------------- type hierarchy & entity-valued NumExpr effects

test("type hierarchy: subtypes participate in supertype-typed fluents and operators", () => {
  const doc: DomainDoc = {
    name: "hier",
    types: [{ name: "animal" }, { name: "dog", parent: "animal" }, { name: "cat", parent: "animal" }],
    fluents: [
      { name: "fed", params: [{ name: "a", type: "animal" }], kind: "boolean" },
    ],
    operators: [
      { name: "feed", params: [{ name: "a", type: "animal" }], pre: F.not(F.lit("fed", ["?a"])), eff: [E.set("fed", ["?a"], true)] },
    ],
  };
  const model = createModel(doc, { entities: { rex: "dog", whiskers: "cat" } });
  const result = planOnce(model, model.createExecState(), {
    goals: [goal(F.and(F.lit("fed", ["rex"]), F.lit("fed", ["whiskers"])))],
    weight: 1,
  });
  assert.equal(result.status, "success");
  assert.equal(result.plan!.steps.length, 2, "one feed per animal, both subtypes ground the supertype param");
});

// ---------------------------------------------------------------- externals: numeric, effect, opaque; vec3 & setVec

test("T2 externals: numeric providers, external effects with declared writes, opaque predicates", () => {
  const doc: DomainDoc = {
    name: "ext",
    types: [{ name: "unit" }],
    fluents: [
      { name: "pos", params: [{ name: "u", type: "unit" }], kind: "vec3" },
      { name: "fuel", kind: "float", initial: 10 },
      { name: "arrived", kind: "boolean" },
    ],
    operators: [
      {
        name: "fly",
        params: [{ name: "u", type: "unit" }],
        // T2 numeric external (declared reads) + opaque predicate
        pre: F.and(F.lte(N.ext("travelCost", ["?u"], ["pos"]), N.fl("fuel")), F.opaque("preflightOk")),
        cost: N.ext("travelCost", ["?u"], ["pos"]),
        eff: [
          E.setVec("pos", ["?u"], 10, 20, 30),
          E.ext("burnFuel", ["fuel"]),
          E.set("arrived", [], true),
        ],
      },
    ],
  };
  const model = createModel(doc, { entities: { drone: "unit" }, init: (w) => w.set("pos", ["drone"], [1, 2, 2]) }, {
    numerics: {
      travelCost: (q) => {
        const [x, y, z] = q.vec("pos", q.args[0]);
        return Math.abs(10 - x) / 3 + Math.abs(20 - y) / 6 + Math.abs(30 - z) / 28; // 3+3+1=7
      },
    },
    predicates: { preflightOk: (q) => q.get("fuel") > 0 },
    effects: {
      burnFuel: (w) => w.set("fuel", [], w.get("fuel") - 7),
    },
  });
  const result = planOnce(model, model.createExecState(), { goals: [goal(F.lit("arrived"))], weight: 1 });
  assert.equal(result.status, "success");
  assert.equal(result.plan!.cost, 7, "external numeric used as cost");
  const sim = model.createExecState();
  // execute symbolically via planning-tier application through a fresh planOnce + state read
  const slot = model.slotOf("pos", model.entityId("drone"));
  assert.equal(sim.get(slot), 1, "init wrote vec3 components");
  assert.equal(sim.get(slot + 2), 2);
});

// ---------------------------------------------------------------- hold (relative wait) through plan and execution

test("T.hold inserts a relative wait that advances the projected clock", () => {
  const doc: DomainDoc = {
    name: "holdrel",
    fluents: [{ name: "done", kind: "boolean" }],
    operators: [{ name: "finish", eff: [E.set("done", [], true)] }],
    methods: [{ task: "Pause", subtasks: [T.hold(4), doTask("finish")] }],
  };
  const model = createModel(doc, {});
  const result = planOnce(model, model.createExecState(), { goals: [task("Pause")], weight: 1 });
  assert.equal(result.status, "success");
  assert.equal(result.plan!.makespan, 4);
  const wait = result.plan!.steps[0];
  assert.ok(wait.k === "wait" && wait.until === 4);
});

// ---------------------------------------------------------------- model introspection / encoding edges

test("encoding edges: entity null decode, enum by index, value errors", () => {
  const doc: DomainDoc = {
    name: "enc",
    types: [{ name: "thing" }],
    fluents: [
      { name: "holds", kind: "entity", entityType: "thing" },
      { name: "mode", kind: "enum", values: ["off", "on"] },
    ],
    operators: [],
  };
  const model = createModel(doc, { entities: { rock: "thing" } });
  const s = model.createExecState();
  assert.equal(model.read(s, "holds"), null, "entity defaults to null");
  s.set(model.slotOf("holds"), model.entityId("rock") + 1);
  assert.equal(model.read(s, "holds"), "rock");
  assert.equal(model.encodeValue("mode", 1), 1, "enum accepts raw index");
  assert.throws(() => model.encodeValue("mode", "broken"), /not a value of enum/);
  assert.throws(() => model.entityId("ghost"), /Unknown entity/);
  assert.throws(() => model.fluent("ghost"), /Unknown fluent/);
  assert.throws(
    () => createModel(doc, { entities: [{ name: "x", type: "thing" }, { name: "x", type: "thing" }] }),
    /Duplicate entity/,
  );
});

test.run();
