"use client";
/**
 * Bridge between the htn-ai squad-combat scenario and the 3D view. We build the
 * shared SquadSim — TWO autonomous squads (Red vs Blue), each unit a real reactive
 * Planner with its OWN belief and no shared memory across teams — run it to a
 * terminal state, and capture a world snapshot after every step plus each unit's
 * live plan and trace. The scene scrubs through these frames: deterministic replay
 * of the whole skirmish (seed + fixed timestep). Nothing here re-implements planning.
 */
import { SquadSim, breachInstance, skirmishInstance, type SquadFrame, type SquadInstance, type TeamFrame } from "@scenarios/squad-combat";
import type { TraceEvent } from "htn-ai";

export type SquadScenarioId = "skirmish" | "blockedFlank" | "breach" | "companion";

export interface SquadRun {
  scenario: SquadScenarioId;
  instance: SquadInstance;
  frames: SquadFrame[];
  trace: { unit: string; e: TraceEvent }[];
  /** the AI unit names (both squads) for the director's unit picker */
  units: string[];
}

/** A central barricade blocks every direct shot — both squads must flank around it. */
function blockedFlankInstance(): SquadInstance {
  return {
    units: [
      { name: "R1", side: "enemy", x: -10, z: -1, role: "suppressor" },
      { name: "R2", side: "enemy", x: -10, z: 2, role: "flanker" },
      { name: "B1", side: "ally", x: 10, z: 1, role: "suppressor" },
      { name: "B2", side: "ally", x: 10, z: -2, role: "flanker" },
    ],
    covers: [
      { name: "cW", x: -5, z: 0 },
      { name: "cE", x: 5, z: 0 },
      { name: "fNW", x: -3, z: -8, flank: true },
      { name: "fSW", x: -3, z: 8, flank: true },
      { name: "fNE", x: 3, z: -8, flank: true },
      { name: "fSE", x: 3, z: 8, flank: true },
      { name: "rRally", x: -12, z: 0, rally: true },
      { name: "bRally", x: 12, z: 0, rally: true },
    ],
    walls: [{ x: -2, z: -5, w: 4, d: 10 }], // the only shots are around the flanks
  };
}

/** Your Blue squad (autonomous) vs a Red squad — you command one Blue unit. */
function companionInstance(): SquadInstance {
  return {
    units: [
      { name: "B1", side: "ally", x: 8, z: -1, role: "suppressor" },
      { name: "B2", side: "ally", x: 8, z: 2, role: "flanker" },
      { name: "R1", side: "enemy", x: -9, z: -1, role: "suppressor" },
      { name: "R2", side: "enemy", x: -9, z: 2, role: "flanker" },
    ],
    covers: [
      { name: "cW", x: -3, z: 0 },
      { name: "cE", x: 3, z: 0 },
      { name: "fNW", x: -2, z: -7, flank: true },
      { name: "fSW", x: -2, z: 7, flank: true },
      { name: "fNE", x: 2, z: -7, flank: true },
      { name: "fSE", x: 2, z: 7, flank: true },
      { name: "bRally", x: 11, z: 0, rally: true },
      { name: "rRally", x: -11, z: 0, rally: true },
    ],
  };
}

export function squadInstance(id: SquadScenarioId): SquadInstance {
  switch (id) {
    case "skirmish": return skirmishInstance();
    case "blockedFlank": return blockedFlankInstance();
    case "breach": return breachInstance();
    case "companion": return companionInstance();
  }
}

export interface SquadRunOptions {
  /** inject a player order to a Blue unit at a step (E2 commands, deterministic replay) */
  allyCommand?: { at: number; order: "engage" | "regroup" | "holdFire"; unit?: string };
  maxSteps?: number;
}

