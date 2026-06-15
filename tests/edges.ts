import { test } from "uvu";
import * as assert from "uvu/assert";
import {
  DomainDoc,
  E,
  F,
  N,
  Planner,
  Scheduler,
  TraceEvent,
  createModel,
  goal,
  planOnce,
  task,
  validatePlan,
  simulatePlan,
  scoped,
  doTask,
} from "../src/index";

// ---------------------------------------------------------------- search failure modes

test("search limits: node budgets, depth caps, and relaxation-unreachable goals fail cleanly", () => {
  const doc: DomainDoc = {
    name: "limits",
    fluents: [
      { name: "n", kind: "int", initial: 0 },
      { name: "flag", kind: "boolean" },
    ],
    operators: [{ name: "bump", eff: [E.inc("n", [], 1)] }],
    methods: [
      { task: "Deep", subtasks: [doTask("bump"), { do: "Deep" }] }, // infinite recursion (state changes, so no cycle)
    ],
  };
  const model = createModel(doc, {});

  // maxNodes: numeric goal n == 10_000 is reachable but not within 50 nodes
  const capped = planOnce(model, model.createExecState(), {
    goals: [goal(F.eq(N.fl("n"), 10_000))],
    maxNodes: 50,
    collectRejections: true,
  });
  assert.equal(capped.status, "failure");
  assert.ok((capped.rejections ?? []).some((r) => r.reason.includes("node budget")));

  // maxDepth: unbounded recursive method hits the decomposition depth cap
  const deep = planOnce(model, model.createExecState(), { goals: [task("Deep")], maxDepth: 30, collectRejections: true });
  assert.equal(deep.status, "failure");
  assert.ok((deep.rejections ?? []).some((r) => r.reason.includes("depth")));

  // relaxation-unreachable: no operator ever adds flag=true
  const unreachable = planOnce(model, model.createExecState(), {
    goals: [goal(F.lit("flag"))],
    collectRejections: true,
  });
  assert.equal(unreachable.status, "failure");
  assert.ok((unreachable.rejections ?? []).some((r) => r.reason.includes("unreachable")));

  // novelty off still solves
  const ok = planOnce(model, model.createExecState(), {
    goals: [goal(F.eq(N.fl("n"), 3))],
    novelty: false,
    weight: 1,
  });
  assert.equal(ok.status, "success");
  assert.equal(ok.plan!.steps.length, 3);
});

test("decomposition cycle detection rejects unproductive recursion", () => {
  const doc: DomainDoc = {
    name: "cycle",
    fluents: [{ name: "done", kind: "boolean" }],
    operators: [{ name: "finish", pre: F.lit("done"), eff: [] }],
    methods: [
      // Loop expands to itself with NO state change → exact (state, agenda) repeat
      { name: "spin", task: "Loop", subtasks: [{ do: "Loop" }] },
      { name: "stop", task: "Loop", subtasks: [doTask("finish")] },
    ],
  };
  const model = createModel(doc, {});
  const result = planOnce(model, model.createExecState(), { goals: [task("Loop")], collectRejections: true });
  assert.equal(result.status, "failure", "finish's precondition can never hold; spin must not loop forever");
  assert.ok((result.rejections ?? []).some((r) => r.reason.includes("cycle")));
});

// ---------------------------------------------------------------- planner status & failure paths

test("planner: impossible goals reach 'failed' status with plan.failed trace", () => {
  const doc: DomainDoc = {
    name: "imp",
    fluents: [
      { name: "locked", kind: "boolean", initial: true },
      { name: "out", kind: "boolean" },
    ],
    operators: [{ name: "leave", pre: F.not(F.lit("locked")), eff: [E.set("out", [], true)] }],
  };
  const model = createModel(doc, {});
  const events: TraceEvent[] = [];
  const planner = new Planner(model, { goals: [goal(F.lit("out"))], now: () => 0, trace: (e) => events.push(e) });
  planner.tick({ nodes: 100000 });
  assert.equal(planner.getStatus(), "failed");
  assert.ok(events.some((e) => e.t === "plan.failed"));
  // already-satisfied goals: empty plan completes immediately
  const planner2 = new Planner(model, { goals: [goal(F.lit("locked"))], now: () => 0 });
  planner2.tick({ nodes: 100000 });
  assert.equal(planner2.getStatus(), "succeeded");
  // no goals at all → idle
  const planner3 = new Planner(model, { now: () => 0 });
  assert.equal(planner3.tick(), "idle");
});

