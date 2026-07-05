/**
 * Acceptance suite for the "discrete executive" integration spec:
 *  - the ~6-operator demo domain (GoTo/Breach/TakeCover/Suppress/Regroup/Idle)
 *    plans and replans correctly in headless runs;
 *  - plan lifecycle arrives as STRUCTURED events (PlanEventStream): created /
 *    step started / completed / invalidated / failed, with machine-readable
 *    reasons instead of strings;
 *  - replans complete in well under 10ms.
 */

import { test } from "uvu";
import * as assert from "uvu/assert";
import {
  DomainDoc,
  E,
  F,
  Model,
  PlanEvent,
  PlanEventStream,
  Planner,
  createModel,
  goal,
  planOnce,
  task,
} from "../src/index";
import { directorModel, directorWorld, edgeKey } from "./director-fixture";

// ---------------------------------------------------------------- helpers

type Created = PlanEvent & { t: "plan.created" };
type Invalidated = PlanEvent & { t: "plan.invalidated" };
type Failed = PlanEvent & { t: "plan.failed" };

const createdOf = (evts: PlanEvent[]): Created[] => evts.filter((e) => e.t === "plan.created") as Created[];
const invalidatedOf = (evts: PlanEvent[]): Invalidated[] => evts.filter((e) => e.t === "plan.invalidated") as Invalidated[];
const opLabels = (e: Created): string[] => e.steps.filter((s) => s.kind === "op").map((s) => s.label);

const flag = (planner: Planner, fluent: string): boolean => planner.state.get(planner.model.slotOf(fluent)) === 1;
/** announced world change: dirty write, triggers reactive replanning */
const announce = (planner: Planner, fluent: string, value: number): void =>
  planner.state.set(planner.model.slotOf(fluent), value);
/** silent live change: bypasses dirty-tracking, discovered only by re-checks */
const sneak = (planner: Planner, fluent: string, value: number): void => {
  planner.state.buffer[planner.model.slotOf(fluent)] = value;
};

const BUDGET = { nodes: 200_000 };

interface Mission {
  planner: Planner;
  stream: PlanEventStream;
  clock: { t: number };
}

function mission(model: Model, goals: Parameters<typeof planOnce>[2]["goals"], agent = "alpha"): Mission {
  const clock = { t: 0 };
  const stream = new PlanEventStream();
  const planner = new Planner(model, { goals, now: () => clock.t, weight: 1, collectRejections: true });
  stream.attach(planner, agent);
  return { planner, stream, clock };
}

/** tick until succeeded/failed; dt 1.2s per tick lets the 1s suppressFire executor finish */
function runToEnd(m: Mission, maxTicks = 30): void {
  for (let i = 0; i < maxTicks && m.planner.getStatus() !== "succeeded" && m.planner.getStatus() !== "failed"; i++) {
    m.planner.tick(BUDGET);
    m.clock.t += 1.2;
  }
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1];

// ---------------------------------------------------------------- plans correctly

test("director: plans the cheapest assault (breach route) and streams the full lifecycle", () => {
  const m = mission(directorModel(directorWorld()), [task("Directive")]);
  runToEnd(m);

  assert.equal(m.planner.getStatus(), "succeeded");
  assert.ok(flag(m.planner, "regrouped"), "mission goal reached");

  const events = m.stream.drain();
  const created = createdOf(events);
  assert.equal(created.length, 1, "one plan start to finish");
  assert.equal(created[0].via, "initial");
  assert.equal(opLabels(created[0]), ["GoTo(doorstep)", "Breach()", "GoTo(room)", "TakeCover(cover1)", "Suppress()", "Regroup(rally)"]);
  assert.ok(created[0].cost > 0 && created[0].makespan > 0);

  // every op runs as started→completed in plan order, then the plan completes
  const kinds = events.map((e) => e.t);
  assert.equal(kinds[0], "plan.created");
  assert.equal(kinds[kinds.length - 1], "plan.completed");
  const startedLabels = events.filter((e) => e.t === "step.started").map((e) => (e as PlanEvent & { t: "step.started" }).label);
  const completedLabels = events.filter((e) => e.t === "step.completed").map((e) => (e as PlanEvent & { t: "step.completed" }).label);
  assert.equal(startedLabels, opLabels(created[0]));
  assert.equal(completedLabels, opLabels(created[0]));

  // stamps: one agent, one plan id, strictly increasing seq, JSON-clean payloads
  assert.ok(events.every((e) => e.agent === "alpha" && e.planId === 1));
  assert.ok(events.every((e, i) => i === 0 || e.seq > events[i - 1].seq));
  assert.equal(JSON.parse(JSON.stringify(events)), events, "events survive a JSON round-trip unchanged");
});

