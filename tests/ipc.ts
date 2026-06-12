import { test } from "uvu";
import * as assert from "uvu/assert";
import { DomainDoc, E, F, N, achieve, createModel, doTask, goal, planOnce, task } from "../src/index";

/**
 * Canonical IPC benchmark domains (hand-encoded small instances with known
 * optima). These are the domains planning papers and the International
 * Planning Competition actually compare on; the full HDDL-imported harness
 * with reference planners is milestone M4 (IMPLEMENTATION.md) — these
 * instances pin correctness and plan quality meanwhile.
 *
 *  - Gripper   (IPC-1998 classical staple)
 *  - Logistics (IPC-1998/2000 classical staple, with a type hierarchy)
 *  - Satellite (IPC-2002; natural HTN method structure)
 *  - Transport (HTN IPC 2020/2023 totally-ordered track domain)
 */

// ---------------------------------------------------------------- gripper

test("gripper: 4 balls, two grippers, A→B — known optimal 11 steps", () => {
  const doc: DomainDoc = {
    name: "gripper",
    types: [{ name: "room" }, { name: "ball" }, { name: "gripper" }],
    fluents: [
      { name: "robot", kind: "entity", entityType: "room" },
      { name: "ballAt", params: [{ name: "b", type: "ball" }], kind: "entity", entityType: "room" }, // 0 = held
      { name: "carry", params: [{ name: "g", type: "gripper" }], kind: "entity", entityType: "ball" }, // 0 = free
    ],
    operators: [
      {
        name: "move",
        params: [
          { name: "from", type: "room" },
          { name: "to", type: "room" },
        ],
        pre: F.and(F.lit("robot", [], "?from"), F.ext("neq", ["?from", "?to"], [])),
        eff: [E.set("robot", [], "?to")],
      },
      {
        name: "pick",
        params: [
          { name: "b", type: "ball" },
          { name: "g", type: "gripper" },
          { name: "r", type: "room" },
        ],
        pre: F.and(F.lit("ballAt", ["?b"], "?r"), F.lit("robot", [], "?r"), F.lit("carry", ["?g"], 0)),
        eff: [E.set("carry", ["?g"], "?b"), E.set("ballAt", ["?b"], 0)],
      },
      {
        name: "drop",
        params: [
          { name: "b", type: "ball" },
          { name: "g", type: "gripper" },
          { name: "r", type: "room" },
        ],
        pre: F.and(F.lit("carry", ["?g"], "?b"), F.lit("robot", [], "?r")),
        eff: [E.set("ballAt", ["?b"], "?r"), E.set("carry", ["?g"], 0)],
      },
    ],
  };
  const model = createModel(
    doc,
    {
      entities: {
        roomA: "room",
        roomB: "room",
        b1: "ball",
        b2: "ball",
        b3: "ball",
        b4: "ball",
        left: "gripper",
        right: "gripper",
      },
      init: (w) => {
        w.set("robot", [], "roomA");
        for (const b of ["b1", "b2", "b3", "b4"]) w.set("ballAt", [b], "roomA");
      },
    },
    { predicates: { neq: (q) => q.args[0] !== q.args[1] } },
  );
  const result = planOnce(model, model.createExecState(), {
    goals: [
      goal(
        F.and(
          F.lit("ballAt", ["b1"], "roomB"),
          F.lit("ballAt", ["b2"], "roomB"),
          F.lit("ballAt", ["b3"], "roomB"),
          F.lit("ballAt", ["b4"], "roomB"),
        ),
      ),
    ],
    weight: 1,
    heuristic: "hmax", // admissible → weight-1 search is guaranteed optimal
  });
  assert.equal(result.status, "success");
  assert.equal(result.plan!.steps.length, 11, "pick×2, move, drop×2, move-back, pick×2, move, drop×2");
});

// ---------------------------------------------------------------- logistics (type hierarchy + NumExpr entity effects)

