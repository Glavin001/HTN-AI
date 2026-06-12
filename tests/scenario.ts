import { test } from "uvu";
import * as assert from "uvu/assert";
import { DomainDoc, E, F, N, achieve, createModel, doTask, planOnce, task } from "../src/index";

/**
 * Scenario ports — the behavioral intents of the v1 test scenarios:
 *  - bunker (tests/scenarios/bunker): hierarchical fetch-key→unlock→breach chains
 *  - goapVehicle (tests/goapSequence): dynamic, state-dependent action costs
 *    flipping route choice (walk vs drive, injury multipliers)
 */

test("bunker-lite: hierarchical decomposition chains key→unlock→loot with alternatives", () => {
  const doc: DomainDoc = {
    name: "bunker",
    types: [{ name: "place" }],
    fluents: [
      { name: "at", kind: "entity", entityType: "place" },
      { name: "has_key", kind: "boolean" },
      { name: "has_c4", kind: "boolean" },
      { name: "door_open", kind: "boolean" },
      { name: "looted", kind: "boolean" },
      {
        name: "path",
        params: [
          { name: "a", type: "place" },
          { name: "b", type: "place" },
        ],
        kind: "boolean",
      },
    ],
    operators: [
      {
        name: "goto",
        params: [
          { name: "a", type: "place" },
          { name: "b", type: "place" },
        ],
        pre: F.and(F.lit("at", [], "?a"), F.lit("path", ["?a", "?b"])),
        eff: [E.set("at", [], "?b")],
      },
      { name: "pickup_key", pre: F.lit("at", [], "depot"), eff: [E.set("has_key", [], true)] },
      { name: "pickup_c4", pre: F.lit("at", [], "armory"), eff: [E.set("has_c4", [], true)] },
      { name: "unlock", pre: F.and(F.lit("at", [], "bunker"), F.lit("has_key")), eff: [E.set("door_open", [], true)] },
      { name: "breach", pre: F.and(F.lit("at", [], "bunker"), F.lit("has_c4")), eff: [E.set("door_open", [], true)], cost: 5 },
      { name: "loot", pre: F.and(F.lit("at", [], "bunker"), F.lit("door_open")), eff: [E.set("looted", [], true)] },
    ],
    methods: [
      // quiet entry preferred (declared first); explosive entry as fallback
      {
        name: "quiet",
        task: "Raid",
        subtasks: [achieve(F.lit("has_key")), achieve(F.and(F.lit("at", [], "bunker"), F.lit("door_open"))), doTask("loot")],
      },
      {
        name: "loud",
        task: "Raid",
        subtasks: [achieve(F.lit("has_c4")), achieve(F.and(F.lit("at", [], "bunker"), F.lit("door_open"))), doTask("loot")],
      },
    ],
  };
  const model = createModel(doc, {
    entities: { camp: "place", depot: "place", armory: "place", bunker: "place" },
    init: (w) => {
      w.set("at", [], "camp");
      for (const [a, b] of [
        ["camp", "depot"],
        ["depot", "camp"],
        ["camp", "armory"],
        ["armory", "camp"],
        ["camp", "bunker"],
        ["bunker", "camp"],
        ["depot", "bunker"],
        ["bunker", "depot"],
      ]) {
        w.set("path", [a, b], true);
      }
    },
  });
  const result = planOnce(model, model.createExecState(), { goals: [task("Raid")], weight: 1 });
  assert.equal(result.status, "success");
  const ops = result.plan!.steps.filter((s) => s.k === "op").map((s) => (s.k === "op" ? model.describeGroundOp(s.g) : "?"));
  assert.equal(ops, ["goto(camp,depot)", "pickup_key()", "goto(depot,bunker)", "unlock()", "loot()"], "quiet route via the depot key");
});

test("goapVehicle: dynamic costs flip the chosen action with vehicle availability and injury", () => {
  const doc: DomainDoc = {
    name: "vehicle",
    fluents: [
      { name: "distance", kind: "float", initial: 100 },
      { name: "injured", kind: "boolean" },
      { name: "has_vehicle", kind: "boolean" },
      { name: "at_target", kind: "boolean" },
    ],
    operators: [
      {
        name: "walk",
        // walking is slower when injured: distance × (1 + injured)
        cost: N.mul(N.fl("distance"), N.add(1, N.fl("injured"))),
        eff: [E.set("at_target", [], true)],
      },
      {
        name: "drive",
        pre: F.lit("has_vehicle"),
        cost: N.mul(N.fl("distance"), 0.6),
        eff: [E.set("at_target", [], true)],
      },
    ],
  };
  const model = createModel(doc, {});

  // no vehicle → must walk
  const onFoot = planOnce(model, model.createExecState(), { goals: [goal2()], weight: 1 });
  assert.equal(pickOp(onFoot), "walk");

  // vehicle available → driving is cheaper (60 < 100)
  const s2 = model.createExecState();
  s2.set(model.slotOf("has_vehicle"), 1);
  const driving = planOnce(model, s2, { goals: [goal2()], weight: 1 });
  assert.equal(pickOp(driving), "drive");

  // short distance + vehicle, but… walking 10 beats driving 6? still drive; flip with injury:
  const s3 = model.createExecState();
  s3.set(model.slotOf("has_vehicle"), 1);
  s3.set(model.slotOf("distance"), 10);
  s3.set(model.slotOf("injured"), 1);
  const injured = planOnce(model, s3, { goals: [goal2()], weight: 1 });
  assert.equal(pickOp(injured), "drive", "injury doubles walking cost (20) vs driving (6)");

  function goal2() {
    return { kind: "goal" as const, condition: F.lit("at_target") };
  }
  function pickOp(r: ReturnType<typeof planOnce>): string {
    assert.equal(r.status, "success");
    const step = r.plan!.steps[0];
    return step.k === "op" ? step.g.op.name : "?";
  }
});

test.run();