// ---------------------------------------------------------------- replans: belief change flips the method (MTR improve)

test("director: threat appearing mid-hold invalidates the plan with a world-changed reason", () => {
  const m = mission(directorModel(directorWorld(), { threatKnown: false }), [task("Directive")]);

  m.planner.tick(BUDGET); // plan hold [GoTo(rally), Idle], execute GoTo(rally)
  m.clock.t += 1.2;
  announce(m.planner, "threatKnown", 1); // perception layer reports contact
  runToEnd(m);

  assert.equal(m.planner.getStatus(), "succeeded");
  assert.ok(flag(m.planner, "regrouped"), "switched from holding to the assault");

  const events = m.stream.drain();
  const created = createdOf(events);
  assert.equal(created.length, 2);
  assert.equal(opLabels(created[0]), ["GoTo(rally)", "Idle()"]);
  assert.equal(created[1].via, "improve");
  assert.equal(opLabels(created[1]), ["TakeCover(cover1)", "Suppress()", "Regroup(rally)"]);

  const inv = invalidatedOf(events);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].planId, 1, "the hold plan was invalidated");
  assert.equal(inv[0].reason, { kind: "world-changed", fluents: ["threatKnown"] });
});

// ---------------------------------------------------------------- replans: silent live-query change → precondition failure → repair

test("director: nav edge breaking under the plan repairs from the failure point with a structured cause", () => {
  const world = directorWorld();
  const m = mission(directorModel(world), [task("Directive")]);

  m.planner.tick(BUDGET); // GoTo(doorstep)
  m.clock.t += 1.2;
  m.planner.tick(BUDGET); // Breach()
  m.clock.t += 1.2;
  world.nav.blocked.add(edgeKey("doorstep", "room")); // rubble: the nav stub changes, nothing announced
  runToEnd(m);

  assert.equal(m.planner.getStatus(), "succeeded");
  assert.ok(flag(m.planner, "regrouped"), "rerouted and finished the mission");

  const events = m.stream.drain();
  const inv = invalidatedOf(events);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].reason.kind, "step-failed");
  const reason = inv[0].reason as Extract<Invalidated["reason"], { kind: "step-failed" }>;
  assert.equal(reason.cause, "precondition");
  assert.equal(reason.step, "GoTo(room)");

  const created = createdOf(events);
  assert.equal(created.length, 2);
  assert.equal(created[1].via, "repair");
  assert.equal(opLabels(created[1])[0], "GoTo(start)", "repair backtracks out of the dead end");
  assert.ok(!opLabels(created[1]).includes("GoTo(room)"), "repair avoids the broken edge");
});

// ---------------------------------------------------------------- replans: oracle re-weight (announced) → better plan installed

test("director: kinocat oracle re-weighting swaps in the cheaper flank route", () => {
  const world = directorWorld();
  const m = mission(directorModel(world), [goal(F.lit("regrouped"))]);

  m.planner.tick(BUDGET); // door-route plan, GoTo(doorstep) executed
  m.clock.t += 1.2;
  world.oracle.set(edgeKey("start", "flank"), 0.2); // traversal oracle re-weights…
  world.oracle.set(edgeKey("flank", "cover1"), 0.2);
  announce(m.planner, "navVersion", 1); // …and the host announces it
  runToEnd(m);

  assert.equal(m.planner.getStatus(), "succeeded");
  const events = m.stream.drain();
  const inv = invalidatedOf(events);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].reason, { kind: "world-changed", fluents: ["navVersion"] });
  const created = createdOf(events);
  assert.equal(created.length, 2);
  assert.equal(created[1].via, "improve");
  assert.ok(opLabels(created[1]).includes("GoTo(flank)"), "new plan takes the now-cheap flank");
});

