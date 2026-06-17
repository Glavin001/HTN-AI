import { test } from "uvu";
import * as assert from "uvu/assert";
import { F, Formula, goal, planOnce } from "../src/index";
import type { Model } from "../src/index";
import { blocksModel, sussmanSetup, towerSetup } from "../scenarios/blocks";

/**
 * LM-cut (Helmert & Domshlak 2009) — an admissible landmark heuristic that
 * dominates h_max. These tests pin the two properties that matter for the goal
 * we set out to reach: it stays OPTIMAL (weight-1 A* returns the same cost as the
 * admissible h_max), and it is far more INFORMATIVE (it expands a fraction of the
 * nodes), which is what makes joint optimal planning tractable on the interacting
 * subgoals where serialization is forced to choose suboptimality (cf. Sussman:
 * serialized 10 vs optimal 6 — see docs/goal-serialization.md).
 */

interface Solved {
  status: "success" | "failure";
  cost: number;
  expansions: number;
}
function solve(model: Model, g: Formula, heuristic: "hmax" | "lmcut" | "hadd", maxNodes = 2_000_000): Solved {
  const r = planOnce(model, model.createExecState(), { goals: [goal(g)], weight: 1, heuristic, maxNodes });
  return {
    status: r.status,
    cost: r.plan ? r.plan.steps.filter((s) => s.k === "op").length : -1,
    expansions: r.stats.expansions,
  };
}

/** reverse a tower b0-on-b1-…-on-table into b(N-1)-on-…-on-b0 */
function reverseTower(n: number): { model: () => Model; g: Formula } {
  const ns = Array.from({ length: n }, (_, i) => `b${i}`);
  const conj: Formula[] = [];
  for (let i = 1; i < n; i++) conj.push(F.lit("on", [ns[i]], ns[i - 1]));
  return { model: () => blocksModel(towerSetup(ns)), g: F.and(...conj) };
}

const sussmanGoal = F.and(F.lit("on", ["a"], "b"), F.lit("on", ["b"], "c"));

// ---------------------------------------------------------------- optimality

test("lmcut with weight 1 returns the optimal cost (matches admissible h_max)", () => {
  const cases: { name: string; model: () => Model; g: Formula }[] = [
    { name: "sussman", model: () => blocksModel(sussmanSetup()), g: sussmanGoal },
    { name: "reverse6", ...reverseTower(6) },
    { name: "reverse8", ...reverseTower(8) },
  ];
  for (const c of cases) {
    const ref = solve(c.model(), c.g, "hmax");
    const lm = solve(c.model(), c.g, "lmcut");
    assert.is(lm.status, "success", `${c.name}: lmcut should solve`);
    // Both heuristics are admissible at weight 1 ⇒ both return the optimal cost.
    assert.is(lm.cost, ref.cost, `${c.name}: lmcut cost ${lm.cost} must equal optimal ${ref.cost}`);
  }
});

// ---------------------------------------------------------------- informativeness

test("lmcut expands far fewer nodes than h_max on interacting goals", () => {
  for (const n of [8, 9]) {
    const { model, g } = reverseTower(n);
    const hmax = solve(model(), g, "hmax");
    const lm = solve(model(), g, "lmcut");
    assert.is(lm.cost, hmax.cost, `reverse${n}: same optimal cost`);
    // LM-cut's landmark bound is much tighter here — demand at least a 2× cut.
    assert.ok(
      lm.expansions * 2 <= hmax.expansions,
      `reverse${n}: lmcut expansions ${lm.expansions} should be ≤ half of h_max ${hmax.expansions}`,
    );
  }
});

test("lmcut solves an optimal goal within a node budget that h_max cannot", () => {
  // reverse9 needs ~1.2k expansions under h_max; LM-cut needs a small fraction.
  const { model, g } = reverseTower(9);
  const budget = 300;
  const hmax = solve(model(), g, "hmax", budget);
  const lm = solve(model(), g, "lmcut", budget);
  assert.is(hmax.status, "failure", `h_max should exhaust the ${budget}-node budget`);
  assert.is(lm.status, "success", `lmcut should solve within the ${budget}-node budget`);
  assert.is(lm.cost, 18, "and still optimally (18 actions)");
});

// ---------------------------------------------------------------- soundness edges

test("lmcut handles an already-satisfied goal (h = 0) and stays admissible", () => {
  // Goal already true in the initial tower ⇒ zero-cost, instantly solved.
  const ns = ["b0", "b1", "b2"];
  const model = blocksModel(towerSetup(ns)); // b0-on-b1-on-b2-on-table
  const already = solve(model, F.lit("on", ["b0"], "b1"), "lmcut");
  assert.is(already.status, "success");
  assert.is(already.cost, 0);
});

test.run();
