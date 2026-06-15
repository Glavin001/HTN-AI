/**
 * Scaling sweeps: grow each workload along one axis and watch how cost grows.
 * Run: `npm run bench:scale`  (add `NODE_OPTIONS=--expose-gc` for lower noise).
 *
 * Each row is the MIN ms over several trials (noise-resistant). `µs/node` =
 * ms ÷ expansions isolates per-node cost from problem size; `×prev` is the
 * growth factor of min-ms vs the previous size, so super-linear scaling is
 * visible at a glance. Axes are chosen to stress different engine hot paths:
 *
 *   hanoi disks   — exponential search depth + external predicate per node
 *   blocks        — grounding O(n³) + state size, shallow search
 *   nav grid      — relational adjacency: successor candidates per node ∝ cells
 *   htn tour      — HTN decomposition width (free-variable method binding)
 *   scheduler     — multi-agent round-robin planning
 *   weight        — heuristic informativeness → expansions (same problem)
 */
import { measure, blocksReverse, hanoi, navGrid, htnTour, schedulerRun, staircaseModel, goal, planOnce, type Run, type Sample } from "./workloads";
import { quarryInstance, quarryGoal } from "../scenarios/staircase";

function sweep(title: string, axis: string, sizes: number[], make: (n: number) => Run, opts = {}): void {
  console.log(`\n${title}`);
  console.log(`${axis.padEnd(10)}${"min ms".padStart(12)}${"µs/node".padStart(11)}${"exp/dec".padStart(11)}${"×prev".padStart(9)}  status`);
  console.log("-".repeat(64));
  let prev = 0;
  for (const n of sizes) {
    let s: Sample;
    try {
      s = measure(`${axis}=${n}`, make(n), opts);
    } catch (e) {
      console.log(`${String(n).padEnd(10)}  (skipped: ${(e as Error).message.slice(0, 40)})`);
      continue;
    }
    const ratio = prev > 0 ? s.minMs / prev : 0;
    console.log(
      String(n).padEnd(10) +
        s.minMs.toFixed(4).padStart(12) +
        (s.perNodeUs === null ? "—" : s.perNodeUs.toFixed(2)).padStart(11) +
        String(s.expansions || s.decompositions).padStart(11) +
        (ratio ? `${ratio.toFixed(2)}×` : "—").padStart(9) +
        `  [${s.status}]`,
    );
    prev = s.minMs;
  }
}

function quarryWeighted(weight: number, heuristic: "hmax" | "hadd"): Run {
  const model = staircaseModel(quarryInstance());
  return () => planOnce(model, model.createExecState(), { goals: [goal(quarryGoal())], weight, heuristic });
}

console.log("=".repeat(64));
console.log(`htn-ai scaling sweeps${(globalThis as { gc?: unknown }).gc ? " (gc between trials)" : " (tip: NODE_OPTIONS=--expose-gc)"}`);
console.log("=".repeat(64));

sweep("Hanoi — search depth (2^n−1) + external predicate", "disks", [3, 4, 5, 6, 7, 8], hanoi, { targetMs: 30 });
sweep("Blocks — grounding O(n³) + state size", "blocks", [4, 6, 8, 10, 12], blocksReverse);
sweep("Nav grid — relational adjacency / branching", "K", [4, 6, 8, 10, 12], navGrid, { targetMs: 30 });
sweep("HTN tour — decomposition width", "locs", [8, 16, 32, 64, 128], htnTour);
sweep("Scheduler — multi-agent round-robin", "agents", [1, 2, 4, 8, 16, 32], schedulerRun, { targetMs: 30 });

// heuristic informativeness on a fixed problem (expansions move, not size)
console.log("\nQuarry — heuristic / weight (fixed problem; expansions vary)");
console.log(`${"config".padEnd(16)}${"min ms".padStart(12)}${"µs/node".padStart(11)}${"exp".padStart(9)}  status`);
console.log("-".repeat(56));
for (const [label, run] of [
  ["hmax w=1 (opt)", quarryWeighted(1, "hmax")],
  ["hadd w=1", quarryWeighted(1, "hadd")],
  ["hadd w=1.4", quarryWeighted(1.4, "hadd")],
  ["hadd w=2", quarryWeighted(2, "hadd")],
] as const) {
  const s = measure(label, run);
  console.log(
    label.padEnd(16) + s.minMs.toFixed(4).padStart(12) + (s.perNodeUs?.toFixed(2) ?? "—").padStart(11) + String(s.expansions).padStart(9) + `  [${s.status}]`,
  );
}
