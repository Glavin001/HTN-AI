import { test } from "uvu";
import * as assert from "uvu/assert";
import { F, Planner, Scheduler, createModel, goal, planOnce, type Plan, type TraceEvent } from "../src/index";
import { blocksDomain, blocksModel, sussmanSetup, towerSetup } from "../scenarios/blocks";

/**
 * Tier A "Blocks World+" battle-tests (PLAN-web-demo-and-block-stacking.md §2):
 * the 4-operator STRIPS blocks world, scaled up and — crucially — driven
 * through the reactive Planner with executors so plan repair and multi-effector
 * coordination get exercised. Complements the symbolic 3-op test in puzzles.ts.
 */

const opNames = (plan: Plan | null | undefined): string[] =>
  (plan?.steps ?? []).flatMap((s) => (s.k === "op" ? [s.g.op.name] : []));

const runToTerminal = (planner: Planner, step: () => void, budgetMs = 5, maxTicks = 300): void => {
  for (let i = 0; i < maxTicks; i++) {
    const st = planner.getStatus();
    if (st === "succeeded" || st === "failed") return;
    step();
    planner.tick({ ms: budgetMs });
  }
};

// ---------------------------------------------------------------- Sussman anomaly

test("sussman anomaly: optimal 6-action plan (forces subgoal interleaving)", () => {
  const model = blocksModel(sussmanSetup());
  const result = planOnce(model, model.createExecState(), {
    goals: [goal(F.and(F.lit("on", ["a"], "b"), F.lit("on", ["b"], "c")))],
    weight: 1,
    heuristic: "hmax", // admissible → guaranteed-optimal length
  });
  assert.equal(result.status, "success");
  const ops = opNames(result.plan);
  assert.equal(ops.length, 6, `ground truth: 6 actions, got ${ops.length}: ${ops.join(", ")}`);
  // the anomaly: C must come off A (unstack) before the A/B/C tower can form
  assert.is(ops[0], "unstack", `must clear C first, got first op '${ops[0]}'`);
});

// ---------------------------------------------------------------- scaling: reverse a tower

test("reverse a 4-block tower: optimal length, search stays bounded", () => {
  // start a-b-c-d (a on top, d on table); goal d-c-b-a (d on top, a on table)
  const names = ["a", "b", "c", "d"];
  const model = blocksModel(towerSetup(names));
  const result = planOnce(model, model.createExecState(), {
    goals: [goal(F.and(F.lit("on", ["d"], "c"), F.lit("on", ["c"], "b"), F.lit("on", ["b"], "a")))],
    weight: 1,
    heuristic: "hmax",
  });
  assert.equal(result.status, "success");
  const ops = opNames(result.plan);
  // Optimal is 8, not 12: only `a` needs the table (unstack+putdown); every
  // other block is unstacked and restacked directly onto the growing tower,
  // skipping redundant put-downs — a non-obvious optimum hmax+A* finds.
  assert.equal(ops.length, 8, `expected 8-action reversal, got ${ops.length}: ${ops.join(", ")}`);
});

// ---------------------------------------------------------------- reactive execution + plan repair

test("reactive build with a slipping block: planner repairs and still finishes", () => {
  // `stack` runs a real executor that drops the block the first time it fires.
  let slipsLeft = 1;
  const slipStack = (): "success" | "failure" => {
    if (slipsLeft > 0) {
      slipsLeft--;
      return "failure"; // the block slips out of the gripper once
    }
    return "success";
  };
  const domain = {
    ...blocksDomain,
    operators: (blocksDomain.operators ?? []).map((op) =>
      op.name === "stack" ? { ...op, executor: "stack" } : op,
    ),
  };
  const model = createModel(
    domain,
    { entities: { a: "block", b: "block", c: "block", arm: "hand" } },
    { executors: { stack: slipStack } },
  );

  const events: TraceEvent[] = [];
  let t = 0;
  const planner = new Planner(model, {
    goals: [goal(F.and(F.lit("on", ["a"], "b"), F.lit("on", ["b"], "c")))],
    now: () => t,
    seed: 7,
    trace: (e) => events.push(e),
  });

  runToTerminal(planner, () => {
    t += 1;
  });

  assert.equal(planner.getStatus(), "succeeded", "planner must recover from the slip and finish");
  assert.equal(slipsLeft, 0, "the slip executor must have fired exactly once");
  assert.ok(events.some((e) => e.t === "step.fail"), "a step must have failed (the slip)");
  const recovered =
    events.some((e) => e.t === "repair.attempt" || e.t === "repair.success") ||
    events.filter((e) => e.t === "plan.new").length >= 2;
  assert.ok(recovered, "planner must repair or replan after the slip");
  // model.read decodes entity fluents back to entity names
  assert.equal(model.read(planner.state, "on", "a"), "b");
  assert.equal(model.read(planner.state, "on", "b"), "c");
});

// ---------------------------------------------------------------- multi-effector (two arms)

test("two-arm coordination: builds two towers using a 2-hand domain", () => {
  // four blocks on the table, two hands; goal a-on-b and c-on-d.
  const model = blocksModel({ blocks: ["a", "b", "c", "d"], hands: ["left", "right"] });
  const result = planOnce(model, model.createExecState(), {
    goals: [goal(F.and(F.lit("on", ["a"], "b"), F.lit("on", ["c"], "d")))],
    weight: 1,
    heuristic: "hmax",
  });
  assert.equal(result.status, "success");
  const ops = opNames(result.plan);
  // optimal: pickup+stack for each of the two towers = 4 actions; the extra
  // hand must not break optimality (it just widens the grounding).
  assert.equal(ops.length, 4, `expected 4 actions, got ${ops.length}: ${ops.join(", ")}`);
  assert.ok(ops.every((n) => n === "pickup" || n === "stack"), `unexpected op in ${ops.join(", ")}`);
});

// ---------------------------------------------------------------- Scheduler under real planning load

test("scheduler drives two independent block-stackers to completion", () => {
  let t = 0;
  const now = () => t;
  const mk = (): Planner => {
    const model = blocksModel({ blocks: ["a", "b", "c"] });
    return new Planner(model, {
      goals: [goal(F.and(F.lit("on", ["a"], "b"), F.lit("on", ["b"], "c")))],
      now,
      seed: 1,
    });
  };
  const p1 = mk();
  const p2 = mk();
  const scheduler = new Scheduler();
  scheduler.add(p1);
  scheduler.add(p2);

  for (let i = 0; i < 300 && !(p1.getStatus() === "succeeded" && p2.getStatus() === "succeeded"); i++) {
    t += 1;
    scheduler.tick(4);
  }
  assert.equal(p1.getStatus(), "succeeded");
  assert.equal(p2.getStatus(), "succeeded");
});

test.run();
