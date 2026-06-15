import { test } from "uvu";
import * as assert from "uvu/assert";
import {
  DomainDoc,
  E,
  F,
  N,
  Planner,
  T,
  TraceEvent,
  achieve,
  createModel,
  doTask,
  planOnce,
  scoped,
  task,
} from "../src/index";

/**
 * Temporal-lite (SPEC §4.13) — the four target scenarios:
 *   1. deadlines ("escort within 10s") — deadline pruning inside SEARCH
 *   2. time-windowed actions (LOS window) — projected-clock windows + waits
 *   3. "maintain for at least 15s" — maintain + minHold scopes, onExit cleanup
 *   4. escort/follow under a maintained constraint — abort & recover at execution
 */

// ---------------------------------------------------------------- 1. deadline flips route choice in search

test("deadline: search picks the cheap-slow route normally, the fast route under a 10s deadline", () => {
  const doc: DomainDoc = {
    name: "escort",
    fluents: [{ name: "at", kind: "enum", values: ["base", "dest"], initial: "base" }],
    operators: [
      { name: "walk", pre: F.lit("at", [], "base"), duration: 15, cost: 1, eff: [E.set("at", [], "dest")] },
      { name: "drive", pre: F.lit("at", [], "base"), duration: 6, cost: 5, eff: [E.set("at", [], "dest")] },
    ],
    methods: [
      { task: "DeliverRelaxed", subtasks: [achieve(F.lit("at", [], "dest"))] },
      {
        task: "DeliverUrgent",
        subtasks: [scoped({ deadline: 10, label: "within-10s" }, achieve(F.lit("at", [], "dest")))],
      },
    ],
  };
  const model = createModel(doc, {});

  const relaxed = planOnce(model, model.createExecState(), { goals: [task("DeliverRelaxed")], weight: 1 });
  const relaxedOps = relaxed.plan!.steps.filter((s) => s.k === "op").map((s) => (s.k === "op" ? s.g.op.name : "?"));
  assert.equal(relaxedOps, ["walk"], "no deadline → cheapest plan (walk, cost 1)");
  assert.equal(relaxed.plan!.makespan, 15);

  const urgent = planOnce(model, model.createExecState(), { goals: [task("DeliverUrgent")], weight: 1 });
  assert.equal(urgent.status, "success");
  const urgentOps = urgent.plan!.steps.filter((s) => s.k === "op").map((s) => (s.k === "op" ? s.g.op.name : "?"));
  assert.equal(urgentOps, ["drive"], "deadline 10s prunes walk (15s) inside the goal search");
  assert.equal(urgent.plan!.makespan, 6);
});

// ---------------------------------------------------------------- 2. time-windowed action (line-of-sight window)

test("time window: planner waits for the window to open and meets it; deadlines prune unreachable windows", () => {
  const doc: DomainDoc = {
    name: "los",
    fluents: [
      { name: "losStart", kind: "float", initial: 20 },
      { name: "losEnd", kind: "float", initial: 30 },
      { name: "observed", kind: "boolean" },
    ],
    operators: [
      {
        name: "observe",
        pre: F.and(F.gte(N.clock(), N.fl("losStart")), F.lte(N.clock(), N.fl("losEnd"))),
        duration: 2,
        eff: [E.set("observed", [], true)],
      },
    ],
    methods: [
      { task: "Observe", subtasks: [T.waitUntil(N.fl("losStart")), doTask("observe")] },
      {
        task: "ObserveBefore10",
        subtasks: [scoped({ deadline: 10, label: "early" }, T.waitUntil(N.fl("losStart")), doTask("observe"))],
      },
    ],
  };
  const model = createModel(doc, {});

  const plan = planOnce(model, model.createExecState(), { goals: [task("Observe")], weight: 1 });
  assert.equal(plan.status, "success");
  const wait = plan.plan!.steps[0];
  assert.ok(wait.k === "wait" && wait.until === 20, "plan starts by waiting until the window opens (t=20)");
  assert.equal(plan.plan!.makespan, 22, "wait to 20 + 2s observation");

  // execution: the wait blocks until the (injected) clock reaches the window
  let t = 0;
  const planner = new Planner(model, { goals: [task("Observe")], now: () => t });
  planner.tick({ nodes: 100000 });
  t = 5;
  planner.tick({ nodes: 100000 });
  assert.equal(planner.getStatus(), "running", "still waiting at t=5");
  assert.equal(model.read(planner.state, "observed"), false);
  t = 20;
  planner.tick({ nodes: 100000 });
  assert.equal(model.read(planner.state, "observed"), true, "observed once the window opened");
  assert.equal(planner.getStatus(), "succeeded");

  // a 10s deadline around a window that opens at t=20 is impossible — caught at PLAN time
  const impossible = planOnce(model, model.createExecState(), {
    goals: [task("ObserveBefore10")],
    weight: 1,
    collectRejections: true,
  });
  assert.equal(impossible.status, "failure");
  assert.ok(
    (impossible.rejections ?? []).some((r) => r.reason.includes("deadline")),
    "rejection log explains the deadline violation",
  );
});

// ---------------------------------------------------------------- 3. maintain ≥ 15s with cleanup-on-exit

