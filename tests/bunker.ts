import { test } from "uvu";
import * as assert from "uvu/assert";
import { F, Planner, goal, planOnce, simulatePlan, type Formula, type Model, type Plan, type Snap } from "../src/index";
import { bunkerDomain, bunkerModel, starGoal, breachGoal, c4Goal, N_, BUNKER_NODES, type BunkerSetup } from "../scenarios/bunker";

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

// ---------------------------------------------------------------------------
// Ported from vibe-city's bunker tests (src/tests/bunker-domain.spec.ts and
// bunker_planner.spec.ts). Those drove a hand-authored Fluid-HTN domain whose
// nested sequences encoded the answer; the assertions, though, describe the
// INTENDED behaviour of the mission, so they port cleanly onto honest goal
// search. The semantic upgrades here:
//   • goals are declarative formulas, not a `{ hasStar: true }` recipe object;
//   • movement is edge-by-edge (so vibe-city's single "MOVE x" becomes a `goto`
//     to x — we render the destination as `MOVE x` so the assertions read the
//     same — and extra interior hops may appear, which subsequence checks allow);
//   • the safe zone is `safe_spot` here (vibe-city called it `blast_safe_zone`).
// ---------------------------------------------------------------------------

/** Render a discovered plan as vibe-city-style tokens: `MOVE <dest>` / `PICKUP_KEY` / … */
function planTokens(model: Model, plan: Plan): string[] {
  const map: Record<string, string> = {
    pickup_key: "PICKUP_KEY",
    unlock_storage: "UNLOCK_STORAGE",
    pickup_c4: "PICKUP_C4",
    place_c4: "PLACE_C4",
    detonate: "DETONATE",
    pickup_star: "PICKUP_STAR",
  };
  const out: string[] = [];
  for (const s of plan.steps) {
    if (s.k !== "op") continue;
    if (s.g.op.name === "goto") out.push(`MOVE ${model.entityName(s.g.b[s.g.b.length - 1])}`);
    else out.push(map[s.g.op.name] ?? s.g.op.name);
  }
  return out;
}

/** Plan a declarative goal over a fresh model and return the token lines. */
function planLines(g: Formula, setup: BunkerSetup = {}): string[] {
  const model = bunkerModel(setup);
  const res = planOnce(model, model.createExecState(), { goals: [goal(g)], weight: 2, heuristic: "hadd", maxNodes: 300_000 });
  assert.equal(res.status, "success", "expected a plan to be found");
  return planTokens(model, res.plan!);
}

/** Assert the given tokens appear as an ordered subsequence of `lines`. */
function expectInOrder(lines: string[], tokens: string[]): void {
  let prev = -1;
  for (const t of tokens) {
    const idx = lines.indexOf(t);
    assert.ok(idx >= 0, `token "${t}" missing from plan: ${JSON.stringify(lines)}`);
    assert.ok(idx > prev, `token "${t}" out of order in plan: ${JSON.stringify(lines)}`);
    prev = idx;
  }
}

const posGoal = (node: string): Formula => F.lit("agentAt", [], node);

test("bunker(ported): adjacent move via positional goal (courtyard → bunker_door)", () => {
  const lines = planLines(posGoal(N_.BUNKER_DOOR));
  assert.ok(lines.length >= 1);
  assert.equal(lines[0], "MOVE bunker_door");
});

test("bunker(ported): goal hasKey generates the move-to-table + pickup sequence", () => {
  const lines = planLines(F.lit("hasKey"));
  assert.equal(lines[0], "MOVE table_area");
  assert.ok(lines.includes("PICKUP_KEY"));
});

test("bunker(ported): hasC4 unlocks storage and picks up C4 (key before unlock before C4)", () => {
  const lines = planLines(c4Goal());
  expectInOrder(lines, ["MOVE table_area", "PICKUP_KEY"]);
  assert.ok(lines.includes("UNLOCK_STORAGE"));
  assert.ok(lines.includes("PICKUP_C4"));
  expectInOrder(lines, ["UNLOCK_STORAGE", "PICKUP_C4"]);
});

test("bunker(ported): bunkerBreached places C4 then detonates", () => {
  const lines = planLines(breachGoal());
  assert.ok(lines.includes("PLACE_C4"));
  assert.ok(lines.includes("DETONATE"));
  expectInOrder(lines, ["PLACE_C4", "DETONATE"]);
});

test("bunker(ported): hasStar completes the full mission in causal order", () => {
  const lines = planLines(starGoal());
  expectInOrder(lines, [
    "MOVE table_area",
    "PICKUP_KEY",
    "UNLOCK_STORAGE",
    "PICKUP_C4",
    "PLACE_C4",
    "DETONATE",
    "MOVE bunker_interior",
    "MOVE star_pos",
    "PICKUP_STAR",
  ]);
  assert.equal(lines[lines.length - 1], "PICKUP_STAR");
});

