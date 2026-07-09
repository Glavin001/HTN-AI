"use client";
/**
 * Wall World run path for the web preview. Like lib/run.ts and lib/runBlocks.ts,
 * this drives the *real* htn-ai reactive Planner and snapshots the world after each
 * executed step. The goal is NOT a position to stand at: it is a *structure* — an
 * octagonal ring of cells that must each become two blocks tall.
 *
 * The wall is handed over as ONE declarative goal (`∧ height(cell) ≥ 2`); the
 * domain has only goto/grab/place, so the planner DISCOVERS pickup-and-place by
 * search. The Planner runs in `goalAgenda` mode, which splits the conjunction into
 * per-cell subgoals and commits to them one at a time — the standard fix for a
 * conjunction of independent sub-goals that would otherwise blow up one-shot.
 */
import { Planner, goal, type TraceEvent } from "htn-ai";
import { wallGoal, wallInstance, wallModel, type WallInstance } from "@scenarios/wall";

export interface WallCell {
  name: string;
  x: number;
  z: number;
}

export interface WallFrame {
  /** block count per cell (a slot is "laid" once this reaches wantHeight) */
  heights: Record<string, number>;
  agentCell: string;
  agentY: number;
  holding: boolean;
  /** label of the action that produced this frame ("start" for the initial one) */
  action: string;
  /** how many wall slots are fully laid (at wantHeight) in this frame */
  placed: number;
}

export interface WallRun {
  cells: WallCell[];
  /** the wall line — cells that must each be built to wantHeight */
  targets: string[];
  /** the cells that begin with a scattered block */
  sources: string[];
  /** the protected courtyard tile at the heart of the ring */
  core: string;
  /** how many blocks tall each wall slot must become */
  wantHeight: number;
  frames: WallFrame[];
  status: string;
  trace: TraceEvent[];
  goalText: string;
}

export function runWall(): WallRun {
  const inst: WallInstance = wallInstance();
  const model = wallModel(inst);
  const cellNames = inst.cells.map((c) => c.name);
  const want = inst.wantHeight;

  const trace: TraceEvent[] = [];
  let t = 0;
  const planner = new Planner(model, {
    // ONE declarative goal: "every wall cell ends up wantHeight tall". goalAgenda
    // splits that conjunction into per-cell subgoals and serialises them; the
    // planner discovers the goto/grab/place actions for each by search.
    goals: [goal(wallGoal(inst))],
    goalAgenda: true,
    weight: 3,
    maxNodes: 200_000,
    now: () => t,
    seed: 1,
    trace: (e) => trace.push(e),
  });

  const snap = (action: string): WallFrame => {
    const heights = Object.fromEntries(cellNames.map((c) => [c, model.read(planner.state, "height", c) as number]));
    const placed = inst.targets.reduce((n, c) => n + (heights[c] >= want ? 1 : 0), 0);
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
  for (let i = 0; i < 20000; i++) {
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
    sources: inst.sources,
    core: inst.core,
    wantHeight: want,
    frames,
    status: planner.getStatus(),
    trace,
    goalText: `enclose the courtyard — a ${inst.targets.length}-slot wall, ${want} blocks tall`,
  };
}
