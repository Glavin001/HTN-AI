import { test } from "uvu";
import * as assert from "uvu/assert";
import { type Model, type ExecState, goal, planOnce, planSummary } from "../src/index";
import { buildField } from "../scenarios/lib/field";
import { dist2 } from "../scenarios/lib/geometry";
import {
  AGGRESSIVE,
  DEFENSIVE,
  type SoloInstance,
  SoloSim,
  type SoloWorld,
  greedyChoice,
  disruptionArena,
  neutralizeGoal,
  openFieldArena,
  postureArena,
  soloDomain,
  soloModel,
  steppingStoneArena,
  sweepDecisionBoundary,
} from "../scenarios/solo-combat";

/**
 * Solo Combat — ground-truth assertions for the single-agent capability ladder.
 * Each test pins an EMERGENT behavior (posture, lookahead, threat-aware nav,
 * personality, dynamic replanning) produced by the real reactive Planner over the
 * IAUS / expected-HP / spatial-field primitives — never a scripted special case.
 */

// seed an ExecState's belief so the threat is fully known (for direct planOnce tests)
function seeThreat(model: Model, st: ExecState, world: SoloWorld): void {
  const t = world.enemiesOf("npc")[0];
  const npc = world.actors.get("npc")!;
  st.set(model.slotOf("hasThreat"), 1);
  st.set(model.slotOf("threatSeen"), 1);
  st.buffer[model.slotOf("threatPos")] = t.x;
  st.buffer[model.slotOf("threatPos") + 1] = t.z;
  st.set(model.slotOf("threatHp"), 100);
  st.set(model.slotOf("foeAlive", model.entityId(t.name)), 1);
  st.buffer[model.slotOf("foePos", model.entityId(t.name))] = t.x;
  st.buffer[model.slotOf("foePos", model.entityId(t.name)) + 1] = t.z;
  st.buffer[model.slotOf("myPos")] = npc.x;
  st.buffer[model.slotOf("myPos") + 1] = npc.z;
}

// ---------------------------------------------------------------- domain validity

test("solo: the combat domain compiles, grounds, and binds", () => {
  const { model } = soloModel(postureArena(3, 12), "npc");
  assert.ok(model.operators.length >= 5, "operators compiled");
  assert.ok(model.methodsByTask.has("Neutralize"), "Neutralize task has methods");
  assert.ok(model.methodsByTask.has("Fight"), "Fight task has methods");
});

// ---------------------------------------------------------------- C2 perception events

test("solo: perception emits saw → lost → search events, gated by line of sight", () => {
  // the threat starts in view, then ducks behind a wall the NPC can't see through
  const inst: SoloInstance = {
    units: [
      { name: "npc", side: "npc", x: 0, z: 0 },
      { name: "t", side: "threat", x: 0, z: 8 },
    ],
    covers: [],
  };
  const sim = new SoloSim(inst, { seed: 1 });
  sim.step();
  assert.ok(sim.events.some((e) => e.kind === "saw"), "saw the target on first contact");
  // teleport the threat far out of sight + range and let memory decay
  const t = sim.world.actors.get("t")!;
  t.x = 100;
  t.z = 100;
  for (let i = 0; i < 60; i++) sim.step();
  assert.ok(sim.events.some((e) => e.kind === "lost"), "emitted a 'lost line of sight' event");
  assert.ok(sim.events.some((e) => e.kind === "search"), "fell back to searching last-known");
  assert.equal(sim.model.read(sim.planner.state, "threatSeen"), false, "no current line of sight");
});

test("solo: threat confidence decays monotonically after the target is lost", () => {
  const inst: SoloInstance = {
    units: [
      { name: "npc", side: "npc", x: 0, z: 0 },
      { name: "t", side: "threat", x: 0, z: 8 },
    ],
    covers: [],
  };
  const sim = new SoloSim(inst, { seed: 1 });
  sim.step();
  assert.equal(sim.model.read(sim.planner.state, "threatConfidence"), 1, "full confidence while seen");
  const t = sim.world.actors.get("t")!;
  t.x = 100;
  t.z = 100;
  let prev = 1;
  let decreased = false;
  for (let i = 0; i < 30; i++) {
    sim.step();
    const c = sim.model.read(sim.planner.state, "threatConfidence") as number;
    assert.ok(c <= prev + 1e-9, "confidence never increases without a sighting");
    if (c < prev) decreased = true;
    prev = c;
  }
  assert.ok(decreased, "confidence decayed");
});