test("bunker(ported): hasStar ∧ return-to-table — fetches the star, then walks home", () => {
  // a CONJUNCTIVE declarative goal: hold the star AND end up at the table
  const lines = planLines(F.and(starGoal(), posGoal(N_.TABLE)));
  const starIdx = lines.indexOf("PICKUP_STAR");
  const returnIdx = lines.lastIndexOf("MOVE table_area");
  assert.ok(starIdx >= 0);
  assert.ok(returnIdx > starIdx, "the return to the table must come after taking the star");
  assert.equal(lines[lines.length - 1], "MOVE table_area");
});

test("bunker(ported): pre-breached bunker — skip the whole chain, just fetch the star", () => {
  const lines = planLines(starGoal(), { bunkerBreached: true });
  for (const skip of ["PLACE_C4", "DETONATE", "PICKUP_KEY", "UNLOCK_STORAGE", "PICKUP_C4"]) {
    assert.not.ok(lines.includes(skip), `should not ${skip} when already breached`);
  }
  assert.ok(lines.includes("MOVE bunker_interior"));
  assert.ok(lines.includes("MOVE star_pos"));
  assert.equal(lines[lines.length - 1], "PICKUP_STAR");
});

test("bunker(ported): C4 already placed — skip key/storage, detonate from safe, then star", () => {
  const lines = planLines(starGoal(), { c4Placed: true });
  for (const skip of ["PICKUP_KEY", "UNLOCK_STORAGE", "PICKUP_C4", "PLACE_C4"]) {
    assert.not.ok(lines.includes(skip), `should not ${skip} when C4 is already placed`);
  }
  assert.ok(lines.includes("DETONATE"));
  // must retreat to a safe distance before detonating
  expectInOrder(lines, ["MOVE safe_spot", "DETONATE"]);
  assert.ok(lines.includes("MOVE bunker_interior"));
  assert.ok(lines.includes("MOVE star_pos"));
  assert.equal(lines[lines.length - 1], "PICKUP_STAR");
});

test("bunker(ported): storage already unlocked — skip key, straight to the C4", () => {
  const lines = planLines(starGoal(), { storageUnlocked: true });
  assert.not.ok(lines.includes("PICKUP_KEY"));
  assert.not.ok(lines.includes("UNLOCK_STORAGE"));
  for (const need of ["MOVE storage_door", "MOVE c4_table", "PICKUP_C4", "PLACE_C4", "MOVE safe_spot", "DETONATE", "MOVE bunker_interior", "MOVE star_pos", "PICKUP_STAR"]) {
    assert.ok(lines.includes(need), `should still ${need}`);
  }
  assert.equal(lines[lines.length - 1], "PICKUP_STAR");
});

test("bunker(ported): positional goal storage_interior — key + unlock + enter, nothing more", () => {
  const lines = planLines(posGoal(N_.STORAGE_INT));
  assert.ok(lines.includes("PICKUP_KEY"));
  assert.ok(lines.includes("UNLOCK_STORAGE"));
  assert.ok(lines.includes("MOVE storage_interior"));
  for (const skip of ["PICKUP_C4", "PLACE_C4", "DETONATE", "PICKUP_STAR", "MOVE star_pos", "MOVE bunker_interior"]) {
    assert.not.ok(lines.includes(skip), `positional goal should not over-plan into ${skip}`);
  }
  assert.equal(lines[lines.length - 1], "MOVE storage_interior", "ends standing in the storage");
});

test("bunker(ported): hasKey ∧ hasC4 (no star) — collects both, stops at the C4", () => {
  const lines = planLines(F.and(F.lit("hasKey"), F.lit("hasC4")));
  expectInOrder(lines, ["MOVE table_area", "PICKUP_KEY", "MOVE storage_door", "UNLOCK_STORAGE", "MOVE c4_table", "PICKUP_C4"]);
  for (const skip of ["PICKUP_STAR", "PLACE_C4", "DETONATE", "MOVE star_pos"]) {
    assert.not.ok(lines.includes(skip), `should not ${skip} for a key+C4 goal`);
  }
  assert.equal(lines[lines.length - 1], "PICKUP_C4");
});

test("bunker(ported): performance baseline — hasStar plans fast enough for real-time", () => {
  // vibe-city logged a throughput baseline; we keep a generous wall-clock bound so
  // it documents speed without being flaky on slow/Windows CI. (Local: ~0.6ms.)
  const iterations = 200;
  const start = Date.now();
  for (let i = 0; i < iterations; i++) {
    const model = bunkerModel();
    const res = planOnce(model, model.createExecState(), { goals: [goal(starGoal())], weight: 2, heuristic: "hadd" });
    assert.equal(res.status, "success");
  }
  const avgMs = (Date.now() - start) / iterations;
  assert.ok(avgMs < 25, `full-mission planning should stay well under 25ms/plan (was ${avgMs.toFixed(2)}ms)`);
});

test.run();
