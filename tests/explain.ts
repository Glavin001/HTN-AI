import { test } from "uvu";
import * as assert from "uvu/assert";
import {
  DomainDoc,
  E,
  F,
  N,
  applicableActions,
  createModel,
  explainFailure,
  goal,
  planOnce,
  planSummary,
  simulatePlan,
  task,
  validatePlan,
} from "../src/index";

const doc: DomainDoc = {
  name: "valid",
  fluents: [
    { name: "door_open", kind: "boolean" },
    { name: "energy", kind: "float", initial: 10 },
    { name: "inside", kind: "boolean" },
  ],
  operators: [
    { name: "open_door", pre: F.not(F.lit("door_open")), eff: [E.set("door_open", [], true)] },
    {
      name: "enter",
      pre: F.and(F.lit("door_open"), F.gte(N.fl("energy"), 5)),
      eff: [E.set("inside", [], true), E.dec("energy", [], 5)],
    },
  ],
};

test("validatePlan: returns structured, printable diagnoses for broken preconditions", () => {
  const model = createModel(doc, {});
  const result = planOnce(model, model.createExecState(), { goals: [goal(F.lit("inside"))], weight: 1 });
  assert.equal(result.status, "success");

  // valid against the original state
  assert.equal(validatePlan(model, model.createExecState(), result.plan!), []);

  // tamper: drained energy breaks step 1's precondition
  const drained = model.createExecState();
  drained.set(model.slotOf("energy"), 2);
  const diagnoses = validatePlan(model, drained, result.plan!);
  assert.equal(diagnoses.length, 1);
  assert.equal(diagnoses[0].step, 1);
  assert.ok(diagnoses[0].message.includes("precondition of 'enter'"));
  assert.ok(diagnoses[0].condition?.includes("energy"), "pretty-printed failing condition names the fluent");
});

test("simulatePlan rolls effects forward symbolically", () => {
  const model = createModel(doc, {});
  const result = planOnce(model, model.createExecState(), { goals: [goal(F.lit("inside"))], weight: 1 });
  const sim = simulatePlan(model, model.createExecState(), result.plan!);
  assert.ok(sim.ok);
  assert.equal(model.read(sim.end, "inside"), true);
  assert.equal(model.read(sim.end, "energy"), 5);
});

test("applicableActions is a state-dependent affordance query", () => {
  const model = createModel(doc, {});
  const s = model.createExecState();
  assert.equal(
    applicableActions(model, s).map((a) => a.label),
    ["open_door()"],
    "enter not applicable while the door is closed",
  );
  s.set(model.slotOf("door_open"), 1);
  assert.equal(
    applicableActions(model, s).map((a) => a.label),
    ["enter()"],
    "open_door not applicable once open; enter now is",
  );
});

test("explainFailure surfaces aggregated rejection reasons", () => {
  const impossibleDoc: DomainDoc = {
    name: "imp",
    fluents: [
      { name: "locked", kind: "boolean", initial: true },
      { name: "out", kind: "boolean" },
    ],
    operators: [{ name: "leave", pre: F.not(F.lit("locked")), eff: [E.set("out", [], true)] }],
    methods: [{ name: "escape", task: "Escape", subtasks: [{ do: "leave" }] }],
  };
  const model = createModel(impossibleDoc, {});
  const result = planOnce(model, model.createExecState(), { goals: [task("Escape")], collectRejections: true });
  assert.equal(result.status, "failure");
  const reasons = explainFailure(result);
  assert.ok(reasons.length > 0);
  assert.ok(reasons.some((r) => r.includes("leave") && r.includes("precondition")), `got: ${reasons.join(" | ")}`);
});

test("planSummary renders a timed, readable step listing", () => {
  const model = createModel(doc, {});
  const result = planOnce(model, model.createExecState(), { goals: [goal(F.lit("inside"))], weight: 1 });
  const lines = planSummary(model, result.plan!);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("open_door"));
  assert.ok(lines[1].includes("enter"));
});

test.run();