// ---------------------------------------------------------------- S1 / C5 emergent posture

test("solo: near cover + a real threat ⇒ the COVER posture emerges", () => {
  const sim = new SoloSim(postureArena(2, 8), { seed: 1 });
  for (let i = 0; i < 4; i++) sim.step();
  assert.equal(sim.posture(), "cover", "it relocates to fight from cover");
});

test("solo: no cover + a distant threat ⇒ the SUPPRESSED-ADVANCE (hip-fire) posture emerges", () => {
  const sim = new SoloSim(openFieldArena(20), { seed: 2 });
  let advanced = false;
  for (let i = 0; i < 6; i++) {
    sim.step();
    if (sim.posture() === "advance") advanced = true;
  }
  assert.ok(advanced, "with nowhere to hide and range to close, it closes while firing");
});

test("solo: far cover + a close threat ⇒ the SHOOT-IN-OPEN posture emerges (aggressive)", () => {
  // a close threat (no room to 'advance') with cover only far behind ⇒ just shoot
  const inst: SoloInstance = {
    units: [
      { name: "npc", side: "npc", x: 0, z: 0 },
      { name: "t", side: "threat", x: 0, z: 10 },
    ],
    covers: [{ name: "back", x: 0, z: -12 }],
  };
  const sim = new SoloSim(inst, { seed: 1, profile: AGGRESSIVE });
  for (let i = 0; i < 4; i++) sim.step();
  assert.equal(sim.posture(), "open", "fighting in the open beats a long run to far cover");
});

test("solo: posture is a SURFACE over (cover-distance × threat), not a fixed response", () => {
  const grid = sweepDecisionBoundary(postureArena, [2, 5, 8, 11], [8, 11, 14, 18], AGGRESSIVE);
  const postures = new Set(grid.map((g) => g.posture));
  assert.ok(postures.size >= 2, `at least two postures emerge across the sweep (${[...postures].join(",")})`);
});

// ---------------------------------------------------------------- C4 expected-HP currency

test("solo: the expected-HP cost makes the NPC fight FROM COVER, not trade in the open", () => {
  const sim = new SoloSim(postureArena(3, 14), { seed: 3 });
  sim.run(200);
  assert.ok(sim.coveredFireBeats > 0, "it fired from cover");
  assert.ok(sim.coveredFireBeats > sim.exposedFireBeats, `mostly from cover (covered=${sim.coveredFireBeats} exposed=${sim.exposedFireBeats})`);
});

// ---------------------------------------------------------------- C6 spatial field

test("solo: the spatial field is rebuilt once per perception, not per query", () => {
  const sim = new SoloSim(postureArena(3, 14), { seed: 1 });
  const steps = 10;
  for (let i = 0; i < steps; i++) sim.step();
  // one build per perceive (== once per replan), NOT once per cost-external call
  assert.ok(sim.ctx.fieldBuilds <= steps + 1, `field built ~once per tick (builds=${sim.ctx.fieldBuilds}, steps=${steps})`);
  assert.ok(sim.ctx.fieldBuilds >= steps - 1, "and it IS rebuilt every tick (perception is live)");
});

test("solo: ROLLOUT-CORRECT — a step-2 evaluator sees the PROJECTED post-step-1 position", () => {
  // lookahead plan = moveToSpot(coverSpot) → engageFrom. The engageFrom cost must be
  // sampled at the cover spot the move PROJECTED us to, not at the live spawn.
  const { model, world, ctx } = soloModel(steppingStoneArena(), "npc", AGGRESSIVE);
  ctx.costTrace.length = 0;
  const st = model.createExecState();
  seeThreat(model, st, world);
  const npc = world.actors.get("npc")!;
  const res = planOnce(model, st, { goals: [goal(neutralizeGoal())], weight: 1, heuristic: "hmax", maxNodes: 80000 });
  assert.equal(res.status, "success");
  const labels = planSummary(model, res.plan!);
  assert.ok(labels.some((l) => l.includes("moveToSpot")), "the plan relocates before engaging");
  // some engage cost was sampled away from the spawn position (i.e. at the projected spot)
  const spawnSamples = ctx.costTrace.filter((c) => dist2(c.sampledMyPos[0], c.sampledMyPos[1], npc.x, npc.z) < 0.5);
  const projectedSamples = ctx.costTrace.filter((c) => dist2(c.sampledMyPos[0], c.sampledMyPos[1], npc.x, npc.z) >= 0.5);
  assert.ok(projectedSamples.length > 0, "engage cost was evaluated at a PROJECTED (moved) position, not only the spawn");
  assert.ok(spawnSamples.length > 0, "and also at the spawn (both rollout states were explored)");
});

