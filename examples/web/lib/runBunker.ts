"use client";
/**
 * Bunker Heist run path for the web preview. Like lib/run.ts and lib/runBlocks.ts,
 * this drives the REAL htn-ai reactive Planner — here over the bunker-heist domain
 * with a single declarative goal (`hasStar`) — and snapshots the world after every
 * executed step. Nothing here plans; it observes the planner discovering the whole
 * key → C4 → breach → star chain by search and animates the result.
 */
import { Planner, goal, type TraceEvent } from "htn-ai";
import {
  bunkerModel,
  starGoal,
  breachGoal,
  c4Goal,
  N_,
  NODE_POS,
  type BunkerNode,
} from "@scenarios/bunker";

export type BunkerGoalId = "star" | "breach" | "c4";

/** The boolean world facts the HUD tracks as the mission progresses. */
export interface BunkerFlags {
  keyOnTable: boolean;
  hasKey: boolean;
  storageUnlocked: boolean;
  c4Available: boolean;
  hasC4: boolean;
  c4Placed: boolean;
  bunkerBreached: boolean;
  starPresent: boolean;
  hasStar: boolean;
}

export interface BunkerFrame {
  agentNode: BunkerNode;
  flags: BunkerFlags;
  /** the operator label that produced this frame ("start" for the initial one) */
  action: string;
}

export interface BunkerRun {
  goalId: BunkerGoalId;
  goalText: string;
  frames: BunkerFrame[];
  /** the ordered list of operators the planner DISCOVERED (the plan) */
  plan: string[];
  status: string;
  trace: TraceEvent[];
}

const FLAG_KEYS: (keyof BunkerFlags)[] = [
  "keyOnTable",
  "hasKey",
  "storageUnlocked",
  "c4Available",
  "hasC4",
  "c4Placed",
  "bunkerBreached",
  "starPresent",
  "hasStar",
];

const GOALS: Record<BunkerGoalId, { text: string; formula: () => ReturnType<typeof starGoal> }> = {
  star: { text: "hasStar", formula: starGoal },
  breach: { text: "bunkerBreached", formula: breachGoal },
  c4: { text: "hasC4", formula: c4Goal },
};

export function runBunker(goalId: BunkerGoalId = "star"): BunkerRun {
  const model = bunkerModel();
  const cfg = GOALS[goalId];

  const trace: TraceEvent[] = [];
  let t = 0;
  const planner = new Planner(model, {
    goals: [goal(cfg.formula())],
    now: () => t,
    seed: 1,
    trace: (e) => trace.push(e),
  });

  const snap = (action: string): BunkerFrame => {
    const flags = {} as BunkerFlags;
    for (const k of FLAG_KEYS) flags[k] = model.read(planner.state, k) as boolean;
    return {
      agentNode: (model.read(planner.state, "agentAt") as BunkerNode) ?? N_.COURTYARD,
      flags,
      action,
    };
  };

  const frames: BunkerFrame[] = [snap("start")];
  for (let i = 0; i < 2000; i++) {
    const status = planner.getStatus();
    if (status === "succeeded" || status === "failed") break;
    t += 1;
    const before = trace.length;
    planner.tick({ ms: 20 });
    const done = trace.slice(before).find((e) => e.t === "step.done");
    if (done && done.t === "step.done") frames.push(snap(done.label));
  }

  return {
    goalId,
    goalText: cfg.text,
    frames,
    plan: frames.slice(1).map((f) => f.action),
    status: planner.getStatus(),
    trace,
  };
}

/** Map an operator label to a position so the renderer can place the agent. */
export function nodePos(node: BunkerNode): [number, number, number] {
  return NODE_POS[node];
}

/** Human-friendly counts for the trace summary panel. */
export function traceSummaryFor(trace: TraceEvent[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of trace) counts.set(e.t, (counts.get(e.t) ?? 0) + 1);
  return [...counts.entries()].map(([label, count]) => ({ label, count }));
}

/** Human phase for the "now" readout, derived from the raw operator label. */
export function bunkerPhase(action: string, flags: BunkerFlags): { icon: string; text: string; color: string } {
  if (action.startsWith("goto")) {
    const carrying = flags.hasC4 ? " (carrying C4)" : flags.hasKey && !flags.storageUnlocked ? " (carrying key)" : "";
    return { icon: "→", text: `moving along the route${carrying}`, color: "#38bdf8" };
  }
  if (action.startsWith("pickup_key")) return { icon: "🔑", text: "picking up the key", color: "#fbbf24" };
  if (action.startsWith("unlock_storage")) return { icon: "🔓", text: "unlocking the storage door", color: "#a16207" };
  if (action.startsWith("pickup_c4")) return { icon: "🧨", text: "grabbing the C4 charge", color: "#f97316" };
  if (action.startsWith("place_c4")) return { icon: "📌", text: "planting C4 on the bunker door", color: "#f97316" };
  if (action.startsWith("detonate")) return { icon: "💥", text: "detonating from a safe distance", color: "#ef4444" };
  if (action.startsWith("pickup_star")) return { icon: "⭐", text: "collecting the star — mission complete", color: "#facc15" };
  if (action === "start") return { icon: "•", text: "planning the route from the goal", color: "var(--muted)" };
  return { icon: "✓", text: "done", color: "#34d399" };
}

/** Friendly one-line description of an operator label for the plan list. */
export function describeAction(label: string): string {
  if (label.startsWith("goto(")) {
    const inside = label.slice(5, -1).split(",");
    return `walk → ${prettyNode(inside[1] as BunkerNode)}`;
  }
  const map: Record<string, string> = {
    "pickup_key": "pick up the key",
    "unlock_storage": "unlock the storage door",
    "pickup_c4": "pick up the C4",
    "place_c4": "plant the C4 on the bunker",
    "detonate": "detonate (breach the bunker)",
    "pickup_star": "take the star",
  };
  const base = label.replace(/\(\)$/, "");
  return map[base] ?? label;
}

export function prettyNode(node: BunkerNode): string {
  const names: Record<BunkerNode, string> = {
    [N_.COURTYARD]: "courtyard",
    [N_.TABLE]: "key table",
    [N_.STORAGE_DOOR]: "storage door",
    [N_.STORAGE_INT]: "storage",
    [N_.C4_TABLE]: "C4 crate",
    [N_.BUNKER_DOOR]: "bunker door",
    [N_.BUNKER_INT]: "bunker",
    [N_.STAR]: "star",
    [N_.SAFE]: "safe spot",
  };
  return names[node] ?? node;
}