// ---------------------------------------------------------------- planning failure arrives structured

test("director: unreachable goals produce plan.failed with structured rejections", () => {
  const world = directorWorld();
  world.nav.blocked.add(edgeKey("doorstep", "room"));
  world.nav.blocked.add(edgeKey("flank", "cover1"));
  world.nav.blocked.add(edgeKey("rally", "cover1"));
  const m = mission(directorModel(world), [task("Directive")]);
  runToEnd(m);

  assert.equal(m.planner.getStatus(), "failed");
  const events = m.stream.drain();
  assert.equal(events.length, 1);
  assert.equal(events[0].t, "plan.failed");
  const failed = events[0] as Failed;
  assert.equal(failed.planId, 0, "failed before any plan existed");
  assert.equal(failed.reason.kind, "search-exhausted");
  const rejections = (failed.reason as Extract<Failed["reason"], { kind: "search-exhausted" }>).rejections;
  assert.ok(rejections.length > 0, "collectRejections surfaces why");
  assert.ok(rejections.some((r) => r.reason === "method precondition failed"));
});

// ---------------------------------------------------------------- executing-condition failure (verify cause)

test("director: losing the target mid-suppression invalidates with cause 'verify', then falls back to hold", () => {
  const m = mission(directorModel(directorWorld(), { at: "cover1", inCover: true }), [task("Directive")]);

  m.planner.tick(BUDGET); // plan [Suppress, Regroup], Suppress starts (takes ~1s)
  sneak(m.planner, "threatKnown", 0); // target drops out of sight, unannounced
  m.clock.t += 0.2;
  runToEnd(m);

  assert.equal(m.planner.getStatus(), "succeeded");
  const events = m.stream.drain();
  const inv = invalidatedOf(events);
  assert.equal(inv.length, 1);
  const reason = inv[0].reason as Extract<Invalidated["reason"], { kind: "step-failed" }>;
  assert.equal(reason.kind, "step-failed");
  assert.equal(reason.cause, "verify");
  assert.equal(reason.step, "Suppress()");

  // assault is impossible without a known threat: repair falls back to a fresh hold plan
  const created = createdOf(events);
  assert.equal(created.length, 2);
  assert.equal(created[1].via, "initial");
  assert.equal(opLabels(created[1]), ["GoTo(rally)", "Idle()"]);
});

// ---------------------------------------------------------------- scope deadline (scope cause + enrichment)

test("director: blowing the breach window invalidates with the violated scope attached", () => {
  const m = mission(directorModel(directorWorld(), { at: "cover1", inCover: true }), [task("TimedClear")]);

  m.planner.tick(BUDGET); // [enter clear-window, Suppress, exit], Suppress starts
  m.clock.t = 3; // stall past the 2s deadline
  m.planner.tick(BUDGET);

  const events = m.stream.drain();
  const created = createdOf(events);
  assert.ok(created[0].steps.some((s) => s.kind === "scopeEnter" && s.start === null), "scope steps carried as data");
  const inv = invalidatedOf(events);
  assert.equal(inv.length, 1);
  const reason = inv[0].reason as Extract<Invalidated["reason"], { kind: "step-failed" }>;
  assert.equal(reason.cause, "scope");
  assert.equal(reason.scope, { label: "clear-window", violated: "deadline" });
});

// ---------------------------------------------------------------- executor failure cause

test("director: an executor returning failure invalidates with cause 'executor'", () => {
  const doc: DomainDoc = {
    name: "faulty",
    fluents: [{ name: "done", kind: "boolean" }],
    operators: [{ name: "Try", eff: [E.set("done", [], true)], executor: "explode" }],
  };
  const model = createModel(doc, {}, { executors: { explode: () => "failure" } });
  const stream = new PlanEventStream();
  const planner = new Planner(model, { goals: [goal(F.lit("done"))], now: () => 0 });
  stream.attach(planner, "omega");

  planner.tick(BUDGET);
  const events = stream.drain();
  const inv = invalidatedOf(events);
  assert.equal(inv.length, 1);
  assert.equal((inv[0].reason as Extract<Invalidated["reason"], { kind: "step-failed" }>).cause, "executor");
});

