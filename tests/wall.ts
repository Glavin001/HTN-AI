import { test } from "uvu";
import * as assert from "uvu/assert";
import { Planner, goal, planOnce, type Model, type Snap } from "../src/index";
import {
  wallGoal,
  wallGoals,
  wallInstance,
  wallModel,
  type WallInstance,
} from "../scenarios/wall";

/**
 * Construction World — a *structure-building* scenario (the goal is a shape made of
 * blocks, not a position), built from two composable HTN blocks (FetchBlock,
 * PlaceBlockAt) and solved by serialising the per-cell sub-goals. These tests pin:
 *
 *   1. The flat conjunctive goal (lay the whole wall in one GOAP search) is the
 *      hard case — it should NOT solve under a sane budget. That's why we serialise.
 *   2. The wall, composed of PlaceBlockAt goals and run with goalAgenda, builds
 *      every slot to full height, tidy (every scattered block consumed), courtyard
 *      left clear.
 *   3. source-gated grab means a placed block is never cannibalised.
 *   4. The same two methods build a *different* structure (a free-standing tower) —
 *      the methods are reusable building blocks, not a wall-specific macro.
 */

const runToEnd = (planner: Planner): void => {
  for (let i = 0; i < 20000 && planner.getStatus() !== "succeeded" && planner.getStatus() !== "failed"; i++) {
    planner.tick({ ms: 30 });
  }
};

const builtCount = (model: Model, snap: Snap, inst: WallInstance): number =>
  inst.targets.filter((c) => (model.read(snap, "height", c) as number) >= inst.wantHeight).length;

test("construction: the flat conjunctive goal blows up one-shot GOAP (motivates serialization)", () => {
  const inst = wallInstance();
  const model = wallModel(inst);
  const result = planOnce(model, model.createExecState(), { goals: [goal(wallGoal(inst))], weight: 3, heuristic: "hadd", maxNodes: 80_000 });
  assert.equal(result.status, "failure", "the whole wall in one search should exhaust the budget — that's why we serialize");
});

test("construction: the wall (composed PlaceBlockAt goals + goalAgenda) builds every slot, tidy", () => {
  const inst = wallInstance();
  const model = wallModel(inst);
  const planner = new Planner(model, { goals: wallGoals(inst.targets), goalAgenda: true, weight: 3, maxNodes: 200_000, now: () => 0, seed: 1 });
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

test("construction: goalAgenda reports succeeded only after the LAST sub-goal", () => {
  const inst = wallInstance();
  const model = wallModel(inst);
  const planner = new Planner(model, { goals: wallGoals(inst.targets), goalAgenda: true, weight: 3, maxNodes: 200_000, now: () => 0, seed: 1 });
  // it should march through the agenda, not finish after the first committed slot
  let maxCursor = 0;
  for (let i = 0; i < 20000 && planner.getStatus() !== "succeeded" && planner.getStatus() !== "failed"; i++) {
    planner.tick({ ms: 30 });
    maxCursor = Math.max(maxCursor, planner.activeGoalIndex());
  }
  assert.equal(planner.getStatus(), "succeeded");
  assert.equal(planner.goalCount(), inst.targets.length);
  assert.equal(maxCursor, inst.targets.length - 1, "the agenda cursor should advance to the final sub-goal");
});

test("construction: source-gated grab means a placed block is never cannibalised", () => {
  const inst = wallInstance();
  const model = wallModel(inst);
  const start = model.createExecState();
  // plan a single slot and check every grab targets a source cell
  const result = planOnce(model, start, { goals: wallGoals([inst.targets[0]]), weight: 3 });
  assert.equal(result.status, "success");
  for (const step of result.plan!.steps) {
    if (step.k === "op" && step.g.op.name === "grab") {
      const at = model.entityName(step.g.b[step.g.b.length - 1]);
      assert.ok(inst.sources.includes(at), `grab should only take from the scatter pile (took from ${at})`);
    }
  }
});

test("construction: the SAME building blocks build a different structure (a 2-tall tower)", () => {
  // a short corridor: blocks scattered on the ends, a single cell to stack 2 high
  // in the middle. No new methods — just a different PlaceBlockAt target + wantHeight.
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
  const planner = new Planner(model, { goals: wallGoals(towerInst.targets), goalAgenda: true, weight: 3, now: () => 0, seed: 1 });
  runToEnd(planner);
  assert.equal(planner.getStatus(), "succeeded", "the generic PlaceBlockAt method builds any structure, not just the wall");
  assert.equal(model.read(planner.state, "height", nm(2)), 2, "the tower must be two blocks tall");
});

test.run();
