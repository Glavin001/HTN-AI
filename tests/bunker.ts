import { test } from "uvu";
import * as assert from "uvu/assert";
import { Planner, goal, planOnce, simulatePlan, type Model, type Plan, type Snap } from "../src/index";
import { bunkerDomain, bunkerModel, starGoal, breachGoal, c4Goal, N_, BUNKER_NODES } from "../scenarios/bunker";

/**
 * Bunker Heist — the classic "Acquire key → C4 → Breach → Star" mission, but with
 * NONE of the solution encoded. The goal is one declarative fact (`hasStar`); the
 * domain has only primitive operators (goto / pickup_key / unlock_storage /
 * pickup_c4 / place_c4 / detonate / pickup_star); the two gates (locked storage,
 * sealed bunker) are preconditions, not scripted steps. These tests pin that the
 * planner DISCOVERS the whole chain — and that the gates are real, not cosmetic.
 */

const opNames = (plan: Plan): string[] =>
  plan.steps.map((s) => (s.k === "op" ? s.g.op.name : "")).filter((n) => n.length > 0);

const driveLabels = (model: Model): { status: string; labels: string[]; state: Snap } => {
  let t = 0;
  const labels: string[] = [];
  const planner = new Planner(model, {
    goals: [goal(starGoal())],
    now: () => t,
    seed: 1,
    trace: (e) => { if (e.t === "step.done") labels.push(e.label); },
  });
  for (let i = 0; i < 5000; i++) {
    const st = planner.getStatus();
    if (st === "succeeded" || st === "failed") break;
    t += 1;
    planner.tick({ ms: 20 });
  }
  return { status: planner.getStatus(), labels, state: planner.state };
};

test("bunker: the domain prescribes NOTHING — no compound tasks, no methods", () => {
  // the only knowledge is primitive operators; methods/compounds could encode the answer
  assert.equal(bunkerDomain.methods?.length ?? 0, 0, "there must be no methods (no scripted decomposition)");
  assert.equal(bunkerDomain.compounds?.length ?? 0, 0, "there must be no compound tasks");
});

test("bunker: from just `hasStar`, the planner DISCOVERS the full key→C4→breach→star chain", () => {
  const model = bunkerModel();
  const res = planOnce(model, model.createExecState(), { goals: [goal(starGoal())], weight: 2, heuristic: "hadd", maxNodes: 200_000 });
  assert.equal(res.status, "success");
  const ops = opNames(res.plan!);
  // every causally-required action was discovered — none of them named in the goal
  for (const required of ["pickup_key", "unlock_storage", "pickup_c4", "place_c4", "detonate", "pickup_star"]) {
    assert.ok(ops.includes(required), `planner should discover it must ${required}`);
  }
  // it also discovered it must travel (edge-by-edge movement, not a teleport)
  assert.ok(ops.filter((o) => o === "goto").length >= 8, "planner should discover the spatial route");
});

test("bunker: the discovered plan is causally valid end-to-end (gates respected in simulation)", () => {
  const model = bunkerModel();
  const res = planOnce(model, model.createExecState(), { goals: [goal(starGoal())], weight: 2, heuristic: "hadd" });
  assert.equal(res.status, "success");
  // simulatePlan re-checks every precondition against the evolving state; if any
  // gate were entered early (e.g. into the sealed bunker before the breach) it
  // would surface a diagnosis here.
  const sim = simulatePlan(model, model.createExecState(), res.plan!);
  assert.ok(sim.ok, `simulation should hold every precondition (got ${sim.diagnoses.length} diagnoses)`);
});

test("bunker: the reactive Planner executes the mission to completion", () => {
  const model = bunkerModel();
  const out = driveLabels(model);
  assert.equal(out.status, "succeeded");
  assert.equal(model.read(out.state, "hasStar"), true);
  assert.equal(model.read(out.state, "agentAt"), N_.STAR, "the agent ends up standing on the star");
  // the order is causal: the key comes before unlocking, the breach before entering
  const i = (label: string) => out.labels.findIndex((l) => l.startsWith(label));
  assert.ok(i("pickup_key") < i("unlock_storage"), "must hold the key before unlocking storage");
  assert.ok(i("pickup_c4") < i("place_c4"), "must hold the C4 before planting it");
  assert.ok(i("place_c4") < i("detonate"), "must plant the C4 before detonating");
  assert.ok(i("detonate") < i("pickup_star"), "must breach the bunker before taking the star");
});

test("bunker: GATE IS REAL — with no key, the star is provably unreachable", () => {
  // remove the key from the world: storage can never be unlocked, so the C4 is
  // sealed away, so the bunker can never be breached, so the star is unattainable.
  const model = bunkerModel({ keyOnTable: false });
  const res = planOnce(model, model.createExecState(), { goals: [goal(starGoal())], weight: 2, heuristic: "hadd", maxNodes: 200_000 });
  assert.equal(res.status, "failure", "without the key the gated chain has no solution");
});

test("bunker: the planner ADAPTS to the world — a pre-breached bunker skips the whole chain", () => {
  const model = bunkerModel({ bunkerBreached: true });
  const out = driveLabels(model);
  assert.equal(out.status, "succeeded");
  assert.equal(model.read(out.state, "hasStar"), true);
  // nothing about key/C4/detonation is replayed — it walks straight in
  assert.not.ok(out.labels.some((l) => l.startsWith("detonate")), "no detonation when already breached");
  assert.not.ok(out.labels.some((l) => l.startsWith("pickup_key")), "no key fetch when storage isn't needed");
  assert.ok(out.labels.length <= 6, `a pre-breached run is short (was ${out.labels.length} steps)`);
});

test("bunker: sub-missions fall out of the SAME operators — C4-only and breach-only", () => {
  const model = bunkerModel();
  const c4 = planOnce(model, model.createExecState(), { goals: [goal(c4Goal())], weight: 2, heuristic: "hadd" });
  assert.equal(c4.status, "success");
  const c4ops = opNames(c4.plan!);
  assert.ok(c4ops.includes("pickup_c4"), "C4-only goal still discovers the unlock→enter→grab chain");
  assert.ok(c4ops.includes("unlock_storage"), "and that it must unlock the storage to reach it");
  assert.not.ok(c4ops.includes("detonate"), "C4-only goal must NOT over-plan into a breach");

  const breach = planOnce(model, model.createExecState(), { goals: [goal(breachGoal())], weight: 2, heuristic: "hadd" });
  assert.equal(breach.status, "success");
  const breachOps = opNames(breach.plan!);
  assert.ok(breachOps.includes("detonate"), "breach goal discovers the detonation");
  assert.not.ok(breachOps.includes("pickup_star"), "breach goal must NOT over-plan into taking the star");
});

test("bunker: model exposes a consistent waypoint graph", () => {
  const model = bunkerModel();
  assert.equal(BUNKER_NODES.length, 9, "nine waypoints");
  // adjacency is symmetric (undirected walk graph)
  const st = model.createExecState();
  assert.equal(model.read(st, "adj", N_.COURTYARD, N_.SAFE), model.read(st, "adj", N_.SAFE, N_.COURTYARD));
});

test.run();
