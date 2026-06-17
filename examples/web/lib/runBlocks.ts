"use client";
/**
 * Blocks World run path for the web preview. Like lib/run.ts, this drives the
 * real htn-ai Planner — here over the 4-op STRIPS blocks domain — and snapshots
 * the world after each executed step. It also precomputes a stable 3D layout per
 * frame (so the renderer stays dumb): each block sits in the column of its
 * stack's table-root, at a height equal to its depth; a held block hovers above
 * where it will land next.
 *
 * Two scenarios share this path:
 *  - Sussman (default): the classic A-on-B-on-C anomaly.
 *  - Hard (`runBlocks(true)`): a 12-block scramble that the heuristic plateaus on,
 *    run under BOTH weighted-A* and BFWS so the demo can show, side by side, how
 *    much cheaper Best-First Width Search reaches a plan. The animated solve is the
 *    BFWS one.
 */
import { F, Planner, goal, planOnce, type Formula, type TraceEvent } from "htn-ai";
import { blocksModel, sussmanSetup } from "@scenarios/blocks";
import type { Model } from "htn-ai";

export interface BlocksFrame {
  /** block name → [x, stackDepth] for rendering */
  positions: Record<string, [number, number]>;
  /** block name → ("table" | other block) for the HUD */
  on: Record<string, string>;
  held: string | null;
  action: string;
}

/** one planner's cost to reach a plan on the same instance */
export interface SearchMetric {
  label: string;
  note: string;
  expansions: number;
  heuristicEvals: number;
  ms: number;
  planLength: number;
  ok: boolean;
}
export interface BlocksCompare {
  wastar: SearchMetric;
  bfws: SearchMetric;
}

export interface BlocksRun {
  blocks: string[];
  frames: BlocksFrame[];
  status: string;
  trace: TraceEvent[];
  goalText: string;
  /** present only for the hard instance: the head-to-head search-cost comparison */
  compare?: BlocksCompare;
}

const SPACING = 1.7;
const CARRY_Y = 4;
const HAND = "arm";

// A deterministic 12-block scramble (random initial layout → random goal). The
// delete-relaxation heuristic plateaus on it: weighted-A* expands ~1400 nodes and
// runs ~4500 heuristic evaluations; BFWS solves it in ~130 expansions / ~130
// heuristic evaluations — novelty + preferred operators + deferred evaluation.
const HARD_INIT: [string, string][] = [["C", "F"], ["D", "H"], ["F", "B"], ["G", "K"], ["H", "I"], ["J", "L"], ["K", "A"], ["L", "E"]];
const HARD_GOAL: [string, string][] = [["B", "G"], ["C", "I"], ["D", "A"], ["E", "D"], ["F", "J"], ["G", "H"], ["I", "L"], ["J", "K"]];
const HARD_BLOCKS = "ABCDEFGHIJKL".split("");

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

/** Plan the joint goal once with a given strategy and report what it cost. */
function bench(label: string, note: string, goalFormula: Formula, req: object): SearchMetric {
  const model = hardModel();
  const t0 = performance.now();
  const r = planOnce(model, model.createExecState(), { goals: [goal(goalFormula)], maxNodes: 200_000, ...req });
  const ms = performance.now() - t0;
  const planLength = r.plan ? r.plan.steps.filter((s) => s.k === "op").length : -1;
  return { label, note, expansions: r.stats.expansions, heuristicEvals: r.stats.heuristicEvals, ms, planLength, ok: r.status === "success" };
}

export function runBlocks(hard = false): BlocksRun {
  const blocks = hard ? HARD_BLOCKS : sussmanSetup().blocks;
  const model = hard ? hardModel() : blocksModel(sussmanSetup());
  const goalFormula = hard
    ? F.and(...HARD_GOAL.map(([b, u]) => F.lit("on", [b], u)))
    : F.and(F.lit("on", ["a"], "b"), F.lit("on", ["b"], "c"));

  // head-to-head search cost on the hard instance (same goal, same world)
  const compare: BlocksCompare | undefined = hard
    ? {
        wastar: bench("weighted-A*", "default · cost-optimal-ish, evaluates every child", goalFormula, {}),
        bfws: bench("BFWS", "novelty + preferred ops + deferred eval", goalFormula, { search: "bfws" }),
      }
    : undefined;

  const trace: TraceEvent[] = [];
  let t = 0;
  const planner = new Planner(model, {
    goals: [goal(goalFormula)],
    now: () => t,
    seed: 1,
    trace: (e) => trace.push(e),
    // the animated solve uses BFWS for the hard instance, default for Sussman
    ...(hard ? { search: "bfws" as const } : {}),
  });

  const sorted = [...blocks].sort();
  const homeX: Record<string, number> = {};
  sorted.forEach((b, i) => {
    homeX[b] = (i - (sorted.length - 1) / 2) * SPACING;
  });

  interface Raw {
    on: Record<string, string>;
    held: string | null;
    action: string;
  }
  const readRaw = (action: string): Raw => {
    const on: Record<string, string> = {};
    for (const b of blocks) {
      const o = model.read(planner.state, "on", b);
      on[b] = typeof o === "string" && o ? o : "table";
    }
    const handEmpty = model.read(planner.state, "handEmpty", HAND) as boolean;
    const heldRaw = model.read(planner.state, "holding", HAND);
    const held = !handEmpty && typeof heldRaw === "string" && heldRaw ? heldRaw : null;
    return { on, held, action };
  };

  const raws: Raw[] = [readRaw("start")];
  for (let i = 0; i < 800; i++) {
    const st = planner.getStatus();
    if (st === "succeeded" || st === "failed") break;
    t += 1;
    const before = trace.length;
    planner.tick({ ms: 5 });
    const done = trace.slice(before).find((e) => e.t === "step.done");
    if (done && done.t === "step.done") raws.push(readRaw(done.label));
  }

  const layoutOf = (on: Record<string, string>, held: string | null): Record<string, [number, number]> => {
    const pos: Record<string, [number, number]> = {};
    for (const b of blocks) {
      if (b === held) continue;
      let cur = b;
      let depth = 0;
      const seen = new Set<string>();
      while (on[cur] && on[cur] !== "table" && !seen.has(cur)) {
        seen.add(cur);
        cur = on[cur];
        depth++;
      }
      pos[b] = [homeX[cur] ?? homeX[b], depth];
    }
    return pos;
  };

  const frames: BlocksFrame[] = raws.map((r) => ({
    positions: layoutOf(r.on, r.held),
    on: r.on,
    held: r.held,
    action: r.action,
  }));
  // a held block hovers above its destination (its resting x in the next frame)
  for (let i = 0; i < frames.length; i++) {
    const held = frames[i].held;
    if (!held) continue;
    const destX = frames[i + 1]?.positions[held]?.[0] ?? homeX[held];
    frames[i].positions[held] = [destX, CARRY_Y];
  }

  return {
    blocks,
    frames,
    status: planner.getStatus(),
    trace,
    goalText: hard ? "12-block scramble → scramble" : "A·on·B·on·C",
    compare,
  };
}
