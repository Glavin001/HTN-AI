import { test } from "uvu";
import * as assert from "uvu/assert";
import { Planner, goal, planOnce, simulatePlan, task, type Model, type Plan, type Snap } from "../src/index";
import {
  WALL_SLOT_HEIGHT,
  wallGoal,
  wallInstance,
  wallModel,
  wallSources,
} from "../scenarios/wall";

/**
 * Wall World — the *structure-building* scenario (a goal that is a shape made of
 * blocks, not a position to stand at). These tests pin two things:
 *
 *   1. The flat conjunctive goal (lay all 8 slots in one GOAP search) is the hard
 *      case the scenario is designed around — it should NOT be solvable under a
 *      sane node budget. This is the motivation for the HTN decomposition.
 *   2. The HTN `BuildWall` compound DOES solve it — quickly — and the finished
 *      wall has every slot laid with no scattered block left behind (the
 *      cumulative sub-goals stop a later placement from robbing an earlier slot).
 */

const endOf = (model: Model, start: Snap, plan: Plan): Snap => simulatePlan(model, start, plan).end;

const wallLaid = (model: Model, snap: Snap, targets: string[]): boolean =>
  targets.every((c) => (model.read(snap, "height", c) as number) >= WALL_SLOT_HEIGHT);

test("wall: the flat 8-slot conjunction blows up one-shot GOAP (motivates HTN)", () => {
  const inst = wallInstance();
  const model = wallModel(inst);
  const start = model.createExecState();
  // a generous-but-bounded budget; the symmetric block↔slot assignment explodes
  const result = planOnce(model, start, { goals: [goal(wallGoal(inst.targets))], weight: 3, heuristic: "hadd", maxNodes: 60_000 });
  assert.equal(result.status, "failure", "flat conjunction should exhaust the budget — that's why we decompose");
});

test("wall: HTN BuildWall lays every slot and leaves the yard tidy", () => {
  const inst = wallInstance();
  const model = wallModel(inst);
  const start = model.createExecState();
  const result = planOnce(model, start, { goals: [task("BuildWall")], weight: 2 });
  assert.equal(result.status, "success");

  const end = endOf(model, start, result.plan!);
  assert.ok(wallLaid(model, end, inst.targets), "every wall slot must hold a block");

  // exactly as many blocks as slots, so a finished wall consumes them all
  const leftover = wallSources(inst).filter((c) => (model.read(end, "height", c) as number) > 0);
  assert.equal(leftover.length, 0, `no scattered block should be left behind (found ${leftover.join(",")})`);

  // the core is enclosed by the wall, never stacked on
  assert.equal(model.read(end, "height", inst.core), 0, "the courtyard core is surrounded, not filled");
});

test("wall: solved through the reactive Planner, every slot exactly one block high", () => {
  const inst = wallInstance();
  const model = wallModel(inst);
  let t = 0;
  const planner = new Planner(model, { goals: [task("BuildWall")], now: () => t, seed: 1 });
  for (let i = 0; i < 3000 && planner.getStatus() !== "succeeded" && planner.getStatus() !== "failed"; i++) {
    t += 1;
    planner.tick({ ms: 30 });
  }
  assert.equal(planner.getStatus(), "succeeded");
  assert.ok(wallLaid(model, planner.state, inst.targets), "reactive run must finish the wall");
  // the wall is walkable height-1, so the planner never stacks a slot above 1
  for (const c of inst.targets) {
    assert.equal(model.read(planner.state, "height", c), WALL_SLOT_HEIGHT, `slot ${c} should be exactly one block high`);
  }
});

test.run();
