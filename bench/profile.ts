/** Focused profiling driver: just the heavy quarry search, many iters. */
import { createModel, goal, planOnce } from "../src/index";
import { quarryInstance, quarryGoal, staircaseModel } from "../scenarios/staircase";

const model = staircaseModel(quarryInstance());
const N = Number(process.env.ITERS ?? 80);
const t0 = performance.now();
let exp = 0;
for (let i = 0; i < N; i++) {
  const r = planOnce(model, model.createExecState(), { goals: [goal(quarryGoal())], weight: 1, heuristic: "hmax" });
  exp = r.stats.expansions;
}
const dt = performance.now() - t0;
console.log(`quarry x${N}: ${dt.toFixed(0)}ms total, ${(dt / N).toFixed(2)}ms/iter, ${exp} expansions`);
