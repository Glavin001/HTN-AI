import { test } from "uvu";
import * as assert from "uvu/assert";
import { DomainDoc, E, F, N, Planner, achieve, createModel, doTask, planOnce, scoped, task } from "../src/index";

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

test("fps-lite: utility methods switch between attack/reload/retreat as hp and ammo change", () => {
  const doc: DomainDoc = {
    name: "fps",
    fluents: [
      { name: "ammo", kind: "int", initial: 5 },
      { name: "hp", kind: "int", initial: 10 },
      { name: "enemyDown", kind: "boolean" },
      { name: "reloaded", kind: "boolean" },
      { name: "inCover", kind: "boolean" },
    ],
    operators: [
      {
        name: "shoot",
        pre: F.gte(N.fl("ammo"), 1),
        verify: F.gte(N.fl("hp"), 1),
        eff: [E.dec("ammo", [], 1), E.set("enemyDown", [], true)],
      },
      { name: "reload", eff: [E.set("reloaded", [], true), E.inc("ammo", [], 6)] },
      { name: "takeCover", eff: [E.set("inCover", [], true)] },
    ],
    methods: [
      { name: "attack", task: "Engage", pre: F.gte(N.fl("ammo"), 1), utility: N.fl("ammo"), subtasks: [{ do: "shoot" }] },
      { name: "rearm", task: "Engage", utility: 3, subtasks: [{ do: "reload" }, { do: "shoot" }] },
      { name: "survive", task: "Engage", utility: N.sub(12, N.fl("hp")), subtasks: [{ do: "takeCover" }] },
    ],
  };
  const model = createModel(doc, {});
  const pick = (mutate?: (s: ReturnType<typeof model.createExecState>) => void): string[] => {
    const s = model.createExecState();
    mutate?.(s);
    const r = planOnce(model, s, { goals: [task("Engage")], weight: 1 });
    assert.equal(r.status, "success");
    return r.plan!.steps.map((st) => (st.k === "op" ? st.g.op.name : "?"));
  };
  assert.equal(pick(), ["shoot"], "healthy + ammo 5 → attack (utility 5 beats rearm 3, survive 2)");
  assert.equal(pick((s) => s.set(model.slotOf("ammo"), 1)), ["reload", "shoot"], "low ammo → rearm (3 > 1, survive 2)");
  assert.equal(pick((s) => s.set(model.slotOf("hp"), 2)), ["takeCover"], "low hp → survive (10 > attack 5)");
});

test("nested scopes: an inner maintain inside an outer deadline, planned and executed", () => {
  const doc: DomainDoc = {
    name: "nested",
    fluents: [
      { name: "undetected", kind: "boolean", initial: true },
      { name: "inside", kind: "boolean" },
      { name: "extracted", kind: "boolean" },
    ],
    operators: [
      { name: "infiltrate", duration: 5, pre: F.lit("undetected"), eff: [E.set("inside", [], true)], executor: "creep" },
      { name: "exfiltrate", duration: 5, pre: F.lit("inside"), eff: [E.set("extracted", [], true)] },
    ],
    methods: [
      {
        task: "Mission",
        subtasks: [
          scoped(
            { deadline: 20, label: "mission-window" },
            scoped({ maintain: F.lit("undetected"), label: "stealth" }, { do: "infiltrate" }),
            { do: "exfiltrate" },
          ),
        ],
      },
      {
        task: "RushMission",
        subtasks: [
          scoped(
            { deadline: 8, label: "too-tight" }, // 10s of work cannot fit
            { do: "infiltrate" },
            { do: "exfiltrate" },
          ),
        ],
      },
    ],
  };
  const model = createModel(doc, {}, {
    executors: { creep: (api) => (api.elapsedInStep() >= 5 ? "success" : "continue") },
  });
  const ok = planOnce(model, model.createExecState(), { goals: [task("Mission")], weight: 1 });
  assert.equal(ok.status, "success");
  assert.equal(ok.plan!.makespan, 10, "5s + 5s inside a 20s window");
  const enters = ok.plan!.steps.filter((s) => s.k === "scopeEnter").map((s) => (s.k === "scopeEnter" ? s.scope.label : "?"));
  assert.equal(enters, ["mission-window", "stealth"], "nested scope structure preserved in the plan");

  const tight = planOnce(model, model.createExecState(), { goals: [task("RushMission")], weight: 1, collectRejections: true });
  assert.equal(tight.status, "failure", "10s of durations cannot fit an 8s deadline — caught in search");
  assert.ok((tight.rejections ?? []).some((r) => r.reason.includes("deadline")));

  // execution: detection mid-infiltration aborts the inner scope and the outer plan
  let t = 0;
  const events: string[] = [];
  const planner = new Planner(model, { goals: [task("Mission")], now: () => t, trace: (e) => events.push(e.t) });
  planner.tick({ nodes: 100000 });
  t = 2;
  planner.state.set(model.slotOf("undetected"), 0); // spotted!
  planner.tick({ nodes: 100000 });
  assert.ok(events.includes("scope.violated"), "stealth scope violation detected at execution");
});

test.run();
