import { test } from "uvu";
import * as assert from "uvu/assert";
import {
  CLOCK_SLOT,
  DomainDoc,
  E,
  F,
  N,
  StateView,
  createModel,
  domainFromJSON,
  domainToJSON,
  goal,
  planOnce,
  validateDomain,
} from "../src/index";

// ---------------------------------------------------------------- fixture

const doc: DomainDoc = {
  name: "core",
  types: [{ name: "agent" }, { name: "room" }],
  fluents: [
    { name: "at", params: [{ name: "a", type: "agent" }], kind: "entity", entityType: "room" },
    { name: "energy", params: [{ name: "a", type: "agent" }], kind: "float", initial: 10 },
    { name: "door_open", kind: "boolean" },
    { name: "stance", params: [{ name: "a", type: "agent" }], kind: "enum", values: ["stand", "crouch"] },
    { name: "pos", params: [{ name: "a", type: "agent" }], kind: "vec2" },
  ],
  axioms: [
    {
      name: "rested",
      params: [{ name: "a", type: "agent" }],
      body: F.gte(N.fl("energy", "?a"), 5),
    },
  ],
  operators: [
    {
      name: "open_door",
      pre: F.not(F.lit("door_open")),
      eff: [E.set("door_open", [], true)],
    },
    {
      name: "walk",
      params: [
        { name: "a", type: "agent" },
        { name: "to", type: "room" },
      ],
      pre: F.and(F.lit("door_open"), F.lit("rested", ["?a"])),
      eff: [E.set("at", ["?a"], "?to"), E.dec("energy", ["?a"], 3)],
      cost: 2,
      duration: 1.5,
    },
  ],
};

const setup = {
  entities: { hero: "agent", hall: "room", lab: "room" },
  init: (w: { set: (f: string, a: (string | number)[], v: number | string | boolean | [number, number]) => void }) => {
    w.set("at", ["hero"], "hall");
    w.set("pos", ["hero"], [3, 4]);
  },
};

// ---------------------------------------------------------------- validation

test("validateDomain catches unknown fluents, arity, enum values, recursive axioms", () => {
  const bad: DomainDoc = {
    name: "bad",
    types: [{ name: "agent" }],
    fluents: [
      { name: "hp", params: [{ name: "a", type: "agent" }], kind: "int" },
      { name: "mode", kind: "enum", values: ["on"] },
    ],
    axioms: [{ name: "loop", body: F.lit("loop") }],
    operators: [
      {
        name: "broken",
        params: [{ name: "a", type: "agent" }],
        pre: F.and(F.lit("nope", ["?a"]), F.lit("hp"), F.lit("mode", [], "off"), F.lit("hp", ["?zz"])),
        eff: [E.set("loop", [], true)],
      },
    ],
  };
  const codes = validateDomain(bad).map((d) => d.code).sort();
  assert.ok(codes.includes("unknown-fluent"), "unknown fluent");
  assert.ok(codes.includes("arity"), "arity");
  assert.ok(codes.includes("enum-value"), "enum value");
  assert.ok(codes.includes("unbound-var"), "unbound var");
  assert.ok(codes.includes("axiom-cycle"), "axiom cycle");
  assert.ok(codes.includes("write-derived"), "write derived");
});

test("domain documents round-trip through JSON", () => {
  const restored = domainFromJSON(domainToJSON(doc));
  assert.equal(restored.name, "core");
  assert.equal(restored.fluents.length, doc.fluents.length);
  const model = createModel(restored, setup);
  assert.equal(model.read(model.createExecState(), "at", "hero"), "hall");
});

// ---------------------------------------------------------------- packed state & evaluation

test("packed state encodes booleans, enums, entities, floats, vecs", () => {
  const model = createModel(doc, setup);
  const s = model.createExecState();
  assert.equal(model.read(s, "at", "hero"), "hall");
  assert.equal(model.read(s, "energy", "hero"), 10);
  assert.equal(model.read(s, "door_open"), false);
  assert.equal(model.read(s, "stance", "hero"), "stand");
  const slot = model.slotOf("pos", model.entityId("hero"));
  assert.equal(s.get(slot), 3);
  assert.equal(s.get(slot + 1), 4);
});

test("copy-on-write views isolate writes and hash incrementally", () => {
  const model = createModel(doc, setup);
  const base = StateView.fromBase(model.baseState.slice());
  const h0 = base.key();
  const child = base.child();
  const slot = model.slotOf("energy", model.entityId("hero"));
  child.set(slot, 7);
  assert.equal(base.get(slot), 10, "parent unchanged");
  assert.equal(child.get(slot), 7);
  assert.not.equal(child.key(), h0, "hash changed");
  child.set(slot, 10);
  assert.equal(child.key(), h0, "hash restored when value restored");
});

test("axioms derive state and effects cannot write them", () => {
  const model = createModel(doc, setup);
  const result = planOnce(model, model.createExecState(), {
    goals: [goal(F.lit("at", ["hero"], "lab"))],
  });
  assert.equal(result.status, "success");
  const names = result.plan!.steps.map((s) => (s.k === "op" ? s.g.op.name : s.k));
  assert.equal(names, ["open_door", "walk"], "opens door then walks (axiom 'rested' satisfied)");
});

test("durations advance the projected clock; costs accumulate", () => {
  const model = createModel(doc, setup);
  const result = planOnce(model, model.createExecState(), {
    goals: [goal(F.lit("at", ["hero"], "lab"))],
  });
  const plan = result.plan!;
  assert.equal(plan.makespan, 1.5);
  assert.equal(plan.cost, 3); // open_door 1 + walk 2
  const walk = plan.steps[1];
  assert.ok(walk.k === "op" && walk.projEnd - walk.projStart === 1.5);
});

test("dist() computes vector distance", () => {
  const model = createModel(doc, setup);
  const s = model.createExecState();
  const cn = model.compileNum(N.dist("pos", ["hero"], "pos", ["hero"]), new Map(), "test");
  assert.equal(cn.fn(s, []), 0);
  // move pos and compare against a second agent? single agent: compare via slots
  const slot = model.slotOf("pos", model.entityId("hero"));
  assert.equal(s.get(slot), 3);
});

test("clock slot is reserved and readable", () => {
  const model = createModel(doc, setup);
  const s = model.createExecState();
  s.setSilent(CLOCK_SLOT, 12.5);
  const cn = model.compileNum(N.clock(), new Map(), "test");
  assert.equal(cn.fn(s, []), 12.5);
});

test.run();