test("async executors: promise success and rejection are handled across ticks", async () => {
  const doc: DomainDoc = {
    name: "async",
    fluents: [
      { name: "fetched", kind: "boolean" },
      { name: "fallback", kind: "boolean" },
      { name: "netDown", kind: "boolean" },
    ],
    operators: [
      { name: "fetch", pre: F.not(F.lit("netDown")), eff: [E.set("fetched", [], true)], executor: "fetch" },
      { name: "local", pre: F.not(F.lit("fetched")), eff: [E.set("fallback", [], true)] },
    ],
    methods: [
      { name: "remote", task: "Get", pre: F.not(F.lit("netDown")), subtasks: [doTask("fetch")] },
      { name: "offline", task: "Get", subtasks: [doTask("local")] },
    ],
  };
  // success case
  {
    const model = createModel(doc, {}, { executors: { fetch: () => Promise.resolve("success" as const) } });
    let t = 0;
    const planner = new Planner(model, { goals: [task("Get")], now: () => t });
    planner.tick({ nodes: 100000 }); // starts the promise → continue
    assert.equal(planner.getStatus(), "running");
    await Promise.resolve(); // let the promise settle
    t = 1;
    planner.tick({ nodes: 100000 });
    assert.equal(planner.getStatus(), "succeeded");
    assert.equal(model.read(planner.state, "fetched"), true);
  }
  // rejection case: the failure surfaces, telemetry marks the network down,
  // and recovery goes through the offline method
  {
    const model = createModel(doc, {}, { executors: { fetch: () => Promise.reject(new Error("network")) } });
    let t = 0;
    const planner = new Planner(model, { goals: [task("Get")], now: () => t });
    planner.tick({ nodes: 100000 });
    await Promise.resolve();
    t = 1;
    planner.tick({ nodes: 100000 }); // consume the rejection → step failure → repair planning
    planner.state.set(model.slotOf("netDown"), 1); // world feedback makes 'remote' inapplicable
    for (let i = 0; i < 6 && planner.getStatus() !== "succeeded"; i++) {
      t += 1;
      planner.tick({ nodes: 100000 });
    }
    assert.equal(planner.getStatus(), "succeeded");
    assert.equal(model.read(planner.state, "fallback"), true, "recovered through the offline method");
    assert.equal(model.read(planner.state, "fetched"), false);
  }
});

test("drift detection: falling behind the projected timeline triggers recovery", () => {
  const doc: DomainDoc = {
    name: "drift",
    fluents: [{ name: "there", kind: "boolean" }],
    operators: [{ name: "march", duration: 2, eff: [E.set("there", [], true)], executor: "never" }],
  };
  // executor never finishes → actual time blows past the 2s projection
  const model = createModel(doc, {}, { executors: { never: () => "continue" } });
  const events: TraceEvent[] = [];
  let t = 0;
  const planner = new Planner(model, {
    goals: [goal(F.lit("there"))],
    now: () => t,
    driftTolerance: 1,
    trace: (e) => events.push(e),
  });
  planner.tick({ nodes: 100000 }); // plan + start marching
  t = 5; // 5s elapsed vs 2s projected end (+1s tolerance)
  planner.tick({ nodes: 100000 });
  assert.ok(events.some((e) => e.t === "drift" && e.behindSeconds > 1), "drift event raised");
  assert.ok(events.some((e) => e.t === "step.fail"), "drifting step aborted for recovery");
});

// ---------------------------------------------------------------- validatePlan over scope/wait steps

test("validatePlan handles scopes and waits: deadline and maintain diagnoses", () => {
  const doc: DomainDoc = {
    name: "vscope",
    fluents: [
      { name: "shield", kind: "boolean", initial: true },
      { name: "done", kind: "boolean" },
    ],
    operators: [
      { name: "charge", duration: 6, eff: [E.set("done", [], true)] },
      { name: "dropShield", eff: [E.set("shield", [], false)] },
    ],
    methods: [
      {
        task: "Strike",
        subtasks: [scoped({ deadline: 10, maintain: F.lit("shield"), minHold: 1, label: "covered" }, doTask("charge"))],
      },
    ],
  };
  const model = createModel(doc, {});
  const result = planOnce(model, model.createExecState(), { goals: [task("Strike")], weight: 1 });
  assert.equal(result.status, "success");

  // valid in the original state (covers scopeEnter/scopeExit/op walk in the validator)
  assert.equal(validatePlan(model, model.createExecState(), result.plan!), []);
  const sim = simulatePlan(model, model.createExecState(), result.plan!);
  assert.ok(sim.ok);
  assert.equal(model.read(sim.end, "done"), true);

  // maintain violated at entry: shield already down
  const noShield = model.createExecState();
  noShield.set(model.slotOf("shield"), 0);
  const diags = validatePlan(model, noShield, result.plan!);
  assert.ok(diags.length > 0);
  assert.ok(diags[0].message.includes("maintain"), diags[0].message);

  // deadline violated: tighten the deadline below the charge duration and re-plan → planning already
  // rejects it; validate the *old* plan against a domain variant via direct mutation of scope deadline
  const tight = result.plan!;
  const enter = tight.steps.find((s) => s.k === "scopeEnter");
  assert.ok(enter && enter.k === "scopeEnter");
  const saved = enter.scope.deadlineRel;
  enter.scope.deadlineRel = 3; // 6s charge > 3s deadline
  const dl = validatePlan(model, model.createExecState(), tight);
  assert.ok(dl.some((d) => d.message.includes("deadline")), JSON.stringify(dl));
  enter.scope.deadlineRel = saved;
});

// ---------------------------------------------------------------- scheduler edge

test("scheduler: empty scheduler and zero-budget ticks are safe", () => {
  const scheduler = new Scheduler();
  scheduler.tick(1); // no agents: no-op
  const doc: DomainDoc = {
    name: "z",
    fluents: [{ name: "ok", kind: "boolean" }],
    operators: [{ name: "go", eff: [E.set("ok", [], true)] }],
  };
  const model = createModel(doc, {});
  const p = new Planner(model, { goals: [goal(F.lit("ok"))], now: () => 0 });
  scheduler.add(p);
  for (let i = 0; i < 4; i++) scheduler.tick(0.5);
  assert.equal(p.getStatus(), "succeeded");
});

test.run();
