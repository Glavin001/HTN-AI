import { test } from "uvu";
import * as assert from "uvu/assert";
import {
  DomainDoc,
  E,
  F,
  N,
  Planner,
  createModel,
  doTask,
  planOnce,
  task,
} from "../src/index";

/**
 * HTN semantics kept by choice from the FluidHTN lineage (SPEC §13):
 * method ordering, MTR replan-only-if-better, utility method selection,
 * planOnly vs planAndExecute effect timing, executing conditions.
 */

const doc: DomainDoc = {
  name: "htn",
  types: [{ name: "spot" }],
  fluents: [
    { name: "threat", kind: "boolean" },
    { name: "covered", kind: "boolean" },
    { name: "shots", kind: "int" },
    { name: "scouted", kind: "boolean" },
    { name: "loud", kind: "boolean" },
    { name: "noise", kind: "int" },
  ],
  operators: [
    { name: "take_cover", pre: F.lit("threat"), eff: [E.set("covered", [], true)], executor: "noop" },
    { name: "patrol", eff: [E.set("scouted", [], true)], executor: "noop" },
    { name: "fire", pre: F.lit("threat"), eff: [E.inc("shots", [], 1)], executor: "noop" },
    {
      name: "sneak",
      eff: [
        E.set("scouted", [], true),
        E.inc("noise", [], 1, "planOnly"), // plan-time bookkeeping only
      ],
      executor: "noop",
    },
  ],
  methods: [
    // declared order: combat method first — but it requires threat
    { name: "combat", task: "Behave", pre: F.lit("threat"), subtasks: [doTask("take_cover"), doTask("fire")] },
    { name: "calm", task: "Behave", subtasks: [doTask("patrol")] },
  ],
};

function makeModel() {
  return createModel(doc, {}, { executors: { noop: () => "success" } });
}

test("method order: first applicable method wins", () => {
  const model = makeModel();
  const idle = planOnce(model, model.createExecState(), { goals: [task("Behave")] });
  assert.equal(
    idle.plan!.steps.map((s) => (s.k === "op" ? s.g.op.name : "?")),
    ["patrol"],
    "no threat → calm branch",
  );

  const hot = model.createExecState();
  hot.set(model.slotOf("threat"), 1);
  const combat = planOnce(model, hot, { goals: [task("Behave")] });
  assert.equal(
    combat.plan!.steps.map((s) => (s.k === "op" ? s.g.op.name : "?")),
    ["take_cover", "fire"],
    "threat → combat branch (higher priority)",
  );
});

test("MTR: replanning rejects plans that cannot beat the running plan", () => {
  const model = makeModel();
  const s = model.createExecState();
  // running plan chose calm (method index 1 at the single decision)
  const first = planOnce(model, s, { goals: [task("Behave")] });
  assert.equal(first.plan!.mtr, [1]);

  // replan with no relevant change: the equal plan must be rejected
  const equal = planOnce(model, s, { goals: [task("Behave")], lastMTR: first.plan!.mtr });
  assert.equal(equal.status, "failure", "identical plan rejected (keep current)");

  // world changed: combat branch (index 0) now beats the running plan
  s.set(model.slotOf("threat"), 1);
  const better = planOnce(model, s, { goals: [task("Behave")], lastMTR: first.plan!.mtr });
  assert.equal(better.status, "success");
  assert.equal(better.plan!.mtr, [0], "lower MTR = higher priority branch");
});

test("planOnly effects apply during planning but never to the live world", () => {
  const model = makeModel();
  assert.throws(() => planOnce(model, model.createExecState(), { goals: [task("Sneaky")] }), /Unknown task/);

  const planner = new Planner(model, { goals: [task("Behave")], now: () => 0 });
  // run to completion
  for (let i = 0; i < 10 && planner.getStatus() !== "succeeded"; i++) planner.tick({ nodes: 100000 });
  assert.equal(planner.getStatus(), "succeeded");
  assert.equal(model.read(planner.state, "scouted"), true, "planAndExecute effect applied");
  assert.equal(model.read(planner.state, "noise"), 0, "planOnly effect NOT applied to live world");
});

