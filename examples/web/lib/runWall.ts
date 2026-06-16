"use client";
/**
 * Wall World run path for the web preview. Like lib/run.ts and lib/runBlocks.ts,
 * this drives the *real* htn-ai reactive Planner — here over the HTN `BuildWall`
 * task — and snapshots the world after each executed step. The goal is NOT a
 * position to stand at: it is a *structure*, a ring of cells that must each hold
 * a block. The planner decomposes that structure into per-slot pickup-and-place
 * sub-goals and we record the build, frame by frame.
 */
import { Planner, task, type TraceEvent } from "htn-ai";
import {
  WALL_SLOT_HEIGHT,
  wallInstance,
  wallModel,
  wallSources,
  type WallInstance,
} from "@scenarios/wall";

export interface WallCell {
  name: string;
  x: number;
  z: number;
}

export interface WallFrame {
  /** block count per cell (a wall slot is "laid" once this reaches WALL_SLOT_HEIGHT) */
  heights: Record<string, number>;
  agentCell: string;
  agentY: number;
  holding: boolean;
  /** label of the action that produced this frame ("start" for the initial one) */
  action: string;
  /** how many wall slots are laid in this frame */
  placed: number;
}

export interface WallRun {
  cells: WallCell[];
  /** the wall line — cells that must each end up holding a block */
  targets: string[];
  /** the cells that begin with a scattered block */
  sources: string[];
  /** the protected courtyard tile at the heart of the ring */
  core: string;
  frames: WallFrame[];
  status: string;
  trace: TraceEvent[];
  goalText: string;
}

const SLOT = WALL_SLOT_HEIGHT;

export function runWall(): WallRun {
  const inst: WallInstance = wallInstance();
  const model = wallModel(inst);
  const cellNames = inst.cells.map((c) => c.name);

  const trace: TraceEvent[] = [];
  let t = 0;
  const planner = new Planner(model, {
    goals: [task("BuildWall")],
    now: () => t,
    seed: 1,
    trace: (e) => trace.push(e),
  });

  const snap = (action: string): WallFrame => {
    const heights = Object.fromEntries(cellNames.map((c) => [c, model.read(planner.state, "height", c) as number]));
    const placed = inst.targets.reduce((n, c) => n + (heights[c] >= SLOT ? 1 : 0), 0);
    return {
      heights,
      agentCell: model.read(planner.state, "agentAt") as string,
      agentY: model.read(planner.state, "agentY") as number,
      holding: model.read(planner.state, "holding") as boolean,
      action,
      placed,
    };
  };

  const frames: WallFrame[] = [snap("start")];
  for (let i = 0; i < 4000; i++) {
    const status = planner.getStatus();
    if (status === "succeeded" || status === "failed") break;
    t += 1;
    const before = trace.length;
    planner.tick({ ms: 30 }); // generous budget; runs offline, not per animation frame
    const done = trace.slice(before).find((e) => e.t === "step.done");
    if (done && done.t === "step.done") frames.push(snap(done.label));
  }

  return {
    cells: inst.cells.map((c) => ({ name: c.name, x: c.x, z: c.z })),
    targets: inst.targets,
    sources: wallSources(inst),
    core: inst.core,
    frames,
    status: planner.getStatus(),
    trace,
    goalText: `enclose the courtyard — lay all ${inst.targets.length} wall slots`,
  };
}
