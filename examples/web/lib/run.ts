"use client";
/**
 * The bridge between the htn-ai library and the 3D view. We build a model from
 * a shared scenario, drive the *real* reactive Planner tick-by-tick, and capture
 * a world snapshot after every executed step — plus the full TraceEvent stream.
 * The scene then animates through these frames. Nothing here re-implements
 * planning; it just observes the planner running in the browser.
 */
import { Planner, goal, type TraceEvent } from "htn-ai";
import {
  GOAL_HEIGHT,
  QUARRY_GOAL_HEIGHT,
  ledgeGoal,
  ledgeInstance,
  quarryGoal,
  quarryInstance,
  staircaseGoal,
  staircaseInstance,
  staircaseModel,
  type StaircaseInstance,
} from "@scenarios/staircase";

export type ScenarioId = "staircase" | "ledge" | "quarry";

export interface Frame {
  /** column heights per cell */
  heights: Record<string, number>;
  /** remaining supply per cell */
  supplies: Record<string, number>;
  agentCell: string;
  /** the agent's elevation — the ONLY thing the goal constrains (besides x,z) */
  agentY: number;
  holding: boolean;
  /** label of the action that produced this frame ("start" for the initial one) */
  action: string;
}

export interface RunResult {
  scenario: ScenarioId;
  instance: StaircaseInstance;
  /** the 3D coordinate the agent must reach (x,z from the cell, y = elevation) */
  target: { x: number; z: number; y: number; cell: string };
  frames: Frame[];
  status: string;
  trace: TraceEvent[];
}

const SCENARIOS: Record<ScenarioId, { instance: () => StaircaseInstance; goal: () => ReturnType<typeof staircaseGoal>; target: { cell: string; y: number } }> = {
  staircase: { instance: staircaseInstance, goal: staircaseGoal, target: { cell: "goal", y: GOAL_HEIGHT } },
  ledge: { instance: () => ledgeInstance(1), goal: ledgeGoal, target: { cell: "ledge", y: 2 } },
  quarry: { instance: quarryInstance, goal: quarryGoal, target: { cell: "pillar", y: QUARRY_GOAL_HEIGHT } },
};

export function runScenario(id: ScenarioId): RunResult {
  const cfg = SCENARIOS[id];
  const instance = cfg.instance();
  const model = staircaseModel(instance);

  const trace: TraceEvent[] = [];
  let t = 0;
  const planner = new Planner(model, {
    goals: [goal(cfg.goal())],
    now: () => t,
    seed: 1,
    trace: (e) => trace.push(e),
  });

  const cellNames = instance.cells.map((c) => c.name);
  const snap = (action: string): Frame => ({
    heights: Object.fromEntries(cellNames.map((c) => [c, model.read(planner.state, "height", c) as number])),
    supplies: Object.fromEntries(cellNames.map((c) => [c, model.read(planner.state, "supply", c) as number])),
    agentCell: model.read(planner.state, "agentAt") as string,
    agentY: model.read(planner.state, "agentY") as number,
    holding: model.read(planner.state, "holding") as boolean,
    action,
  });

  const frames: Frame[] = [snap("start")];

  for (let i = 0; i < 4000; i++) {
    const status = planner.getStatus();
    if (status === "succeeded" || status === "failed") break;
    t += 1;
    const before = trace.length;
    planner.tick({ ms: 30 }); // generous budget; this loop runs offline, not per-frame
    const done = trace.slice(before).find((e) => e.t === "step.done");
    if (done && done.t === "step.done") frames.push(snap(done.label));
  }

  const targetCell = instance.cells.find((c) => c.name === cfg.target.cell)!;
  return {
    scenario: id,
    instance,
    target: { x: targetCell.x, z: targetCell.z, y: cfg.target.y, cell: cfg.target.cell },
    frames,
    status: planner.getStatus(),
    trace,
  };
}

/** Human-friendly counts for the trace summary panel. */
export function traceSummary(trace: TraceEvent[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of trace) counts.set(e.t, (counts.get(e.t) ?? 0) + 1);
  return [...counts.entries()].map(([label, count]) => ({ label, count }));
}
