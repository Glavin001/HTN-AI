import { test } from "uvu";
import * as assert from "uvu/assert";
import { F, Planner, goal, planOnce, simulatePlan, type Model, type Plan, type Snap, type TraceEvent } from "../src/index";
import {
  GOAL_HEIGHT,
  QUARRY_GOAL_HEIGHT,
  SCAVENGER_BIG_GOAL_HEIGHT,
  SCAVENGER_GOAL_HEIGHT,
  ledgeGoal,
  ledgeInstance,
  quarryGoal,
  quarryInstance,
  scavengerBigGoal,
  scavengerBigInstance,
  scavengerGoal,
  scavengerHugeGoal,
  scavengerHugeGoalCell,
  scavengerHugeInstance,
  scavengerInstance,
  scavengerModel,
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

// ---------------------------------------------------------------- quarry: the advanced grid world

test("quarry: optimal collect/place/build/climb to a height-4 pillar (search stays tiny)", () => {
  const model = staircaseModel(quarryInstance());
  const start = model.createExecState();
  const result = planOnce(model, start, { goals: [goal(quarryGoal())], weight: 1, heuristic: "hmax" });
  assert.equal(result.status, "success");
  const end = endOf(model, start, result.plan!);
  // reached the 3D position on top of the pillar
  assert.equal(model.read(end, "agentAt"), "pillar");
  assert.equal(model.read(end, "agentY"), QUARRY_GOAL_HEIGHT);
  // discovered the 3-step staircase (heights 1,2,3) — emergent, not prescribed
  assert.equal(model.read(end, "height", "step1"), 1);
  assert.equal(model.read(end, "height", "step2"), 2);
  assert.equal(model.read(end, "height", "step3"), 3);
  // collected from BOTH scattered depots (6 blocks needed, 3+3 available)
  assert.equal(model.read(end, "supply", "depotA"), 0);
  assert.equal(model.read(end, "supply", "depotB"), 0);
  // the buildable constraint + topology keep optimal search tractable
  assert.ok(result.stats.expansions < 50_000, `search should stay small, got ${result.stats.expansions} expansions`);
});

test("quarry: never enters the impassable wall pillar", () => {
  const model = staircaseModel(quarryInstance());
  const start = model.createExecState();
  const result = planOnce(model, start, { goals: [goal(quarryGoal())], weight: 1, heuristic: "hmax" });
  assert.equal(result.status, "success");
  // no goto step may target the wall (height 6 ≫ the +1 climb limit)
  const wallGid = model.entityId("wall");
  const enteredWall = (result.plan!.steps ?? []).some(
    (s) => s.k === "op" && s.g.op.name === "goto" && s.g.b[s.g.b.length - 1] === wallGid,
  );
  assert.not(enteredWall, "the agent must route around the wall, never into it");
});

test("quarry: solved through the reactive Planner", () => {
  const model = staircaseModel(quarryInstance());
  let t = 0;
  const planner = new Planner(model, { goals: [goal(quarryGoal())], now: () => t, seed: 5 });
  for (let i = 0; i < 4000 && planner.getStatus() !== "succeeded" && planner.getStatus() !== "failed"; i++) {
    t += 1;
    planner.tick({ ms: 20 });
  }
  assert.equal(planner.getStatus(), "succeeded");
  assert.equal(model.read(planner.state, "agentAt"), "pillar");
  assert.equal(model.read(planner.state, "agentY"), QUARRY_GOAL_HEIGHT);
});

// ---------------------------------------------------------------- scavenger: collect scattered blocks, top-first

test("scavenger: must build a step to harvest a 2-pillar's top block, then reach the goal", () => {
  const model = scavengerModel(scavengerInstance());
  const start = model.createExecState();
  const result = planOnce(model, start, { goals: [goal(scavengerGoal())], weight: 1, heuristic: "hmax" });
  assert.equal(result.status, "success");
  const end = endOf(model, start, result.plan!);
  // reached the 3D position atop the goal
  assert.equal(model.read(end, "agentAt"), "goal");
  assert.equal(model.read(end, "agentY"), SCAVENGER_GOAL_HEIGHT);
  // only 2 loose blocks exist but 3 are needed, so the 2-pillar MUST be harvested
  assert.ok((model.read(end, "height", "tower") as number) < 2, "the 2-pillar's top block must be taken");

  // the mechanic: a block had to be PLACED (a step) before the tower's top could be grabbed
  const towerGid = model.entityId("tower");
  const ops = (result.plan!.steps ?? []).flatMap((s) => (s.k === "op" ? [{ name: s.g.op.name, at: s.g.b[s.g.b.length - 1] }] : []));
  const firstPlace = ops.findIndex((o) => o.name === "place");
  const firstGrabTower = ops.findIndex((o) => o.name === "grab" && o.at === towerGid);
  assert.ok(firstGrabTower >= 0, "must grab from the tower");
  assert.ok(firstPlace >= 0 && firstPlace < firstGrabTower, "must build a step before grabbing the tower's top block");
});

test("scavenger: a 2-pillar's top block is unreachable from the ground", () => {
  // standing on flat ground (level 0), grabbing the top of a height-2 column is
  // blocked by the reach rule (0 ≥ 2−1 is false) — proven by making it the only
  // option: no loose blocks, goal is simply to be holding a block.
  const model = scavengerModel({
    cells: [
      { name: "g", x: 0, z: 0 },
      { name: "tower", x: 1, z: 0, height: 2 },
    ],
    edges: [["g", "tower"]],
    start: "g",
  });
  const result = planOnce(model, model.createExecState(), {
    goals: [goal(F.lit("holding"))],
    weight: 1,
    heuristic: "hmax",
    maxNodes: 50_000,
  });
  // no loose block to build a step with ⇒ the top block can never be reached
  assert.equal(result.status, "failure", "can't grab a 2-high top block from the ground with nothing to step on");
});

test("scavenger XL: taller height-3 goal, more blocks, harvests the pillar (greedy weight)", () => {
  // bigger 4×3 grid, height-3 goal, 5 loose blocks + a 2-pillar. Uses the same
  // fast settings the web demo runs (hadd, weight 5) — assert it solves, reaches
  // the goal, and harvests the pillar (loose blocks alone are insufficient).
  const model = scavengerModel(scavengerBigInstance());
  const start = model.createExecState();
  const result = planOnce(model, start, { goals: [goal(scavengerBigGoal())], weight: 5, heuristic: "hadd", maxNodes: 500_000 });
  assert.equal(result.status, "success");
  const end = endOf(model, start, result.plan!);
  assert.equal(model.read(end, "agentAt"), "goal");
  assert.equal(model.read(end, "agentY"), SCAVENGER_BIG_GOAL_HEIGHT);
  const towerGid = model.entityId("tower");
  const harvested = (result.plan!.steps ?? []).some(
    (s) => s.k === "op" && s.g.op.name === "grab" && s.g.b[s.g.b.length - 1] === towerGid,
  );
  assert.ok(harvested, "5 loose blocks can't supply a height-3 goal — the pillar must be harvested");
});

test("scavenger: solved through the reactive Planner", () => {
  const model = scavengerModel(scavengerInstance());
  let t = 0;
  const planner = new Planner(model, { goals: [goal(scavengerGoal())], now: () => t, seed: 9 });
  for (let i = 0; i < 2000 && planner.getStatus() !== "succeeded" && planner.getStatus() !== "failed"; i++) {
    t += 1;
    planner.tick({ ms: 20 });
  }
  assert.equal(planner.getStatus(), "succeeded");
  assert.equal(model.read(planner.state, "agentAt"), "goal");
  assert.equal(model.read(planner.state, "agentY"), SCAVENGER_GOAL_HEIGHT);
});

// HUGE stress benchmark — ~9s of compute, so it's opt-in (HTN_BENCH=1) to keep
// the default suite/CI fast. Bounded by maxNodes so it can never run away.
if (process.env.HTN_BENCH === "1") {
  test("scavenger HUGE (benchmark): solves a 24-cell height-3 grid (~10× XL compute)", () => {
    const model = scavengerModel(scavengerHugeInstance());
    const start = model.createExecState();
    const t0 = Date.now();
    const result = planOnce(model, start, {
      goals: [goal(scavengerHugeGoal())],
      weight: 6,
      heuristic: "hadd",
      maxNodes: 200_000, // safety cap; the greedy search solves in ≈1.7k expansions
    });
    // eslint-disable-next-line no-console
    console.log(`[HUGE] ${result.status} in ${Date.now() - t0}ms, ${result.stats.expansions} expansions`);
    assert.equal(result.status, "success");
    const end = endOf(model, start, result.plan!);
    assert.equal(model.read(end, "agentAt"), scavengerHugeGoalCell);
    assert.equal(model.read(end, "agentY"), 3);
  });
}

test.run();
