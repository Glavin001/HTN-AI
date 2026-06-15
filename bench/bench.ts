/**
 * Representative benchmark with robust statistics (min / median / spread%).
 * Run: `npm run bench`  (add `NODE_OPTIONS=--expose-gc` for the lowest noise).
 *
 * Headline is the MIN ms/iter over several trials — the sample least
 * contaminated by GC / scheduler / CPU-freq noise. `spread%` = (median−min)/min
 * shows how noisy the measurement was; `µs/node` = min ÷ expansions is the
 * size-normalized cost (what a frame budget actually cares about).
 */
import {
  measure,
  printHeader,
  printRow,
  blocksReverse,
  hanoi,
  navGrid,
  htnTour,
  schedulerRun,
  staircaseModel,
  goal,
  planOnce,
  type Run,
} from "./workloads";
import {
  quarryInstance,
  quarryGoal,
  scavengerInstance,
  scavengerGoal,
  scavengerModel,
  staircaseInstance,
  staircaseGoal,
} from "../scenarios/staircase";

const quarry: Run = (() => {
  const model = staircaseModel(quarryInstance());
  return () => planOnce(model, model.createExecState(), { goals: [goal(quarryGoal())], weight: 1, heuristic: "hmax" });
})();
const scavenger: Run = (() => {
  const model = scavengerModel(scavengerInstance());
  return () => planOnce(model, model.createExecState(), { goals: [goal(scavengerGoal())], weight: 1, heuristic: "hmax" });
})();
const staircase: Run = (() => {
  const model = staircaseModel(staircaseInstance());
  return () => planOnce(model, model.createExecState(), { goals: [goal(staircaseGoal())], weight: 1, heuristic: "hmax" });
})();

console.log("=".repeat(86));
console.log(`htn-ai benchmark — min of N trials${(globalThis as { gc?: unknown }).gc ? " (gc between trials)" : " (run with NODE_OPTIONS=--expose-gc for lower noise)"}`);
console.log("=".repeat(86));
printHeader();
printRow(measure("quarry (hmax,w=1)", quarry));
printRow(measure("scavenger (hmax,w=1)", scavenger));
printRow(measure("staircase (hmax,w=1)", staircase));
printRow(measure("blocks reverse 6", blocksReverse(6)));
printRow(measure("hanoi 5", hanoi(5)));
printRow(measure("nav grid 6x6", navGrid(6)));
printRow(measure("htn tour 16", htnTour(16)));
printRow(measure("scheduler x8", schedulerRun(8)));