// ---------------------------------------------------------------- multi-agent merged stream

test("director: one stream merges many agents with per-agent plan ids and a global order", () => {
  const world = directorWorld();
  const pushed: PlanEvent[] = [];
  const stream = new PlanEventStream({ onEvent: (e) => pushed.push(e) });
  const clock = { t: 0 };

  const alpha = new Planner(directorModel(world), { goals: [goal(F.lit("regrouped"))], now: () => clock.t, weight: 1 });
  const bravo = new Planner(directorModel(world, { at: "cover1", inCover: true }), { goals: [goal(F.lit("threatDown"))], now: () => clock.t, weight: 1 });
  stream.attach(alpha, "alpha");
  stream.attach(bravo, "bravo");

  for (let i = 0; i < 30 && (alpha.getStatus() !== "succeeded" || bravo.getStatus() !== "succeeded"); i++) {
    if (alpha.getStatus() !== "succeeded") alpha.tick(BUDGET);
    if (bravo.getStatus() !== "succeeded") bravo.tick(BUDGET);
    clock.t += 1.2;
  }
  assert.equal(alpha.getStatus(), "succeeded");
  assert.equal(bravo.getStatus(), "succeeded");

  const events = stream.drain();
  assert.ok(events.some((e) => e.agent === "alpha") && events.some((e) => e.agent === "bravo"));
  assert.ok(events.every((e, i) => i === 0 || e.seq > events[i - 1].seq), "global order");
  assert.ok(events.every((e) => e.planId === 1), "each agent ran exactly one plan");
  assert.equal(pushed.length, events.length, "push mode delivered every event");
  assert.equal(stream.pending, 0);
  assert.equal(stream.drain(), [], "drain clears the buffer");
});

// ---------------------------------------------------------------- perf gate (<10ms replans, spec: 3–5 step plans)

test("director perf: mission searches and reactive replans complete in <10ms (median)", () => {
  const world = directorWorld();
  const model = directorModel(world);
  const req = { goals: [goal(F.lit("regrouped"))], weight: 1 };
  for (let i = 0; i < 10; i++) planOnce(model, model.createExecState(), req); // JIT warm-up

  const searchMs: number[] = [];
  for (let i = 0; i < 100; i++) {
    const s = performance.now();
    const r = planOnce(model, model.createExecState(), req);
    searchMs.push(performance.now() - s);
    assert.equal(r.status, "success");
  }
  assert.ok(median(searchMs) < 10, `median full-mission search ${median(searchMs).toFixed(3)}ms should be < 10ms`);

  // end-to-end: announced world change → improve search → plan swap, inside one
  // tick. One compiled model, many replans — matching how a game would run it.
  const w = directorWorld();
  const m = directorModel(w);
  const replanMs: number[] = [];
  for (let i = 0; i < 27; i++) {
    w.oracle.set(edgeKey("start", "flank"), 10); // restore pre-re-weight costs
    w.oracle.set(edgeKey("flank", "cover1"), 10);
    let t = 0;
    const p = new Planner(m, { goals: [goal(F.lit("regrouped"))], now: () => t, weight: 1 });
    p.tick(BUDGET); // door-route plan installed, first step executed
    w.oracle.set(edgeKey("start", "flank"), 0.2);
    w.oracle.set(edgeKey("flank", "cover1"), 0.2);
    p.state.set(m.slotOf("navVersion"), i + 1);
    t = 1;
    const s = performance.now();
    p.tick({ ms: 50 });
    if (i >= 2) replanMs.push(performance.now() - s); // first laps warm the JIT
    const plan = p.getPlan();
    assert.ok(plan && plan.steps.some((st) => st.k === "op" && m.describeGroundOp(st.g) === "GoTo(flank)"), "replanned via the flank");
  }
  assert.ok(median(replanMs) < 10, `median replan tick ${median(replanMs).toFixed(3)}ms should be < 10ms`);
});

test.run();
