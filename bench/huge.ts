import { goal, planOnce, type Model } from "../src/index";
import {
  scavengerModel, scavengerBigInstance, scavengerBigGoal,
  scavengerHugeInstance, scavengerHugeGoal,
} from "../scenarios/staircase";

function timeRun(label: string, model: Model, req: any, trials: number) {
  planOnce(model, model.createExecState(), req); // warm up
  let res = planOnce(model, model.createExecState(), req);
  const s: number[] = [];
  for (let t = 0; t < trials; t++) {
    const st = model.createExecState();
    const t0 = performance.now();
    res = planOnce(model, st, req);
    s.push(performance.now() - t0);
  }
  s.sort((a, b) => a - b);
  console.log(`${label}: min ${s[0].toFixed(0)}ms  median ${s[s.length >> 1].toFixed(0)}ms  [${res.status}] exp=${res.stats.expansions} steps=${res.plan?.steps.length}`);
}

const xl = scavengerModel(scavengerBigInstance());
const huge = scavengerModel(scavengerHugeInstance());
timeRun("Scavenger XL   (4x3, h3, hadd w=5)", xl, { goals: [goal(scavengerBigGoal())], weight: 5, heuristic: "hadd", maxNodes: 500_000 }, 7);
timeRun("Scavenger HUGE (6x4, h3, hadd w=6)", huge, { goals: [goal(scavengerHugeGoal())], weight: 6, heuristic: "hadd", maxNodes: 200_000 }, 3);
