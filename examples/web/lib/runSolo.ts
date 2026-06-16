"use client";
/**
 * Bridge between the htn-ai SOLO-combat scenario and the 3D view. One reactive
 * Planner drives one NPC against scripted threats; we run it to a terminal state and
 * capture a frame after every step (deterministic replay: seed + fixed timestep). The
 * single-agent capabilities — emergent posture (cover / open / hip-fire), lookahead
 * over expected-HP cost, dynamic replanning on disruption, and data-only personality —
 * are all produced by the real planner; nothing here re-implements it. The behaviors
 * are pinned by automated assertions in tests/solo.ts; this file is a thin viz layer.
 */
import {
  AGGRESSIVE,
  DEFENSIVE,
  type Personality,
  type SoloFrame,
  type SoloInstance,
  type SoloRun,
  type SoloSimOptions,
  disruptionArena,
  lookaheadComparison,
  personalityArena,
  runSolo,
  steppingStoneArena,
} from "@scenarios/solo-combat";
import type { TraceEvent } from "htn-ai";

export type SoloScenarioId = "personality" | "lookahead" | "disruption" | "hipfire";
export type ProfileId = "aggressive" | "defensive";

export const PROFILES: Record<ProfileId, Personality> = { aggressive: AGGRESSIVE, defensive: DEFENSIVE };

// a gentler ACTUAL incoming damage keeps the replay watchable WITHOUT changing the
// planner's cost model (it still reasons with full damage), so the cover-seeking
// decisions on screen are exactly what the planner decided.
const WATCHABLE: Pick<SoloSimOptions, "threatDamageScale"> = { threatDamageScale: 0.5 };

interface SoloScenarioDef {
  name: string;
  blurb: string;
  build: () => SoloInstance;
  seed: number;
  /** whether the aggressive/defensive toggle is the point of this scenario */
  personalityToggle?: boolean;
  /** whether to show the greedy-vs-lookahead comparison panel */
  comparison?: boolean;
  opts?: (profile: Personality) => SoloSimOptions;
}

const DEFS: Record<SoloScenarioId, SoloScenarioDef> = {
  personality: {
    name: "★ Posture & personality",
    blurb: "Same arena, same code — only the personality data differs. AGGRESSIVE trades fire from the open; DEFENSIVE relocates to the crate. Toggle it below and watch the posture flip. The choice EMERGES from the expected-HP cost, not an if-table.",
    build: () => personalityArena(),
    seed: 1,
    personalityToggle: true,
    opts: (p) => ({ profile: p, ...WATCHABLE }),
  },
  lookahead: {
    name: "★ Lookahead beats greedy",
    blurb: "The NPC starts with a clear shot from the open. A GREEDY agent fires now; this one looks ahead over the WHOLE engagement and relocates to cover first — a fraction of the expected-HP cost. The panel shows both options' cost.",
    build: () => steppingStoneArena(),
    seed: 1,
    comparison: true,
    opts: (p) => ({ profile: p, ...WATCHABLE }),
  },
  disruption: {
    name: "★ Dynamic replan on disruption",
    blurb: "The NPC settles into cover and fires — then that crate is destroyed. Its cover vanishes (the heatmap behind it flips green→red, exposure jumps) and it reactively replans, never freezing.",
    build: () => disruptionArena(),
    seed: 2,
    opts: (p) => ({ profile: p, ...WATCHABLE, disruptAt: { whenCovered: true } }),
  },
  hipfire: {
    name: "Hip-fire / suppressed advance",
    blurb: "No cover anywhere and a distant threat: the only way to fight well is to CLOSE under fire. The 'advance' posture (hip-fire on the move) emerges — there's no cover to run to.",
    build: (): SoloInstance => ({
      units: [
        { name: "npc", side: "npc", x: 0, z: 0 },
        { name: "t", side: "threat", x: 0, z: 14, hp: 60 },
      ],
      covers: [],
    }),
    seed: 1,
    opts: (p) => ({ profile: p, ...WATCHABLE }),
  },
};

export function soloScenarioName(id: SoloScenarioId): string {
  return DEFS[id].name;
}
export function soloScenarioBlurb(id: SoloScenarioId): string {
  return DEFS[id].blurb;
}
export function soloHasPersonalityToggle(id: SoloScenarioId): boolean {
  return !!DEFS[id].personalityToggle;
}
export const SOLO_IDS = Object.keys(DEFS) as SoloScenarioId[];

export function runSoloScenario(id: SoloScenarioId, profile: ProfileId = "aggressive"): SoloRun {
  const def = DEFS[id];
  const p = PROFILES[profile];
  return { ...runSolo(def.build(), { seed: def.seed, ...(def.opts ? def.opts(p) : { profile: p }) }), scenario: id };
}

/** The greedy-vs-lookahead numbers for the scenario's comparison panel (or null). */
export function soloComparison(id: SoloScenarioId, profile: ProfileId): { greedy: { label: string; cost: number }; planner: { steps: string[]; cost: number } } | null {
  if (!DEFS[id].comparison) return null;
  return lookaheadComparison(DEFS[id].build(), PROFILES[profile]);
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
  if (frame.threats.every((t) => !t.alive)) return "✓ Threat neutralized.";
  const shield = n.exposure === 0 ? "shielded" : `exposed to ${n.exposure}`;
  return `NPC — ${n.action} · ${n.posture} · ${shield} · ${n.hp} HP`;
}

/** Per-scenario "what to watch for". */
export function soloWhatToWatch(id: SoloScenarioId): string[] {
  switch (id) {
    case "personality":
      return [
        "Toggle AGGRESSIVE ↔ DEFENSIVE below — the posture flips between fighting in the open and relocating to cover.",
        "Nothing in the code branches on personality: only the risk-aversion knob + a response curve (data) change.",
        "The floor heatmap shows where a threat has a clear shot (red) vs shielded (green).",
      ];
    case "lookahead":
      return [
        "A myopic/greedy agent shoots from where it stands (a clear shot now).",
        "This NPC reasons over the WHOLE firefight and relocates to cover first — see the cost panel: far cheaper in expected HP.",
        "That multi-step economics is the planner's A* summing operator costs, not a one-shot score.",
      ];
    case "disruption":
      return [
        "The NPC settles into cover and fires; then its crate is destroyed.",
        "Watch the crate disappear and the heatmap behind it flip green→red as its exposure jumps.",
        "It reactively replans (see the trace's step.fail / replan events) and keeps acting — no freeze.",
      ];
    case "hipfire":
      return [
        "There is no cover, and the threat is far — a static shot is weak and exposed.",
        "So the NPC CLOSES while firing (the 'advance' posture) to reach effective range.",
        "Hip-fire is less accurate, but closing the distance is the lowest expected-HP option here.",
      ];
  }
}