test("maintain-for-at-least-15s: planning models the hold; execution enforces it and runs onExit", () => {
  const doc: DomainDoc = {
    name: "hold",
    fluents: [
      { name: "holding", kind: "boolean" },
      { name: "done", kind: "boolean" },
      { name: "released", kind: "boolean" },
    ],
    operators: [
      { name: "grab", eff: [E.set("holding", [], true)] },
      { name: "finish", pre: F.lit("holding"), eff: [E.set("done", [], true)] },
    ],
    methods: [
      {
        task: "HoldPosition",
        subtasks: [
          doTask("grab"),
          scoped({ maintain: F.lit("holding"), minHold: 15, onExit: "release", label: "hold15" }, doTask("finish")),
        ],
      },
    ],
  };
  const makeModel = () =>
    createModel(doc, {}, {
      executors: {
        release: (api) => {
          api.write("released", [], true);
          return "success";
        },
      },
    });

  // planning models the hold: projected makespan ≥ 15s even though ops are instant
  const model = makeModel();
  const plan = planOnce(model, model.createExecState(), { goals: [task("HoldPosition")], weight: 1 });
  assert.equal(plan.status, "success");
  assert.ok(plan.plan!.makespan >= 15, `projected makespan ${plan.plan!.makespan} models the 15s hold`);

  // success path: scope exit blocks until 15 real seconds elapsed, then runs onExit
  let t = 0;
  const planner = new Planner(model, { goals: [task("HoldPosition")], now: () => t });
  planner.tick({ nodes: 100000 }); // plan, grab
  planner.tick({ nodes: 100000 }); // finish
  t = 7;
  planner.tick({ nodes: 100000 });
  assert.equal(planner.getStatus(), "running", "still holding at t=7");
  assert.equal(model.read(planner.state, "released"), false);
  t = 16;
  planner.tick({ nodes: 100000 });
  assert.equal(planner.getStatus(), "succeeded", "hold completed after 15s");
  assert.equal(model.read(planner.state, "released"), true, "onExit cleanup ran");
  assert.equal(model.read(planner.state, "done"), true);

  // violation path: breaking the maintained condition mid-hold aborts the scope,
  // runs cleanup, and the planner recovers by replanning
  const model2 = makeModel();
  const events: TraceEvent[] = [];
  let t2 = 0;
  const planner2 = new Planner(model2, { goals: [task("HoldPosition")], now: () => t2, trace: (e) => events.push(e) });
  planner2.tick({ nodes: 100000 });
  planner2.tick({ nodes: 100000 });
  t2 = 7;
  planner2.state.set(model2.slotOf("holding"), 0); // dropped it!
  planner2.tick({ nodes: 100000 });
  assert.ok(
    events.some((e) => e.t === "scope.violated" && e.label === "hold15" && e.reason === "maintain"),
    "maintain violation detected",
  );
  assert.equal(model2.read(planner2.state, "released"), true, "cleanup ran on abort too");
  // recovery: replans (grab again) and completes the hold from scratch
  for (let i = 0; i < 8 && planner2.getStatus() !== "succeeded"; i++) {
    t2 += 5;
    planner2.tick({ nodes: 100000 });
  }
  assert.equal(planner2.getStatus(), "succeeded", "recovered after the violation");
  assert.ok(t2 >= 7 + 15, "the re-hold took another 15s of clock");
});

// ---------------------------------------------------------------- 4. escort/follow under a maintained constraint

test("escort: a maintained gap constraint aborts the travel step when violated, then recovers", () => {
  const doc: DomainDoc = {
    name: "follow",
    fluents: [
      { name: "gap", kind: "float", initial: 1 },
      { name: "arrived", kind: "boolean" },
    ],
    operators: [{ name: "travel", eff: [E.set("arrived", [], true)], executor: "travel" }],
    methods: [
      {
        task: "Escort",
        subtasks: [scoped({ maintain: F.lte(N.fl("gap"), 2), label: "escort-gap" }, doTask("travel"))],
      },
    ],
  };
  let progress = 0;
  const model = createModel(doc, {}, { executors: { travel: () => (++progress >= 3 ? "success" : "continue") } });
  const events: TraceEvent[] = [];
  let t = 0;
  const planner = new Planner(model, { goals: [task("Escort")], now: () => t, trace: (e) => events.push(e) });

  planner.tick({ nodes: 100000 }); // plan + start travel (continue)
  t = 1;
  planner.tick({ nodes: 100000 }); // travel continues
  assert.equal(planner.getStatus(), "running");

  t = 2;
  planner.state.set(model.slotOf("gap"), 5); // VIP wandered off
  planner.tick({ nodes: 100000 });
  assert.ok(
    events.some((e) => e.t === "scope.violated" && e.label === "escort-gap"),
    "gap violation aborts the escort scope",
  );
  assert.equal(model.read(planner.state, "arrived"), false, "travel was aborted, not completed");

  // VIP catches up → replanning succeeds and the escort completes
  planner.state.set(model.slotOf("gap"), 1);
  progress = 0;
  for (let i = 0; i < 8 && planner.getStatus() !== "succeeded"; i++) {
    t += 1;
    planner.tick({ nodes: 100000 });
  }
  assert.equal(planner.getStatus(), "succeeded");
  assert.equal(model.read(planner.state, "arrived"), true);
});

test.run();
