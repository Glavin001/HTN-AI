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
 * per-cell subgoals (and, in hard mode, threshold landmarks) and commits to them
 * one at a time.
 *
 * For the glass-box UI we also capture: the derived subgoal/landmark AGENDA, which
 * subgoal each executed step served, and per-subgoal/plan metrics.
 */
import { Planner, goal, printFormula, type GoalSpec, type TraceEvent } from "htn-ai";
import { wallGoal, wallInstance, wallInstanceHard, wallModel, type WallInstance } from "@scenarios/wall";

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
  /** the action's verb: goto | grab | place | start */
  verb: string;
  /** how many wall slots are fully laid (at wantHeight) in this frame */
  placed: number;
  /** index into `subgoals` of the agenda item this step served */
  goalIndex: number;
}

/** One item of the derived agenda — a per-cell subgoal or a threshold landmark. */
export interface WallSubgoal {
  /** human text, e.g. "height(c2_3) ≥ 1" */
  text: string;
  /** the cell it constrains, if any */
  cell: string | null;
  /** the target height (1 = base course, 2 = top course); 0 if not a threshold */
  level: number;
  /** number of executed steps that served this subgoal */
  steps: number;
}

export interface WallMetrics {
  /** agenda items (subgoals / landmarks) */
  subgoals: number;
  /** total executed actions in the realized plan */
  actions: number;
  /** how many distinct plans the planner built (one per subgoal + any repair) */
  plansBuilt: number;
  /** breakdown of executed actions by verb */
  verbs: { goto: number; grab: number; place: number };
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
  /** the derived subgoal / landmark agenda, in serialization order */
  subgoals: WallSubgoal[];
  metrics: WallMetrics;
  status: string;
  trace: TraceEvent[];
  goalText: string;
  /** realistic-physics mode: cells interfere, solved by landmark layering */
  hard: boolean;
}

const verbOf = (label: string): string => label.split("(")[0] || "start";

/** Parse a threshold-goal spec into {cell, level} for the agenda display. */
function describeGoal(g: GoalSpec): { text: string; cell: string | null; level: number } {
  if (g.kind !== "goal") return { text: g.name, cell: null, level: 0 };
  const cond = g.condition;
  let cell: string | null = null;
  let level = 0;
  if (cond.f === "cmp" && cond.a.n === "fluent" && cond.b.n === "const") {
    const arg = cond.a.args[0];
    if (arg && arg.t === "sym") cell = arg.name;
    level = cond.b.value;
  }
  return { text: printFormula(cond).replace(/>=/g, "≥"), cell, level };
}

/**
 * @param hard when true, use realistic physics (no reach-up) so the wall cells
 *   interfere — and switch the planner to `landmarks: true` so it lays the whole
 *   base course before any top course (per-cell serialization alone can't finish).
 */
export function runWall(hard = false): WallRun {
  const inst: WallInstance = hard ? wallInstanceHard() : wallInstance();
  const model = wallModel(inst);
  const cellNames = inst.cells.map((c) => c.name);
  const want = inst.wantHeight;

  const trace: TraceEvent[] = [];
  let t = 0;
  const planner = new Planner(model, {
    // ONE declarative goal: "every wall cell ends up wantHeight tall". goalAgenda
    // splits that conjunction into per-cell subgoals and serialises them; the
    // planner discovers the goto/grab/place actions for each by search. In hard
    // mode the cells interfere, so `landmarks` decomposes each cell's height goal
    // into ordered threshold landmarks (base course before top course).
    goals: [goal(wallGoal(inst))],
    goalAgenda: true,
    landmarks: hard,
    weight: 3,
    maxNodes: 200_000,
    now: () => t,
    seed: 1,
    trace: (e) => trace.push(e),
  });

  const subgoals: WallSubgoal[] = planner.agenda().map((g) => ({ ...describeGoal(g), steps: 0 }));

  const snap = (action: string, goalIndex: number): WallFrame => {
    const heights = Object.fromEntries(cellNames.map((c) => [c, model.read(planner.state, "height", c) as number]));
    const placed = inst.targets.reduce((n, c) => n + (heights[c] >= want ? 1 : 0), 0);
    return {
      heights,
      agentCell: model.read(planner.state, "agentAt") as string,
      agentY: model.read(planner.state, "agentY") as number,
      holding: model.read(planner.state, "holding") as boolean,
      action,
      verb: verbOf(action),
      placed,
      goalIndex,
    };
  };

  const frames: WallFrame[] = [snap("start", 0)];
  for (let i = 0; i < 20000; i++) {
    const status = planner.getStatus();
    if (status === "succeeded" || status === "failed") break;
    const gi = planner.activeGoalIndex(); // the subgoal being worked this tick
    t += 1;
    const before = trace.length;
    planner.tick({ ms: 30 }); // generous budget; runs offline, not per animation frame
    const done = trace.slice(before).find((e) => e.t === "step.done");
    if (done && done.t === "step.done") {
      if (subgoals[gi]) subgoals[gi].steps += 1;
      frames.push(snap(done.label, gi));
    }
  }

  const verbs = { goto: 0, grab: 0, place: 0 };
  for (const f of frames) if (f.verb in verbs) verbs[f.verb as keyof typeof verbs] += 1;

  return {
    cells: inst.cells.map((c) => ({ name: c.name, x: c.x, z: c.z })),
    targets: inst.targets,
    sources: inst.sources,
    core: inst.core,
    wantHeight: want,
    frames,
    subgoals,
    metrics: {
      subgoals: subgoals.length,
      actions: frames.length - 1,
      plansBuilt: trace.filter((e) => e.t === "plan.new").length,
      verbs,
    },
    status: planner.getStatus(),
    trace,
    goalText: `enclose the courtyard — a ${inst.targets.length}-slot wall, ${want} blocks tall`,
    hard,
  };
}
