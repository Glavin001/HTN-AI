import { test } from "uvu";
import * as assert from "uvu/assert";
import { Planner, goal, planOnce, simulatePlan, type Model, type Plan, type Snap } from "../src/index";
import {
  BLOCK_HEIGHT,
  wallGoal,
  wallGoals,
  wallInstance,
  wallModel,
  type WallInstance,
} from "../scenarios/wall";

/**
 * Construction World — a *structure-building* scenario (the goal is a shape made
 * of blocks, not a position to stand at), built from two composable HTN blocks:
 * FetchBlock and PlaceBlockAt(cell). These tests pin:
 *
 *   1. The flat conjunctive goal (lay all 8 slots in one GOAP search) is the hard
 *      case — it should NOT solve under a sane budget. That's why we decompose.
 *   2. The wall expressed as a COMPOSITION of PlaceBlockAt goals solves quickly,
 *      with every slot laid and no scattered block cannibalised (grab is
 *      source-gated, so each placement is independent — no cumulative goals).
 *   3. The same two methods build a *different* structure (a 3-cell line) — the
 *      methods are reusable building blocks, not a wall-specific macro.
 */

const endOf = (model: Model, start: Snap, plan: Plan): Snap => simulatePlan(model, start, plan).end;

const allFilled = (model: Model, snap: Snap, targets: string[]): boolean =>
  targets.every((c) => (model.read(snap, "height", c) as number) >= BLOCK_HEIGHT);

test("construction: the flat 8-slot conjunction blows up one-shot GOAP (motivates decomposition)", () => {
  const inst = wallInstance();
  const model = wallModel(inst);
  const start = model.createExecState();
  const result = planOnce(model, start, { goals: [goal(wallGoal(inst.targets))], weight: 3, heuristic: "hadd", maxNodes: 60_000 });
  assert.equal(result.status, "failure", "flat conjunction should exhaust the budget — that's why we compose PlaceBlockAt");
});

test("construction: a wall composed from PlaceBlockAt lays every slot and leaves the yard tidy", () => {
  const inst = wallInstance();
  const model = wallModel(inst);
  const start = model.createExecState();
  const result = planOnce(model, start, { goals: wallGoals(inst.targets), weight: 2 });
  assert.equal(result.status, "success");

  const end = endOf(model, start, result.plan!);
  assert.ok(allFilled(model, end, inst.targets), "every wall slot must hold a block");

  // exactly as many blocks as slots, so a finished wall consumes the whole pile
  const leftover = inst.sources.filter((c) => (model.read(end, "height", c) as number) > 0);
  assert.equal(leftover.length, 0, `no scattered block should be left behind (found ${leftover.join(",")})`);

  // the core is enclosed by the wall, never stacked on
  assert.equal(model.read(end, "height", inst.core), 0, "the courtyard core is surrounded, not filled");
});

test("construction: source-gated grab means a placed block is never cannibalised", () => {
  const inst = wallInstance();
  const model = wallModel(inst);
  const start = model.createExecState();
  const result = planOnce(model, start, { goals: wallGoals(inst.targets), weight: 2 });
  assert.equal(result.status, "success");
  // every grab must target a source cell — the structure is never disassembled
  for (const step of result.plan!.steps) {
    if (step.k === "op" && step.g.op.name === "grab") {
      const at = model.entityName(step.g.b[step.g.b.length - 1]);
      assert.ok(inst.sources.includes(at), `grab should only ever take from the scatter pile (took from ${at})`);
    }
  }
});

test("construction: solved through the reactive Planner, every slot exactly one block high", () => {
  const inst = wallInstance();
  const model = wallModel(inst);
  let t = 0;
  const planner = new Planner(model, { goals: wallGoals(inst.targets), now: () => t, seed: 1 });
  for (let i = 0; i < 3000 && planner.getStatus() !== "succeeded" && planner.getStatus() !== "failed"; i++) {
    t += 1;
    planner.tick({ ms: 30 });
  }
  assert.equal(planner.getStatus(), "succeeded");
  assert.ok(allFilled(model, planner.state, inst.targets), "reactive run must finish the wall");
  for (const c of inst.targets) {
    assert.equal(model.read(planner.state, "height", c), BLOCK_HEIGHT, `slot ${c} should be exactly one block high`);
  }
});

test("construction: the SAME building blocks build a different structure (a 3-cell line)", () => {
  // a 1×4 strip: blocks scattered on the two ends, a 3-cell line to lay in the middle.
  // No new methods — just a different list of PlaceBlockAt targets.
  const nm = (x: number) => `c${x}`;
  const lineInst: WallInstance = {
    cells: [
      { name: nm(0), x: 0, z: 0, height: 1 }, // source block
      { name: nm(1), x: 1, z: 0 },            // line
      { name: nm(2), x: 2, z: 0 },            // line
      { name: nm(3), x: 3, z: 0 },            // line
      { name: nm(4), x: 4, z: 0, height: 1 }, // source block
      { name: nm(5), x: 5, z: 0, height: 1 }, // source block
    ],
    edges: [[nm(0), nm(1)], [nm(1), nm(2)], [nm(2), nm(3)], [nm(3), nm(4)], [nm(4), nm(5)]],
    start: nm(1),
    targets: [nm(1), nm(2), nm(3)],
    sources: [nm(0), nm(4), nm(5)],
    core: nm(2),
  };
  const model = wallModel(lineInst);
  const start = model.createExecState();
  const result = planOnce(model, start, { goals: wallGoals(lineInst.targets), weight: 2 });
  assert.equal(result.status, "success", "the generic PlaceBlockAt method builds any structure, not just the wall");
  const end = endOf(model, start, result.plan!);
  assert.ok(allFilled(model, end, lineInst.targets), "every cell of the line must hold a block");
});

test.run();