test("utility selects the highest-scoring method (stable on ties)", () => {
  const utilityDoc: DomainDoc = {
    name: "util",
    fluents: [
      { name: "hunger", kind: "float", initial: 0 },
      { name: "ate", kind: "boolean" },
      { name: "slept", kind: "boolean" },
    ],
    operators: [
      { name: "eat", eff: [E.set("ate", [], true)] },
      { name: "sleep", eff: [E.set("slept", [], true)] },
    ],
    methods: [
      { name: "eat", task: "Live", utility: N.fl("hunger"), subtasks: [doTask("eat")] },
      { name: "sleep", task: "Live", utility: 5, subtasks: [doTask("sleep")] },
    ],
  };
  const model = createModel(utilityDoc, {});
  const s = model.createExecState();
  const sleepy = planOnce(model, s, { goals: [task("Live")] });
  assert.equal(sleepy.plan!.steps.map((st) => (st.k === "op" ? st.g.op.name : "?")), ["sleep"], "5 > 0");

  s.set(model.slotOf("hunger"), 9);
  const hungry = planOnce(model, s, { goals: [task("Live")] });
  assert.equal(hungry.plan!.steps.map((st) => (st.k === "op" ? st.g.op.name : "?")), ["eat"], "9 > 5");
});

test("method free parameters are bound by search", () => {
  const freeDoc: DomainDoc = {
    name: "free",
    types: [{ name: "key" }],
    fluents: [
      { name: "have", params: [{ name: "k", type: "key" }], kind: "boolean" },
      { name: "rusty", params: [{ name: "k", type: "key" }], kind: "boolean" },
      { name: "done", kind: "boolean" },
    ],
    operators: [
      {
        name: "use_key",
        params: [{ name: "k", type: "key" }],
        pre: F.and(F.lit("have", ["?k"]), F.not(F.lit("rusty", ["?k"]))),
        eff: [E.set("done", [], true)],
      },
    ],
    methods: [
      {
        task: "Unlock",
        params: [{ name: "k", type: "key" }],
        pre: F.lit("have", ["?k"]),
        subtasks: [doTask("use_key", "?k")],
      },
    ],
  };
  const model = createModel(freeDoc, {
    entities: { brass: "key", iron: "key" },
    init: (w) => {
      w.set("have", ["brass"], true);
      w.set("have", ["iron"], true);
      w.set("rusty", ["brass"], true);
    },
  });
  const result = planOnce(model, model.createExecState(), { goals: [task("Unlock")] });
  assert.equal(result.status, "success");
  const step = result.plan!.steps[0];
  assert.ok(step.k === "op");
  assert.equal(model.entityName(step.g.b[0]), "iron", "binds the non-rusty key (brass pre fails, backtracks)");
});

test("executing conditions (verify) abort the step and trigger recovery", () => {
  const verifyDoc: DomainDoc = {
    name: "verify",
    fluents: [
      { name: "safe", kind: "boolean", initial: true },
      { name: "advanced", kind: "boolean" },
      { name: "retreated", kind: "boolean" },
    ],
    operators: [
      {
        name: "advance",
        pre: F.lit("safe"),
        verify: F.lit("safe"),
        eff: [E.set("advanced", [], true)],
        executor: "slow",
      },
      { name: "retreat", pre: F.not(F.lit("safe")), eff: [E.set("retreated", [], true)] },
    ],
    methods: [
      { name: "bold", task: "Move", pre: F.lit("safe"), subtasks: [doTask("advance")] },
      { name: "careful", task: "Move", subtasks: [doTask("retreat")] },
    ],
  };
  let ticks = 0;
  const model = createModel(verifyDoc, {}, { executors: { slow: () => (++ticks >= 5 ? "success" : "continue") } });
  let t = 0;
  const planner = new Planner(model, { goals: [task("Move")], now: () => t });
  planner.tick({ nodes: 100000 }); // plan + start advancing
  planner.tick({ nodes: 100000 });
  assert.equal(planner.getStatus(), "running");
  // world turns unsafe mid-execution → verify fails → replan picks retreat
  t = 1;
  planner.state.set(model.slotOf("safe"), 0);
  for (let i = 0; i < 10 && planner.getStatus() !== "succeeded"; i++) planner.tick({ nodes: 100000 });
  assert.equal(planner.getStatus(), "succeeded");
  assert.equal(model.read(planner.state, "retreated"), true, "recovered via lower-priority method");
  assert.equal(model.read(planner.state, "advanced"), false);
});

test.run();