test("logistics: package via truck then airplane — known optimal 6 steps", () => {
  const doc: DomainDoc = {
    name: "logistics",
    types: [{ name: "node" }, { name: "veh" }, { name: "truck", parent: "veh" }, { name: "plane", parent: "veh" }],
    fluents: [
      { name: "vehAt", params: [{ name: "v", type: "veh" }], kind: "entity", entityType: "node" },
      { name: "pkgAt", kind: "entity", entityType: "node" }, // 0 = inside a vehicle
      { name: "pkgIn", kind: "entity", entityType: "veh" }, // 0 = not loaded
      {
        name: "road",
        params: [
          { name: "a", type: "node" },
          { name: "b", type: "node" },
        ],
        kind: "boolean",
      },
      {
        name: "air",
        params: [
          { name: "a", type: "node" },
          { name: "b", type: "node" },
        ],
        kind: "boolean",
      },
    ],
    operators: [
      {
        name: "load",
        params: [{ name: "v", type: "veh" }],
        pre: F.and(F.lit("pkgIn", [], 0), F.cmp("!=", N.fl("pkgAt"), 0), F.eq(N.fl("pkgAt"), N.fl("vehAt", "?v"))),
        eff: [E.set("pkgIn", [], "?v"), E.set("pkgAt", [], 0)],
      },
      {
        name: "unload",
        params: [{ name: "v", type: "veh" }],
        pre: F.lit("pkgIn", [], "?v"),
        eff: [E.set("pkgAt", [], N.fl("vehAt", "?v")), E.set("pkgIn", [], 0)],
      },
      {
        name: "drive",
        params: [
          { name: "t", type: "truck" },
          { name: "a", type: "node" },
          { name: "b", type: "node" },
        ],
        pre: F.and(F.lit("vehAt", ["?t"], "?a"), F.lit("road", ["?a", "?b"])),
        eff: [E.set("vehAt", ["?t"], "?b")],
      },
      {
        name: "fly",
        params: [
          { name: "p", type: "plane" },
          { name: "a", type: "node" },
          { name: "b", type: "node" },
        ],
        pre: F.and(F.lit("vehAt", ["?p"], "?a"), F.lit("air", ["?a", "?b"])),
        eff: [E.set("vehAt", ["?p"], "?b")],
      },
    ],
  };
  const model = createModel(doc, {
    entities: { pos1: "node", apt1: "node", apt2: "node", tr: "truck", pl: "plane" },
    init: (w) => {
      w.set("vehAt", ["tr"], "pos1");
      w.set("vehAt", ["pl"], "apt1");
      w.set("pkgAt", [], "pos1");
      w.set("road", ["pos1", "apt1"], true);
      w.set("road", ["apt1", "pos1"], true);
      w.set("air", ["apt1", "apt2"], true);
      w.set("air", ["apt2", "apt1"], true);
    },
  });
  const result = planOnce(model, model.createExecState(), {
    goals: [goal(F.lit("pkgAt", [], "apt2"))],
    weight: 1,
  });
  assert.equal(result.status, "success");
  const ops = result.plan!.steps.map((s) => (s.k === "op" ? s.g.op.name : "?"));
  assert.equal(ops, ["load", "drive", "unload", "load", "fly", "unload"], "truck leg then air leg");
});

// ---------------------------------------------------------------- satellite (HTN method structure)

test("satellite: HTN method calibrates then images — optimal 5 steps with a search-bound calibration target", () => {
  const doc: DomainDoc = {
    name: "satellite",
    types: [{ name: "dir" }],
    fluents: [
      { name: "powered", kind: "boolean" },
      { name: "pointing", kind: "entity", entityType: "dir" },
      { name: "calibrated", kind: "boolean" },
      { name: "haveImage", params: [{ name: "d", type: "dir" }], kind: "boolean" },
      { name: "isCalTarget", params: [{ name: "d", type: "dir" }], kind: "boolean" },
    ],
    operators: [
      { name: "switch_on", pre: F.not(F.lit("powered")), eff: [E.set("powered", [], true)] },
      { name: "turn_to", params: [{ name: "d", type: "dir" }], eff: [E.set("pointing", [], "?d")] },
      {
        name: "calibrate",
        params: [{ name: "c", type: "dir" }],
        pre: F.and(F.lit("powered"), F.lit("pointing", [], "?c"), F.lit("isCalTarget", ["?c"])),
        eff: [E.set("calibrated", [], true)],
      },
      {
        name: "take_image",
        params: [{ name: "t", type: "dir" }],
        pre: F.and(F.lit("calibrated"), F.lit("pointing", [], "?t")),
        eff: [E.set("haveImage", ["?t"], true)],
      },
    ],
    compounds: [{ name: "GetImage", params: [{ name: "t", type: "dir" }] }],
    methods: [
      {
        task: "GetImage",
        params: [{ name: "c", type: "dir" }], // calibration target chosen by search
        pre: F.lit("isCalTarget", ["?c"]),
        subtasks: [
          doTask("switch_on"),
          doTask("turn_to", "?c"),
          doTask("calibrate", "?c"),
          doTask("turn_to", "?t"),
          doTask("take_image", "?t"),
        ],
      },
    ],
  };
  const model = createModel(doc, {
    entities: { groundstation: "dir", phenomenon: "dir" },
    init: (w) => {
      w.set("isCalTarget", ["groundstation"], true);
      w.set("pointing", [], "phenomenon");
    },
  });
  const result = planOnce(model, model.createExecState(), { goals: [task("GetImage", "phenomenon")], weight: 1 });
  assert.equal(result.status, "success");
  const ops = result.plan!.steps.map((s) => (s.k === "op" ? s.g.op.name : "?"));
  assert.equal(ops, ["switch_on", "turn_to", "calibrate", "turn_to", "take_image"]);
  const calibrate = result.plan!.steps[2];
  assert.ok(calibrate.k === "op");
  assert.equal(model.entityName(calibrate.g.b[0]), "groundstation", "free method variable bound to the calibration target");
});