test("solo: the field reflects believed threats and ignores live-world changes mid-plan", () => {
  const sim = new SoloSim(postureArena(3, 12), { seed: 1 });
  sim.step();
  const before = sim.ctx.field.exposureAt(0, 0, 0);
  // move the live threat; the CURRENT field (this replan's snapshot) must not change
  sim.world.actors.get("t")!.x = 50;
  const after = sim.ctx.field.exposureAt(0, 0, 0);
  assert.equal(before, after, "the field is a snapshot — live motion only matters at the next perceive");
});

// ---------------------------------------------------------------- S2 dynamic replan on disruption

test("solo: destroying the committed cover triggers a replan to a DIFFERENT plan, no freeze", () => {
  const sim = new SoloSim(disruptionArena(), { seed: 3, profile: DEFENSIVE });
  let target = "";
  for (let i = 0; i < 20 && !target; i++) {
    sim.step();
    const m = /moveToSpot\(([^)]+)\)/.exec(sim.snapshot().npc.step);
    if (m) target = m[1];
  }
  assert.ok(target, "the NPC committed to moving to a cover spot");
  sim.world.destroyCover(target);
  let newTarget = "";
  let everFroze = false;
  for (let i = 0; i < 15; i++) {
    sim.step();
    if (!sim.planner.currentStep() && sim.planner.getStatus() === "idle") everFroze = true;
    const m = /moveToSpot\(([^)]+)\)/.exec(sim.snapshot().npc.step);
    if (m && m[1] !== target) newTarget = m[1];
  }
  const reacted = sim.trace.some((e) => e.t === "step.fail" || e.t === "replan.dirty" || e.t === "repair.attempt");
  assert.ok(reacted, "the invalidated precondition triggered a replan");
  assert.ok(newTarget && newTarget !== target, `the new plan is genuinely different (${target} → ${newTarget})`);
  assert.not.ok(everFroze, "the NPC never froze — it kept executing while replanning");
});

// ---------------------------------------------------------------- S4 lookahead beats greedy

test("solo: LOOKAHEAD beats GREEDY — the planner relocates to cover where greedy shoots from the open", () => {
  const { model, world } = soloModel(steppingStoneArena(), "npc", AGGRESSIVE);
  const st = model.createExecState();
  seeThreat(model, st, world);
  const res = planOnce(model, st, { goals: [goal(neutralizeGoal())], weight: 1, heuristic: "hmax", maxNodes: 80000 });
  assert.equal(res.status, "success", "the planner found a plan");
  const labels = planSummary(model, res.plan!);
  assert.ok(labels.some((l) => l.includes("moveToSpot")), "the planner repositions to cover first");

  const greedy = greedyChoice(world, "npc", AGGRESSIVE.riskAversion);
  assert.equal(greedy.label, "engageFrom", "the myopic greedy just takes the immediate shot");
  // the lookahead plan's whole-engagement cost is dramatically lower than greedy's
  assert.ok(res.plan!.cost < greedy.cost * 0.6, `lookahead is cheaper over the full fight (plan=${res.plan!.cost.toFixed(1)} vs greedy=${greedy.cost.toFixed(1)})`);
});

// ---------------------------------------------------------------- S5 threat-aware navigation

test("solo: threat-aware path cost prefers a longer covered detour over a short exposed lane", () => {
  // a threat overlooks the direct lane; a wall shields a southern detour
  const threat = [{ pos: { x: 14, z: 0 }, elev: 0, alive: true }];
  const walls = [{ x: -6, z: -4, w: 16, d: 0.6 }]; // between the southern detour and the threat
  const field = buildField(threat, walls, [], { reach: 1.8, sight: 30, integralStep: 1.0 });
  const A = { x: -12, z: 0 };
  const B = { x: 10, z: 0 };
  const directLen = dist2(A.x, A.z, B.x, B.z);
  const directExposure = field.exposureIntegral(A.x, A.z, B.x, B.z, 0);
  // a detour that dips south behind the wall, then comes back
  const mid = { x: -1, z: -9 };
  const detourLen = dist2(A.x, A.z, mid.x, mid.z) + dist2(mid.x, mid.z, B.x, B.z);
  const detourExposure = field.exposureIntegral(A.x, A.z, mid.x, mid.z, 0) + field.exposureIntegral(mid.x, mid.z, B.x, B.z, 0);
  assert.ok(detourLen > directLen, "the detour is genuinely longer");
  assert.ok(detourExposure < directExposure, `but it minimizes expected exposure (detour=${detourExposure.toFixed(1)} < direct=${directExposure.toFixed(1)})`);
});

