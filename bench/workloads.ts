/**
 * Shared benchmark workloads + a robust measurement helper.
 *
 * Measurement methodology (for signal over CPU noise):
 *  - warm up so the JIT has settled before timing;
 *  - auto-calibrate the inner loop so each timed trial runs ≳ targetMs (timer
 *    resolution & per-batch overhead become negligible);
 *  - run several independent trials and report the MIN ms/iter as the headline —
 *    all interference (GC, scheduler preemption, CPU-freq dips) only *adds* time,
 *    so the minimum is the sample least contaminated by it;
 *  - also report the median and spread% = (median−min)/min so the noise is
 *    visible, not hidden;
 *  - call global.gc() between trials when run with `node --expose-gc` so GC pauses
 *    fall outside the timed window.
 */
import { DomainDoc, E, F, N, Planner, Scheduler, createModel, doTask, goal, planOnce, task, type PlanResult } from "../src/index";
import {
  staircaseInstance, staircaseGoal, staircaseModel,
  scavengerModel, scavengerGridInstance,
} from "../scenarios/staircase";

export type Run = () => PlanResult;

export interface Sample {
  label: string;
  minMs: number;
  medianMs: number;
  spreadPct: number;
  perNodeUs: number | null;
  expansions: number;
  decompositions: number;
  status: string;
}

export interface MeasureOpts {
  trials?: number;
  targetMs?: number;
  maxInner?: number;
}

const maybeGc = (globalThis as { gc?: () => void }).gc;

export function measure(label: string, run: Run, opts: MeasureOpts = {}): Sample {
  const { trials = 9, targetMs = 40, maxInner = 200_000 } = opts;

  // warm up (JIT)
  let last = run();
  for (let i = 0; i < 5; i++) last = run();

  // calibrate inner-loop count so each trial ≳ targetMs
  const c0 = performance.now();
  last = run();
  const single = Math.max(performance.now() - c0, 1e-4);
  const inner = Math.max(1, Math.min(maxInner, Math.ceil(targetMs / single)));

  const perIter: number[] = [];
  for (let t = 0; t < trials; t++) {
    if (maybeGc) maybeGc();
    const s = performance.now();
    for (let i = 0; i < inner; i++) last = run();
    perIter.push((performance.now() - s) / inner);
  }
  perIter.sort((a, b) => a - b);
  const minMs = perIter[0];
  const medianMs = perIter[(perIter.length - 1) >> 1];
  const spreadPct = ((medianMs - minMs) / minMs) * 100;
  const expansions = last.stats.expansions;
  const decompositions = last.stats.decompositions;
  const perNodeUs = expansions > 0 ? (minMs * 1000) / expansions : null;
  return { label, minMs, medianMs, spreadPct, perNodeUs, expansions, decompositions, status: last.status };
}

export function printHeader(): void {
  console.log(
    "workload".padEnd(30) +
      "min ms".padStart(11) +
      "median".padStart(10) +
      "spread".padStart(8) +
      "µs/node".padStart(10) +
      "exp".padStart(9) +
      "  status",
  );
  console.log("-".repeat(86));
}

export function printRow(s: Sample): void {
  console.log(
    s.label.padEnd(30) +
      s.minMs.toFixed(4).padStart(11) +
      s.medianMs.toFixed(4).padStart(10) +
      `${s.spreadPct.toFixed(0)}%`.padStart(8) +
      (s.perNodeUs === null ? "—" : s.perNodeUs.toFixed(2)).padStart(10) +
      String(s.expansions || s.decompositions).padStart(9) +
      `  [${s.status}]`,
  );
}

// ============================================================ workload builders

/** Blocks world (3-op move formulation, neq external). Reverse an N-tower. */
export function blocksReverse(n: number): Run {
  const names = Array.from({ length: n }, (_, i) => `b${i}`);
  const doc: DomainDoc = {
    name: "blocks",
    types: [{ name: "block" }],
    fluents: [
      { name: "on", params: [{ name: "b", type: "block" }], kind: "entity", entityType: "block" },
      { name: "clear", params: [{ name: "b", type: "block" }], kind: "boolean", initial: true },
    ],
    operators: [
      {
        name: "block_to_block",
        params: [{ name: "x", type: "block" }, { name: "from", type: "block" }, { name: "to", type: "block" }],
        pre: F.and(F.lit("clear", ["?x"]), F.lit("clear", ["?to"]), F.lit("on", ["?x"], "?from"), F.ext("neq", ["?x", "?to"], [])),
        eff: [E.set("on", ["?x"], "?to"), E.set("clear", ["?from"], true), E.set("clear", ["?to"], false)],
      },
      {
        name: "block_to_table",
        params: [{ name: "x", type: "block" }, { name: "from", type: "block" }],
        pre: F.and(F.lit("clear", ["?x"]), F.lit("on", ["?x"], "?from")),
        eff: [E.set("on", ["?x"], 0), E.set("clear", ["?from"], true)],
      },
      {
        name: "table_to_block",
        params: [{ name: "x", type: "block" }, { name: "to", type: "block" }],
        pre: F.and(F.lit("clear", ["?x"]), F.lit("clear", ["?to"]), F.lit("on", ["?x"], 0), F.ext("neq", ["?x", "?to"], [])),
        eff: [E.set("on", ["?x"], "?to"), E.set("clear", ["?to"], false)],
      },
    ],
  };
  const model = createModel(
    doc,
    {
      entities: Object.fromEntries(names.map((nm) => [nm, "block"])),
      init: (w) => {
        for (let i = 0; i < n - 1; i++) {
          w.set("on", [names[i]], names[i + 1]);
          w.set("clear", [names[i + 1]], false);
        }
      },
    },
    { predicates: { neq: (q) => q.args[0] !== q.args[1] } },
  );
  const goalLits = [];
  for (let i = n - 1; i > 0; i--) goalLits.push(F.lit("on", [names[i]], names[i - 1]));
  return () => planOnce(model, model.createExecState(), { goals: [goal(F.and(...goalLits))], weight: 1 });
}