export function runSquad(id: SquadScenarioId, opts: SquadRunOptions = {}): SquadRun {
  const instance = squadInstance(id);
  const sim = new SquadSim(instance, { seed: 1 });
  const maxSteps = opts.maxSteps ?? 600;
  const frames: SquadFrame[] = [sim.snapshot()];
  for (let i = 0; i < maxSteps; i++) {
    if (opts.allyCommand && i === opts.allyCommand.at) sim.command(opts.allyCommand.unit ?? "B1", opts.allyCommand.order);
    frames.push(sim.step());
    if (sim.engagementOver()) break;
  }
  return { scenario: id, instance, frames, trace: sim.trace, units: sim.units.map((u) => u.name) };
}

/** Counts per trace event kind, for the summary panel. */
export function squadTraceSummary(trace: { unit: string; e: TraceEvent }[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const { e } of trace) counts.set(e.t, (counts.get(e.t) ?? 0) + 1);
  return [...counts.entries()].map(([label, count]) => ({ label, count }));
}

/** Display name + colour for a team (internal sides → Red / Blue). */
export function teamName(side: string): string {
  return side === "enemy" ? "Red" : "Blue";
}
export function teamColor(side: string): string {
  return side === "enemy" ? "#ef4444" : "#3b82f6";
}
export function teamHint(t: TeamFrame): string {
  if (t.tactic === "breach") return "breaching the room";
  if (t.tactic === "flank") return t.flankerReady ? "flanker set — pushing up" : "suppress + flank";
  return "holding";
}

/** A plain-English caption of what BOTH squads are doing this frame — the educator. */
export function squadNarration(frame: SquadFrame): string {
  const dead = frame.teams.filter((t) => t.alive === 0);
  if (dead.length) {
    const win = frame.teams.find((t) => t.alive > 0);
    return `✓ ${teamName(dead[0].side)} squad eliminated — ${win ? teamName(win.side) : "the other"} team holds the field.`;
  }
  return frame.teams
    .map((t) => `${teamName(t.side)} ${teamPhrase(frame.units.filter((u) => u.side === t.side && u.alive))}`)
    .join("  ·  ");
}

function teamPhrase(units: SquadFrame["units"]): string {
  const has = (p: (a: string) => boolean) => units.some((u) => p(u.action));
  if (has((a) => a === "breaching" || a === "stacking on door")) return "breaching the door";
  const sup = has((a) => a.startsWith("suppress"));
  const fl = has((a) => a === "flanking");
  if (sup && fl) return "pinning + flanking";
  if (sup) return "laying down suppressing fire";
  if (fl) return "swinging to a flank";
  if (has((a) => a.startsWith("firing"))) return "trading fire from cover";
  if (has((a) => a === "falling back")) return "falling back";
  if (has((a) => a.includes("moving"))) return "repositioning for an angle";
  if (has((a) => a === "reloading")) return "reloading";
  return "holding";
}

/** Per-scenario "what to watch for" — the unique thing each shows off. */
export function whatToWatch(id: SquadScenarioId): string[] {
  switch (id) {
    case "skirmish":
      return [
        "Two squads — Red and Blue — each plan from their OWN belief; neither can read the other's mind.",
        "Each side coordinates suppress-and-flank and reactively readjusts as it discovers the other's moves (watch the replan count climb).",
        "Select any unit to see its live plan + sight line (green = has a shot, red = blocked).",
      ];
    case "blockedFlank":
      return [
        "A central barricade blocks every direct shot — both squads must flank around it.",
        "Nobody scripted a route: each unit DISCOVERS a cover that can see the enemy (its red sight line turns green on arrival).",
        "Two teams contesting the same flanks → cover reservation + constant replanning.",
      ];
    case "breach":
      return [
        "A Red fire-team breaches a room a Blue team is holding.",
        "Red stacks and breaches together inside a deadline window enforced INSIDE the planner's search (projected clock).",
        "Then it's close-quarters — watch both sides' plans invalidate and readjust in real time.",
      ];
    case "companion":
      return [
        "This is YOUR Blue squad (fully autonomous) vs a Red squad — you don't move anyone.",
        "Issue an order to B1 (Engage / Regroup / Hold fire) — routed through Planner.setGoals, the LLM seam.",
        "Watch B1's plan change in the AI Director the instant you order it, and the replay diverge.",
      ];
  }
}
