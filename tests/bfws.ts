import { test } from "uvu";
import * as assert from "uvu/assert";
import { F, Planner, goal, planOnce } from "../src/index";
import type { Model } from "../src/index";
import { blocksModel, sussmanSetup } from "../scenarios/blocks";

/**
 * Best-First Width Search (Lipovetzky & Geffner, AAAI 2017) with preferred
 * operators (FF helpful actions) and deferred heuristic evaluation — the real-time
 * / agile search lineage. These tests pin the two properties that make it the
 * right tool under a tick budget: it stays cheap (deferred evaluation computes the
 * relaxed plan once per EXPANDED node, not per generated child) and it scales to
 * hard instances that weighted-A\* can't reach within a small budget — trading
 * cost-optimality for coverage and speed, by design.
 */

// A deterministic hard 18-block instance (random init + random goal). Weighted-A\*
// needs ~9k expansions / ~41k heuristic evals; BFWS solves it in ~436 / ~435.
const HARD_INIT: [string, string][] = [
  ["b0", "b17"], ["b1", "b15"], ["b2", "b7"], ["b3", "b12"], ["b4", "b6"], ["b7", "b3"],
  ["b8", "b10"], ["b9", "b16"], ["b10", "b0"], ["b11", "b14"], ["b13", "b5"], ["b14", "b1"], ["b16", "b13"],
];
const HARD_GOAL: [string, string][] = [
  ["b1", "b0"], ["b2", "b9"], ["b3", "b1"], ["b4", "b15"], ["b5", "b11"], ["b6", "b2"], ["b7", "b17"],
  ["b8", "b3"], ["b10", "b4"], ["b12", "b6"], ["b13", "b7"], ["b14", "b13"], ["b16", "b10"],
];
const HARD_BLOCKS = Array.from({ length: 18 }, (_, i) => `b${i}`);
function hardModel(): Model {
  return blocksModel({
    blocks: HARD_BLOCKS,
    init: (w) => {
      for (const [b, u] of HARD_INIT) {
        w.set("on", [b], u);
        w.set("clear", [u], false);
      }
    },
  });
}
const hardGoal = F.and(...HARD_GOAL.map(([b, u]) => F.lit("on", [b], u)));
const sussmanGoal = F.and(F.lit("on", ["a"], "b"), F.lit("on", ["b"], "c"));

function solve(model: Model, g: typeof hardGoal, req: object, maxNodes = 500_000) {
  const r = planOnce(model, model.createExecState(), { goals: [goal(g)], maxNodes, ...req });
  return { status: r.status, expansions: r.stats.expansions, heuristicEvals: r.stats.heuristicEvals };
}

/** Drive a reactive Planner to a terminal state and return it. */
function execute(model: Model, g: typeof hardGoal, search: "wastar" | "bfws"): Planner {
  let t = 0;
  const p = new Planner(model, { goals: [goal(g)], search, now: () => t, seed: 1 });
  for (let i = 0; i < 5000 && p.getStatus() !== "succeeded" && p.getStatus() !== "failed"; i++) {
    t++;
    p.tick({ ms: 50 });
  }
  return p;
}

// ---------------------------------------------------------------- validity (end-to-end)

test("BFWS finds a valid plan that, executed, reaches the goal (Sussman + hard instance)", () => {
  const s = execute(blocksModel(sussmanSetup()), sussmanGoal, "bfws");
  assert.is(s.getStatus(), "succeeded", "Sussman should be solved");
  assert.is(s.model.read(s.state, "on", "a"), "b");
  assert.is(s.model.read(s.state, "on", "b"), "c");

  const h = execute(hardModel(), hardGoal, "bfws");
  assert.is(h.getStatus(), "succeeded", "hard instance should be solved");
  for (const [b, u] of HARD_GOAL) assert.is(h.model.read(h.state, "on", b), u, `on(${b}, ${u}) must hold`);
});

// ---------------------------------------------------------------- agility / coverage

test("BFWS solves within a tight node budget that weighted-A* exhausts", () => {
  const budget = 1500;
  const wastar = solve(hardModel(), hardGoal, {}, budget);
  const bfws = solve(hardModel(), hardGoal, { search: "bfws" }, budget);
  assert.is(wastar.status, "failure", `weighted-A* should exhaust the ${budget}-node budget`);
  assert.is(bfws.status, "success", `BFWS should solve within ${budget} nodes`);
});

// ---------------------------------------------------------------- deferred evaluation

test("deferred evaluation: BFWS computes ~one heuristic per expanded node, far fewer than weighted-A*", () => {
  const wastar = solve(hardModel(), hardGoal, {});
  const bfws = solve(hardModel(), hardGoal, { search: "bfws" });
  assert.is(bfws.status, "success");
  // The relaxed plan is computed once per expanded node (goal nodes don't need it).
  assert.ok(
    bfws.heuristicEvals <= bfws.expansions,
    `deferred: heuristicEvals ${bfws.heuristicEvals} should be ≤ expansions ${bfws.expansions}`,
  );
  // Weighted-A* evaluates every generated child ⇒ dramatically more heuristic work.
  assert.ok(
    bfws.heuristicEvals * 10 < wastar.heuristicEvals,
    `BFWS heuristicEvals ${bfws.heuristicEvals} should be «  weighted-A* ${wastar.heuristicEvals}`,
  );
});

test("BFWS width cap 1 (atoms only) still solves the hard instance", () => {
  const bfws = solve(hardModel(), hardGoal, { search: "bfws", noveltyWidth: 1 });
  assert.is(bfws.status, "success");
});

test.run();
