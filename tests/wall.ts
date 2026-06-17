import { test } from "uvu";
import * as assert from "uvu/assert";
import { Planner, goal, planOnce, type Model, type Snap } from "../src/index";
import { wallGoal, wallInstance, wallInstanceHard, wallModel, type WallInstance } from "../scenarios/wall";

/**
 * Construction World — a *structure-building* scenario whose goal is purely
 * DECLARATIVE: a final-state condition ("every wall cell ends up wantHeight tall").
 * The domain has only primitive operators (goto / grab / place) — no BuildWall
 * task, no PlaceBlockAt method — so the planner must DISCOVER pickup-and-place by
 * search. These tests pin:
 *
 *   1. The declarative goal handed to one joint search blows up — that's the
 *      motivation for serializing.
 *   2. With `goalAgenda`, the single conjunctive goal is auto-split into per-cell
 *      subgoals and solved tidily — every slot at height, every scattered block
 *      consumed, courtyard left clear — having DISCOVERED goto/grab/place.
 *   3. source-gated grab means a placed block is never cannibalised.
 *   4. The agenda advances through every subgoal before reporting success.
 *   5. The same domain builds a *different* structure (a 2-tall tower) from the
 *      same declarative goal form — nothing is wall-specific.
 */

const runToEnd = (planner: Planner): void => {
  for (let i = 0; i < 20000 && planner.getStatus() !== "succeeded" && planner.getStatus() !== "failed"; i++) {
    planner.tick({ ms: 30 });
  }
};

const builtCount = (model: Model, snap: Snap, inst: WallInstance): number =>
  inst.targets.filter((c) => (model.read(snap, "height", c) as number) >= inst.wantHeight).length;

test("construction: the declarative goal handed to one joint search blows up (motivates serialization)", () => {
  const inst = wallInstance();
  const model = wallModel(inst);
  // no goalAgenda → the whole conjunction is one search
  const result = planOnce(model, model.createExecState(), { goals: [goal(wallGoal(inst))], weight: 3, heuristic: "hadd", maxNodes: 80_000 });
  assert.equal(result.status, "failure", "the whole wall in one search should exhaust the budget — that's why we serialize");
});

test("construction: goalAgenda splits the declarative goal, discovers grab/place, builds tidily", () => {
  const inst = wallInstance();
  const model = wallModel(inst);
  // ONE declarative goal — the planner splits the conjunction itself
  const planner = new Planner(model, { goals: [goal(wallGoal(inst))], goalAgenda: true, weight: 3, maxNodes: 200_000, now: () => 0, seed: 1 });
  assert.equal(planner.goalCount(), inst.targets.length, "the conjunction is auto-split into one subgoal per cell");

  runToEnd(planner);
  assert.equal(planner.getStatus(), "succeeded");

  // every slot at full height
  assert.equal(builtCount(model, planner.state, inst), inst.targets.length, "every wall slot must reach wantHeight");
  for (const c of inst.targets) {
    assert.equal(model.read(planner.state, "height", c), inst.wantHeight, `slot ${c} should be exactly wantHeight tall`);
  }
  // every scattered block consumed → tidy yard
  const leftover = inst.sources.filter((c) => (model.read(planner.state, "height", c) as number) > 0);
  assert.equal(leftover.length, 0, `no scattered block should be left behind (found ${leftover.join(",")})`);
  // the courtyard core is enclosed, never built on
  assert.equal(model.read(planner.state, "height", inst.core), 0, "the courtyard core stays clear");
});

test("construction: the placement actions are DISCOVERED, not prescribed", () => {
  const inst = wallInstance();
  const model = wallModel(inst);
  // a single cell's subgoal is solved by raw operator search over the declarative state
  const result = planOnce(model, model.createExecState(), { goals: [goal(wallGoal({ ...inst, targets: [inst.targets[0]] }))], weight: 3 });
  assert.equal(result.status, "success");
  const ops = result.plan!.steps.filter((s) => s.k === "op").map((s) => (s.k === "op" ? s.g.op.name : ""));
  // the planner found it must grab and place — those were never named in the goal
  assert.ok(ops.includes("grab"), "planner should discover it must grab a block");
  assert.ok(ops.includes("place"), "planner should discover it must place a block");
  // and every grab is from the scatter pile (so a laid block is never cannibalised)
  for (const step of result.plan!.steps) {
    if (step.k === "op" && step.g.op.name === "grab") {
      const at = model.entityName(step.g.b[step.g.b.length - 1]);
      assert.ok(inst.sources.includes(at), `grab should only take from the scatter pile (took from ${at})`);
    }
  }
});

