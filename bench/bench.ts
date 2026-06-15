/**
 * Performance benchmark harness for the htn-ai planner.
 *
 * Exercises the heaviest GOAP / HTN workloads, repeats each to get a stable
 * wall-clock, and reports the engine's own counters (decompositions /
 * expansions / heuristicEvals) so we can see *where* the cost is and how it
 * scales. Run: `tsx --tsconfig tsconfig.tests.json bench/bench.ts`.
 */
import { DomainDoc, E, F, N, createModel, goal, planOnce, scoped, achieve, task, type PlanResult } from "../src/index";
import {
  quarryInstance,
  quarryGoal,
  scavengerInstance,
  scavengerGoal,
  scavengerModel,
  staircaseInstance,
  staircaseGoal,
  staircaseModel,
} from "../scenarios/staircase";

function bench(name: string, run: () => PlanResult, iters: number): void {
  // warm up
  let last = run();
  for (let i = 0; i < 2; i++) last = run();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) last = run();
  const dt = performance.now() - t0;
  const per = dt / iters;
  const s = last.stats;
  const status = last.status;
  console.log(
    `${name.padEnd(34)} ${per.toFixed(3).padStart(9)} ms/iter  ` +
      `[${status.padEnd(7)}] ` +
      `dec=${String(s.decompositions).padStart(7)} ` +
      `exp=${String(s.expansions).padStart(7)} ` +
      `hEval=${String(s.heuristicEvals).padStart(7)} ` +
      `steps=${last.plan?.steps.length ?? 0}`,
  );
}

// ---------------------------------------------------------------- blocks world (scalable)

function blocksWorldDoc(): DomainDoc {
  return {
    name: "blocks",
    types: [{ name: "block" }],
    fluents: [
      { name: "on", params: [{ name: "b", type: "block" }], kind: "entity", entityType: "block" },
      { name: "clear", params: [{ name: "b", type: "block" }], kind: "boolean", initial: true },
    ],
    operators: [
      {
        name: "block_to_block",
        params: [
          { name: "x", type: "block" },
          { name: "from", type: "block" },
          { name: "to", type: "block" },
        ],
        pre: F.and(
          F.lit("clear", ["?x"]),
          F.lit("clear", ["?to"]),
          F.lit("on", ["?x"], "?from"),
          F.ext("neq", ["?x", "?to"], []),
        ),
        eff: [E.set("on", ["?x"], "?to"), E.set("clear", ["?from"], true), E.set("clear", ["?to"], false)],
      },
      {
        name: "block_to_table",
        params: [
          { name: "x", type: "block" },
          { name: "from", type: "block" },
        ],
        pre: F.and(F.lit("clear", ["?x"]), F.lit("on", ["?x"], "?from")),
        eff: [E.set("on", ["?x"], 0), E.set("clear", ["?from"], true)],
      },
      {
        name: "table_to_block",
        params: [
          { name: "x", type: "block" },
          { name: "to", type: "block" },
        ],
        pre: F.and(F.lit("clear", ["?x"]), F.lit("clear", ["?to"]), F.lit("on", ["?x"], 0), F.ext("neq", ["?x", "?to"], [])),
        eff: [E.set("on", ["?x"], "?to"), E.set("clear", ["?to"], false)],
      },
    ],
  };
}

// Stack N blocks reversed: start a-on-b-on-c-...-on-table → goal reversed tower.
function blocksReverse(n: number): () => PlanResult {
  const names = Array.from({ length: n }, (_, i) => `b${i}`);
  const doc = blocksWorldDoc();
  const model = createModel(
    doc,
    {
      entities: Object.fromEntries(names.map((nm) => [nm, "block"])),
      init: (w) => {
        // initial tower: b0 on b1 on ... on b{n-1} on table
        for (let i = 0; i < n - 1; i++) {
          w.set("on", [names[i]], names[i + 1]);
          w.set("clear", [names[i + 1]], false);
        }
      },
    },
    { predicates: { neq: (q) => q.args[0] !== q.args[1] } },
  );
  // goal: reverse the tower → b{n-1} on b{n-2} ... on b0
  const goalLits = [];
  for (let i = n - 1; i > 0; i--) goalLits.push(F.lit("on", [names[i]], names[i - 1]));
  return () => planOnce(model, model.createExecState(), { goals: [goal(F.and(...goalLits))], weight: 1 });
}