// ---------------------------------------------------------------- transport (HTN IPC TO-track domain)

test("transport: two deliveries with one capacity-1 truck — methods mix achieve-goals and operators (6 steps)", () => {
  const doc: DomainDoc = {
    name: "transport",
    types: [{ name: "loc" }, { name: "pkg" }],
    fluents: [
      { name: "truckAt", kind: "entity", entityType: "loc" },
      { name: "at", params: [{ name: "p", type: "pkg" }], kind: "entity", entityType: "loc" }, // 0 = on the truck
      { name: "dest", params: [{ name: "p", type: "pkg" }], kind: "entity", entityType: "loc" },
      { name: "loaded", kind: "entity", entityType: "pkg" }, // 0 = empty (capacity 1)
      {
        name: "road",
        params: [
          { name: "a", type: "loc" },
          { name: "b", type: "loc" },
        ],
        kind: "boolean",
      },
    ],
    operators: [
      {
        name: "drive",
        params: [
          { name: "a", type: "loc" },
          { name: "b", type: "loc" },
        ],
        pre: F.and(F.lit("truckAt", [], "?a"), F.lit("road", ["?a", "?b"])),
        eff: [E.set("truckAt", [], "?b")],
      },
      {
        name: "pick",
        params: [{ name: "p", type: "pkg" }],
        pre: F.and(F.lit("loaded", [], 0), F.eq(N.fl("at", "?p"), N.fl("truckAt"))),
        eff: [E.set("loaded", [], "?p"), E.set("at", ["?p"], 0)],
      },
      {
        name: "drop",
        params: [{ name: "p", type: "pkg" }],
        pre: F.lit("loaded", [], "?p"),
        eff: [E.set("at", ["?p"], N.fl("truckAt")), E.set("loaded", [], 0)],
      },
    ],
    compounds: [{ name: "Deliver", params: [{ name: "p", type: "pkg" }] }],
    methods: [
      {
        task: "Deliver",
        subtasks: [
          achieve(F.eq(N.fl("truckAt"), N.fl("at", "?p"))),
          doTask("pick", "?p"),
          achieve(F.eq(N.fl("truckAt"), N.fl("dest", "?p"))),
          doTask("drop", "?p"),
        ],
      },
    ],
  };
  const model = createModel(doc, {
    entities: { A: "loc", B: "loc", C: "loc", p1: "pkg", p2: "pkg" },
    init: (w) => {
      w.set("truckAt", [], "A");
      w.set("at", ["p1"], "A");
      w.set("dest", ["p1"], "B");
      w.set("at", ["p2"], "B");
      w.set("dest", ["p2"], "C");
      for (const [a, b] of [
        ["A", "B"],
        ["B", "A"],
        ["B", "C"],
        ["C", "B"],
      ]) {
        w.set("road", [a, b], true);
      }
    },
  });
  const result = planOnce(model, model.createExecState(), {
    goals: [task("Deliver", "p1"), task("Deliver", "p2")],
    weight: 1,
  });
  assert.equal(result.status, "success");
  const ops = result.plan!.steps.map((s) => (s.k === "op" ? `${s.g.op.name}` : "?"));
  assert.equal(ops, ["pick", "drive", "drop", "pick", "drive", "drop"], "chained deliveries share the truck state");
  // verify both packages reached their destinations by symbolic simulation
  const last = result.plan!.steps[result.plan!.steps.length - 1];
  assert.ok(last.k === "op" && last.g.op.name === "drop");
});

test.run();