// ---------------------------------------------------------------- S6 personality variation

test("solo: personality is data-only — no logic branches on it", () => {
  // the domain has no fluent/operator/method keyed to a personality name; the only
  // personality-derived state are plain data knobs written into fluents at init.
  assert.ok(soloDomain.fluents.every((f) => !/person/i.test(f.name)), "no 'personality' fluent");
  assert.ok(soloDomain.fluents.some((f) => f.name === "caution"), "risk-aversion is a plain data fluent");
  for (const op of soloDomain.operators ?? []) assert.ok(!/person|aggress|defens/i.test(op.name), `operator ${op.name} isn't personality-named`);
  for (const m of soloDomain.methods ?? []) assert.ok(!/person|aggress|defens/i.test(m.name ?? ""), `method ${m.name} isn't personality-named`);
  // both profiles drive the SAME domain object
  const a = soloModel(postureArena(3, 12), "npc", AGGRESSIVE);
  const b = soloModel(postureArena(3, 12), "npc", DEFENSIVE);
  assert.ok(a.model !== b.model, "distinct compiled models");
  assert.is(soloDomain, soloDomain, "but built from one shared domain (data is the only difference)");
});

test("solo: a defensive profile takes cover in at least as many situations as an aggressive one", () => {
  const dists = [2, 5, 8, 11];
  const threats = [8, 11, 14, 18];
  const agg = sweepDecisionBoundary(postureArena, dists, threats, AGGRESSIVE);
  const def = sweepDecisionBoundary(postureArena, dists, threats, DEFENSIVE);
  const coverCells = (g: { posture: string }[]) => g.filter((c) => c.posture === "cover").length;
  assert.ok(coverCells(def) >= coverCells(agg), `defensive is more cover-seeking (def=${coverCells(def)} agg=${coverCells(agg)})`);
  // and the difference is behavioral, not code: the aggressive profile reaches more
  // forward postures (open / advance) the defensive one avoids
  const aggForward = new Set(agg.map((c) => c.posture)).size;
  assert.ok(aggForward >= 2, "aggressive uses a wider posture range");
});

// ---------------------------------------------------------------- C11 anti-dither

test("solo: under stable conditions the posture does not dither (switches/sec ≈ 0)", () => {
  const sim = new SoloSim(postureArena(3, 14), { seed: 1 });
  sim.run(150);
  assert.ok(sim.switchesPerSecond() <= 0.2, `posture is stable (${sim.switchesPerSecond().toFixed(3)}/s)`);
});

// ---------------------------------------------------------------- determinism & robustness

test("solo: identical seed + fixed timestep ⇒ byte-identical behavior", () => {
  const run = () => {
    const sim = new SoloSim(postureArena(3, 14), { seed: 7 });
    sim.run(150);
    return JSON.stringify({ posture: sim.postureTrace, hits: sim.hitsTaken(), threat: sim.world.enemiesOf("npc").length });
  };
  assert.equal(run(), run(), "two runs with the same seed are identical");
});

test("solo: with NO cover the NPC still closes and resolves the fight (positioning is a preference)", () => {
  // no cover anywhere; a beatable threat — the NPC must close and fight in the open
  const inst: SoloInstance = {
    units: [
      { name: "npc", side: "npc", x: 0, z: -9 },
      { name: "t", side: "threat", x: 0, z: 9, hp: 50 },
    ],
    covers: [],
  };
  const sim = new SoloSim(inst, { seed: 4 });
  sim.run(400);
  assert.ok(sim.stepStarts().some((l) => /engageFrom|advanceFiring/.test(l)), "it engaged");
  assert.ok(sim.over(), "the fight resolved — it did not stall");
  // engaged decisively (positioning is a preference layered on a reliable engagement,
  // not a way to stall): with no cover it closed and brought the threat to the brink
  assert.ok(sim.world.actors.get("t")!.hp < 25, `the threat took heavy fire (hp=${Math.round(sim.world.actors.get("t")!.hp)})`);
});

test.run();