test("construction: the agenda advances through every subgoal before succeeding", () => {
  const inst = wallInstance();
  const model = wallModel(inst);
  const planner = new Planner(model, { goals: [goal(wallGoal(inst))], goalAgenda: true, weight: 3, maxNodes: 200_000, now: () => 0, seed: 1 });
  let maxCursor = 0;
  for (let i = 0; i < 20000 && planner.getStatus() !== "succeeded" && planner.getStatus() !== "failed"; i++) {
    planner.tick({ ms: 30 });
    maxCursor = Math.max(maxCursor, planner.activeGoalIndex());
  }
  assert.equal(planner.getStatus(), "succeeded");
  assert.equal(maxCursor, inst.targets.length - 1, "the agenda cursor should reach the final subgoal");
});

test("construction: the SAME declarative domain builds a different structure (a 2-tall tower)", () => {
  // a short corridor: blocks scattered on the ends, one middle cell to stack 2 high.
  // Only the goal/wantHeight differs — no new domain knowledge.
  const nm = (x: number) => `c${x}`;
  const towerInst: WallInstance = {
    cells: [
      { name: nm(0), x: 0, z: 0, height: 1 }, // source
      { name: nm(1), x: 1, z: 0, height: 1 }, // source
      { name: nm(2), x: 2, z: 0 },            // the tower cell
      { name: nm(3), x: 3, z: 0, height: 1 }, // source
    ],
    edges: [[nm(0), nm(1)], [nm(1), nm(2)], [nm(2), nm(3)]],
    start: nm(1),
    targets: [nm(2)],
    wantHeight: 2,
    sources: [nm(0), nm(1), nm(3)],
    core: nm(2),
  };
  const model = wallModel(towerInst);
  const planner = new Planner(model, { goals: [goal(wallGoal(towerInst))], goalAgenda: true, weight: 3, now: () => 0, seed: 1 });
  runToEnd(planner);
  assert.equal(planner.getStatus(), "succeeded", "the same operators + declarative goal build any structure");
  assert.equal(model.read(planner.state, "height", nm(2)), 2, "the tower must be two blocks tall");
});

test("construction (HARD): interdependent wall needs landmark layering, not plain serialization", () => {
  // realistic physics (strictReach): a ring cell can only be topped from a neighbour
  // that's already been raised, so the per-cell subgoals INTERFERE.
  const inst = wallInstanceHard();

  // plain goal-agenda (split per cell, protected) cannot finish it — a lone cell
  // can't be built to full height before its neighbours, and it strands cells.
  const plain = new Planner(wallModel(inst), { goals: [goal(wallGoal(inst))], goalAgenda: true, weight: 3, maxNodes: 200_000, now: () => 0, seed: 1 });
  runToEnd(plain);
  const plainBuilt = inst.targets.filter((c) => (plain.model.read(plain.state, "height", c) as number) >= inst.wantHeight).length;
  assert.ok(plainBuilt < inst.targets.length, "without landmarks the interdependent wall can't be completed");

  // landmarks: derive the threshold landmarks and lay the whole base course before
  // any top course — every upper course then has a neighbour to stand on.
  const withLM = new Planner(wallModel(inst), { goals: [goal(wallGoal(inst))], goalAgenda: true, landmarks: true, weight: 3, maxNodes: 200_000, now: () => 0, seed: 1 });
  runToEnd(withLM);
  assert.equal(withLM.getStatus(), "succeeded");
  for (const c of inst.targets) {
    assert.equal(withLM.model.read(withLM.state, "height", c), inst.wantHeight, `slot ${c} must reach full height with landmark layering`);
  }
});

test.run();