/** Towers of Hanoi (external canMoveTo predicate; plan length 2^n − 1). */
export function hanoi(nDisks: number): Run {
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
  return () => planOnce(model, model.createExecState(), { goals: [goal(F.and(...goalLits))], weight: 1 });
}

/** Grid navigation: K×K cells, 4-connected, reach the far corner (relational adj). */
export function navGrid(k: number): Run {
  const id = (x: number, y: number) => `c_${x}_${y}`;
  const cells: string[] = [];
  for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) cells.push(id(x, y));
  const doc: DomainDoc = {
    name: "nav",
    types: [{ name: "cell" }],
    fluents: [
      { name: "at", kind: "entity", entityType: "cell" },
      { name: "adj", params: [{ name: "a", type: "cell" }, { name: "b", type: "cell" }], kind: "boolean", initial: false },
      { name: "pos", params: [{ name: "c", type: "cell" }], kind: "vec2" },
    ],
    operators: [
      {
        name: "move",
        params: [{ name: "from", type: "cell" }, { name: "to", type: "cell" }],
        pre: F.and(F.lit("at", [], "?from"), F.lit("adj", ["?from", "?to"])),
        eff: [E.set("at", [], "?to")],
        cost: 1,
      },
    ],
  };
  const model = createModel(doc, {
    entities: Object.fromEntries(cells.map((c) => [c, "cell"])),
    init: (w) => {
      for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) {
        w.set("pos", [id(x, y)], [x, y]);
        for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
          const nx = x + dx, ny = y + dy;
          if (nx < k && ny < k) { w.set("adj", [id(x, y), id(nx, ny)], true); w.set("adj", [id(nx, ny), id(x, y)], true); }
        }
      }
      w.set("at", [], id(0, 0));
    },
  });
  const goalF = F.lit("at", [], id(k - 1, k - 1));
  return () => planOnce(model, model.createExecState(), { goals: [goal(goalF)], weight: 1, heuristic: "hmax" });
}

/** HTN decomposition: visit K locations (recursive method with a free parameter). */
export function htnTour(k: number): Run {
  const locs = Array.from({ length: k }, (_, i) => `l${i}`);
  const doc: DomainDoc = {
    name: "tour",
    types: [{ name: "loc" }],
    fluents: [{ name: "visited", params: [{ name: "l", type: "loc" }], kind: "boolean", initial: false }],
    compounds: [{ name: "Tour" }],
    operators: [
      { name: "visit", params: [{ name: "l", type: "loc" }], pre: F.not(F.lit("visited", ["?l"])), eff: [E.set("visited", ["?l"], true)] },
    ],
    methods: [
      { name: "more", task: "Tour", params: [{ name: "next", type: "loc" }], pre: F.not(F.lit("visited", ["?next"])), subtasks: [doTask("visit", "?next"), doTask("Tour")] },
      { name: "done", task: "Tour", subtasks: [] },
    ],
  };
  const model = createModel(doc, { entities: Object.fromEntries(locs.map((l) => [l, "loc"])) });
  return () => planOnce(model, model.createExecState(), { goals: [task("Tour")] });
}

/** Multi-agent: M staircase planners driven round-robin to completion. */
export function schedulerRun(m: number): Run {
  return () => {
    const sched = new Scheduler();
    const planners: Planner[] = [];
    let t = 0;
    for (let i = 0; i < m; i++) {
      const model = staircaseModel(staircaseInstance());
      const p = new Planner(model, { goals: [goal(staircaseGoal())], now: () => t, seed: i });
      planners.push(p);
      sched.add(p);
    }
    for (let i = 0; i < 4000 && planners.some((p) => p.getStatus() !== "succeeded" && p.getStatus() !== "failed"); i++) {
      t += 1;
      sched.tick(5);
    }
    const done = planners.every((p) => p.getStatus() === "succeeded");
    return { status: done ? "success" : "failure", stats: { decompositions: 0, expansions: 0, heuristicEvals: 0 } } as PlanResult;
  };
}

/** Scavenger on a W×D grid (the pushed "big/huge" spatial GOAP family). Greedy
 *  hadd. Search cost grows ~ground-ops (heuristic sweeps every op), so this is a
 *  realistic large-domain scaling axis. */
export function scavengerGrid(w: number, d: number, goalHeight = 3, weight = 6): Run {
  const model = scavengerModel(scavengerGridInstance(w, d));
  const goalF = F.and(F.lit("agentAt", [], `c${w - 1}_0`), F.eq(N.fl("agentY"), N.c(goalHeight)));
  return () => planOnce(model, model.createExecState(), { goals: [goal(goalF)], weight, heuristic: "hadd", maxNodes: 500_000 });
}

export { staircaseModel, staircaseInstance, staircaseGoal, goal, planOnce, N };
