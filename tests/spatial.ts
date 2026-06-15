import { test } from "uvu";
import * as assert from "uvu/assert";
import { F, Planner, goal, planOnce, simulatePlan, type Model, type Plan, type Snap, type TraceEvent } from "../src/index";
import {
  GOAL_HEIGHT,
  ledgeGoal,
  ledgeInstance,
  staircaseGoal,
  staircaseInstance,
  staircaseModel,
} from "../scenarios/staircase";

/**
 * Tier B "Staircase World" battle-tests (PLAN-web-demo-and-block-stacking.md §2):
 * the first scenarios where htn-ai's SPATIAL features drive the plan — int
 * column heights gate both climbing and placing (so the build order is
 * discovered, not scripted), and N.dist over vec2 positions is the movement
 * cost. Closes the "vec/dist never drive a plan" gap.
 */

const opNames = (plan: Plan | null | undefined): string[] =>
  (plan?.steps ?? []).flatMap((s) => (s.k === "op" ? [s.g.op.name] : []));

const endOf = (model: Model, start: Snap, plan: Plan): Snap => simulatePlan(model, start, plan).end;

// ---------------------------------------------------------------- climb the ledge (GOAP)

test("ledge: must build a support to climb a 2-high wall (geometry gates the plan)", () => {
  const model = staircaseModel(ledgeInstance(1));
  const start = model.createExecState();
  const result = planOnce(model, start, { goals: [goal(ledgeGoal())], weight: 1, heuristic: "hmax" });
  assert.equal(result.status, "success");
  const ops = opNames(result.plan);
  // pick a block, place it on `mid` (height 0→1), then climb ground→mid→ledge
  assert.ok(ops.includes("pick"), `expected a pick, got ${ops.join(", ")}`);
  assert.ok(ops.includes("place"), `expected a place, got ${ops.join(", ")}`);
  assert.equal(model.read(endOf(model, start, result.plan!), "agentAt"), "ledge");
  // a `place` must precede the final climb onto the ledge
  assert.ok(ops.lastIndexOf("place") < ops.lastIndexOf("goto"), "must build before the final climb");
});

test("ledge: with no supply, the 2-high wall is provably unreachable", () => {
  const model = staircaseModel(ledgeInstance(0)); // empty depot
  const result = planOnce(model, model.createExecState(), {
    goals: [goal(ledgeGoal())],
    weight: 1,
    heuristic: "hmax",
    maxNodes: 50_000,
  });
  assert.equal(result.status, "failure", "no blocks to build with ⇒ can't climb 2 levels");
});

// ---------------------------------------------------------------- build the staircase (GOAP)

test("staircase: builds the steps from supply and climbs onto the goal", () => {
  const model = staircaseModel(staircaseInstance());
  const start = model.createExecState();
  const result = planOnce(model, start, { goals: [goal(staircaseGoal())], weight: 1, heuristic: "hmax" });
  assert.equal(result.status, "success");
  const ops = opNames(result.plan);
  assert.ok(ops.length >= 6, `a real build+climb should take several actions, got ${ops.length}`);
  const end = endOf(model, start, result.plan!);
  // goal is position-only (agentAt=goal ∧ agentY=2); the planner DISCOVERED it
  // must raise the goal column to 2 and build s1 as a support — assert those as
  // emergent consequences, not as things the goal prescribed.
  assert.equal(model.read(end, "agentAt"), "goal");
  assert.equal(model.read(end, "agentY"), GOAL_HEIGHT);
  assert.ok((model.read(end, "height", "goal") as number) >= GOAL_HEIGHT, "discovered: built the goal column up");
  assert.ok((model.read(end, "height", "s1") as number) >= 1, "discovered: built s1 as a support to stand on");
});

// ---------------------------------------------------------------- through the reactive Planner

test("staircase: solved through the reactive Planner (tick loop)", () => {
  const model = staircaseModel(staircaseInstance());
  const events: TraceEvent[] = [];
  let t = 0;
  const planner = new Planner(model, {
    goals: [goal(staircaseGoal())],
    now: () => t,
    seed: 3,
    trace: (e) => events.push(e),
  });
  for (let i = 0; i < 500 && planner.getStatus() !== "succeeded" && planner.getStatus() !== "failed"; i++) {
    t += 1;
    planner.tick({ ms: 5 });
  }
  assert.equal(planner.getStatus(), "succeeded");
  assert.equal(model.read(planner.state, "agentAt"), "goal");
  assert.ok((model.read(planner.state, "height", "goal") as number) >= GOAL_HEIGHT);
  assert.ok(events.some((e) => e.t === "plan.new"), "should have produced a plan");
});

// ---------------------------------------------------------------- geometry drives a choice

test("nearer supply is preferred: N.dist cost steers the plan", () => {
  // two depots that can each supply the single block needed to climb the ledge;
  // `near` is one step away, `far` is several — the cheaper plan mines `near`.
  const model = staircaseModel({
    cells: [
      { name: "ground", x: 0, z: 0 },
      { name: "near", x: 1, z: 0, supply: 1 },
      { name: "mid", x: 0, z: 1 },
      { name: "ledge", x: 0, z: 2, height: 2 },
      { name: "far", x: 0, z: 5, supply: 1 },
    ],
    edges: [
      ["ground", "near"],
      ["ground", "mid"],
      ["mid", "ledge"],
      ["mid", "far"],
    ],
    start: "ground",
  });
  const start = model.createExecState();
  const result = planOnce(model, start, { goals: [goal(F.lit("agentAt", [], "ledge"))], weight: 1, heuristic: "hmax" });
  assert.equal(result.status, "success");
  const end = endOf(model, start, result.plan!);
  // the cheaper plan mines `near`, so `far` should be untouched (supply intact)
  assert.equal(model.read(end, "supply", "far"), 1, "should not have walked to the far depot");
  assert.equal(model.read(end, "supply", "near"), 0, "should have mined the near depot");
});

test.run();
