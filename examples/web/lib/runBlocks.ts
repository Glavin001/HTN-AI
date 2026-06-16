"use client";
/**
 * Blocks World run path for the web preview. Like lib/run.ts, this drives the
 * real htn-ai Planner — here over the 4-op STRIPS blocks domain — and snapshots
 * the world after each executed step. It also precomputes a stable 3D layout per
 * frame (so the renderer stays dumb): each block sits in the column of its
 * stack's table-root, at a height equal to its depth; a held block hovers above
 * where it will land next.
 */
import { F, Planner, goal, type TraceEvent } from "htn-ai";
import { blocksModel, sussmanSetup } from "@scenarios/blocks";

export interface BlocksFrame {
  /** block name → [x, stackDepth] for rendering */
  positions: Record<string, [number, number]>;
  /** block name → ("table" | other block) for the HUD */
  on: Record<string, string>;
  held: string | null;
  action: string;
}

export interface BlocksRun {
  blocks: string[];
  frames: BlocksFrame[];
  status: string;
  trace: TraceEvent[];
  goalText: string;
}

const SPACING = 1.7;
const CARRY_Y = 4;
const HAND = "arm";

export function runBlocks(): BlocksRun {
  const setup = sussmanSetup(); // C on A; A,B on table — the Sussman anomaly
  const blocks = setup.blocks;
  const model = blocksModel(setup);

  const trace: TraceEvent[] = [];
  let t = 0;
  const planner = new Planner(model, {
    goals: [goal(F.and(F.lit("on", ["a"], "b"), F.lit("on", ["b"], "c")))],
    now: () => t,
    seed: 1,
    trace: (e) => trace.push(e),
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
  for (let i = 0; i < 500; i++) {
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

  return { blocks, frames, status: planner.getStatus(), trace, goalText: "A·on·B·on·C" };
}