// ---------------------------------------------------------------- hanoi (scalable)

function hanoi(nDisks: number): () => PlanResult {
  const disks = Array.from({ length: nDisks }, (_, i) => `d${i + 1}`);
  const doc: DomainDoc = {
    name: "hanoi",
    types: [{ name: "disk" }, { name: "peg" }],
    fluents: [
      { name: "peg", params: [{ name: "d", type: "disk" }], kind: "entity", entityType: "peg" },
      { name: "size", params: [{ name: "d", type: "disk" }], kind: "int" },
    ],
    operators: [
      {
        name: "move",
        params: [
          { name: "d", type: "disk" },
          { name: "from", type: "peg" },
          { name: "to", type: "peg" },
        ],
        pre: F.and(
          F.lit("peg", ["?d"], "?from"),
          F.ext("neq", ["?from", "?to"], []),
          F.ext("canMoveTo", ["?d", "?to"], ["peg", "size"]),
        ),
        eff: [E.set("peg", ["?d"], "?to")],
      },
    ],
  };
  const model = createModel(
    doc,
    {
      entities: { ...Object.fromEntries(disks.map((d) => [d, "disk"])), p1: "peg", p2: "peg", p3: "peg" },
      init: (w) => disks.forEach((d, i) => { w.set("peg", [d], "p1"); w.set("size", [d], i + 1); }),
    },
    {
      predicates: {
        neq: (q) => q.args[0] !== q.args[1],
        canMoveTo: (q) => {
          const [d, to] = q.args;
          const dPeg = q.get("peg", d);
          const dSize = q.get("size", d);
          for (const other of disks) {
            const og = q.gid(other);
            if (og === d) continue;
            if (q.get("size", og) < dSize) {
              const oPeg = q.get("peg", og);
              if (oPeg === dPeg || oPeg === to + 1) return false;
            }
          }
          return true;
        },
      },
    },
  );
  const goalLits = disks.map((d) => F.lit("peg", [d], "p3"));
  return () => planOnce(model, model.createExecState(), { goals: [goal(F.and(...goalLits))], weight: 1 });
}

// ---------------------------------------------------------------- scenarios

const quarry = (() => {
  const model = staircaseModel(quarryInstance());
  return () => planOnce(model, model.createExecState(), { goals: [goal(quarryGoal())], weight: 1, heuristic: "hmax" });
})();

const quarryGreedy = (() => {
  const model = staircaseModel(quarryInstance());
  return () => planOnce(model, model.createExecState(), { goals: [goal(quarryGoal())], weight: 2, heuristic: "hadd" });
})();

const scavenger = (() => {
  const model = scavengerModel(scavengerInstance());
  return () => planOnce(model, model.createExecState(), { goals: [goal(scavengerGoal())], weight: 1, heuristic: "hmax" });
})();

const staircase = (() => {
  const model = staircaseModel(staircaseInstance());
  return () => planOnce(model, model.createExecState(), { goals: [goal(staircaseGoal())], weight: 1, heuristic: "hmax" });
})();

// ---------------------------------------------------------------- run

console.log("=".repeat(100));
console.log("htn-ai planner benchmark");
console.log("=".repeat(100));

bench("quarry (hmax, w=1, optimal)", quarry, 200);
bench("quarry (hadd, w=2, greedy)", quarryGreedy, 200);
bench("scavenger (hmax, w=1)", scavenger, 200);
bench("staircase (hmax, w=1)", staircase, 500);
bench("blocks reverse 4 (w=1)", blocksReverse(4), 200);
bench("blocks reverse 5 (w=1)", blocksReverse(5), 50);
bench("blocks reverse 6 (w=1)", blocksReverse(6), 20);
bench("hanoi 3 (w=1)", hanoi(3), 500);
bench("hanoi 4 (w=1)", hanoi(4), 100);
bench("hanoi 5 (w=1)", hanoi(5), 20);
