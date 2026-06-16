"use client";
/**
 * Bridge between the htn-ai SOLO-combat scenario and the 3D view. One reactive
 * Planner drives one NPC against scripted threats; we run it to a terminal state and
 * capture a frame after every step (deterministic replay: seed + fixed timestep). The
 * single-agent capabilities — emergent posture (cover / open / hip-fire), threat-aware
 * spatial reasoning, lookahead, dynamic replanning on disruption, and data-only
 * personality — are all produced by the real planner; nothing here re-implements it.
 */
import {
  AGGRESSIVE,
  DEFENSIVE,
  type Personality,
  type SoloFrame,
  type SoloInstance,
  type SoloRun,
  disruptionArena,
  navArena,
  postureArena,
  runSolo,
  steppingStoneArena,
} from "@scenarios/solo-combat";
import type { TraceEvent } from "htn-ai";

export type SoloScenarioId = "posture" | "lookahead" | "disruption" | "nav";
export type ProfileId = "aggressive" | "defensive";

export const PROFILES: Record<ProfileId, Personality> = { aggressive: AGGRESSIVE, defensive: DEFENSIVE };

interface SoloScenarioDef {
  name: string;
  blurb: string;
  build: () => SoloInstance;
  opts?: (profile: Personality) => Parameters<typeof runSolo>[1];
}

const DEFS: Record<SoloScenarioId, SoloScenarioDef> = {
  posture: {
    name: "★ Posture: cover / open / hip-fire",
    blurb: "One NPC, one threat, one crate. The posture EMERGES from cost + utility, not an if-table: it relocates to fight from cover when that's cheaper over the whole firefight.",
    build: () => postureArena(3, 10),
  },
  lookahead: {
    name: "★ Lookahead beats greedy",
    blurb: "The NPC starts with a clear shot from the open. A greedy agent fires now; this one looks ahead over the WHOLE engagement and relocates to cover first because it's far cheaper in expected HP.",
    build: () => steppingStoneArena(),
  },
  disruption: {
    name: "★ Dynamic replan on disruption",
    blurb: "The NPC commits to a covered firing spot — then it's destroyed mid-move. An invalidated precondition triggers a replan to a different spot, with no freeze (it keeps moving while it re-decides).",
    build: () => disruptionArena(),
    opts: (p) => ({ profile: p, disruptAt: { t: 1.6 } }),
  },
  nav: {
    name: "Threat-aware navigation",
    blurb: "Crossing to a firing position, the NPC routes by EXPECTED DAMAGE (the exposure integral over the spatial field), preferring a covered approach over the short exposed lane.",
    build: () => navArena(),
  },
};

export function soloScenarioName(id: SoloScenarioId): string {
  return DEFS[id].name;
}
export function soloScenarioBlurb(id: SoloScenarioId): string {
  return DEFS[id].blurb;
}
export const SOLO_IDS = Object.keys(DEFS) as SoloScenarioId[];

export function runSoloScenario(id: SoloScenarioId, profile: ProfileId = "aggressive"): SoloRun {
  const def = DEFS[id];
  const p = PROFILES[profile];
  const opts = def.opts ? def.opts(p) : { profile: p };
  return { ...runSolo(def.build(), { seed: 1, ...opts }), scenario: id };
}

/** Counts per trace event kind, for the summary panel (matches the squad helper shape). */
export function soloTraceSummary(trace: TraceEvent[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of trace) counts.set(e.t, (counts.get(e.t) ?? 0) + 1);
  return [...counts.entries()].map(([label, count]) => ({ label, count }));
}

/** A plain-English caption of what the NPC is doing this frame — the educator. */
export function soloNarration(frame: SoloFrame): string {
  const n = frame.npc;
  if (!n.alive) return "✗ The NPC was downed.";
  if (frame.threats.length === 0) return "✓ Threat neutralized.";
  const shield = n.exposure === 0 ? "shielded" : `exposed to ${n.exposure}`;
  return `NPC — ${n.action} · ${n.posture} · ${shield} · ${n.hp} HP`;
}

/** Per-scenario "what to watch for". */
export function soloWhatToWatch(id: SoloScenarioId): string[] {
  switch (id) {
    case "posture":
      return [
        "Watch the floor heatmap: red = a threat has a clear shot there, green = shielded.",
        "The NPC tucks beside the crate so the crate sits between it and the threat — exposure drops to 0 and it fires from cover.",
        "Toggle the personality: aggressive trades in the open more; defensive seeks cover sooner — same code, only data differs.",
      ];
    case "lookahead":
      return [
        "A myopic/greedy agent would shoot from where it stands (a clear shot now).",
        "This NPC reasons over the WHOLE firefight and relocates to cover first — lower expected-HP cost, even though it costs travel now.",
        "That multi-step economics is the planner's A* summing operator costs, not a one-shot score.",
      ];
    case "disruption":
      return [
        "The NPC commits to a covered spot, then it is destroyed mid-move (~1.6s).",
        "The invalidated precondition triggers a replan to a DIFFERENT spot — see the trace's step.fail / replan events.",
        "It never freezes: it keeps executing the stale step until the new plan lands.",
      ];
    case "nav":
      return [
        "The route minimizes EXPECTED DAMAGE (exposure integral), not Euclidean distance.",
        "It prefers a covered approach over the short exposed lane the threat overlooks.",
      ];
  }
}
