/** Profiling driver. SCEN=quarry|hanoi|scavenger, ITERS=n. */
import { DomainDoc, E, F, createModel, goal, planOnce } from "../src/index";
import { quarryInstance, quarryGoal, scavengerInstance, scavengerGoal, scavengerModel, staircaseModel } from "../scenarios/staircase";

function hanoiModel(nDisks: number) {
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
        params: [{ name: "d", type: "disk" }, { name: "from", type: "peg" }, { name: "to", type: "peg" }],
        pre: F.and(F.lit("peg", ["?d"], "?from"), F.ext("neq", ["?from", "?to"], []), F.ext("canMoveTo", ["?d", "?to"], ["peg", "size"])),
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
  return { model, req: { goals: [goal(F.and(...goalLits))], weight: 1 as const } };
}

const SCEN = process.env.SCEN ?? "quarry";
const N = Number(process.env.ITERS ?? 200);
let run: () => { stats: { expansions: number } };
if (SCEN === "hanoi") { const { model, req } = hanoiModel(Number(process.env.DISKS ?? 5)); run = () => planOnce(model, model.createExecState(), req); }
else if (SCEN === "scavenger") { const m = scavengerModel(scavengerInstance()); run = () => planOnce(m, m.createExecState(), { goals: [goal(scavengerGoal())], weight: 1, heuristic: "hmax" }); }
else { const m = staircaseModel(quarryInstance()); run = () => planOnce(m, m.createExecState(), { goals: [goal(quarryGoal())], weight: 1, heuristic: "hmax" }); }

const t0 = performance.now();
let exp = 0;
for (let i = 0; i < N; i++) exp = run().stats.expansions;
const dt = performance.now() - t0;
console.log(`${SCEN} x${N}: ${dt.toFixed(0)}ms total, ${(dt / N).toFixed(2)}ms/iter, ${exp} expansions`);
