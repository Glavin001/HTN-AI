"use client";
/**
 * Bridge between the htn-ai squad-combat scenario and the 3D view. We build the
 * shared SquadSim — TWO autonomous squads (Red vs Blue), each unit a real reactive
 * Planner with its OWN belief and no shared memory across teams — run it to a
 * terminal state, and capture a world snapshot after every step plus each unit's
 * live plan and trace. The scene scrubs through these frames: deterministic replay
 * of the whole skirmish (seed + fixed timestep). Nothing here re-implements planning.
 */
import {
  SquadSim,
  blockedFlankInstance,
  breachInstance,
  companionInstance,
  skirmishInstance,
  type SquadFrame,
  type SquadInstance,
  type TeamFrame,
} from "@scenarios/squad-combat";
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
  return "fighting from cover";
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
  if (has((a) => a === "breaching")) return "breaching the door";
  const firing = has((a) => a.startsWith("firing"));
  const moving = has((a) => a.includes("moving up"));
  if (firing && moving) return "pinning + flanking";
  if (firing) return "trading fire from cover";
  if (has((a) => a === "falling back")) return "falling back";
  if (moving) return "advancing under cover";
  if (has((a) => a === "reloading")) return "reloading";
  if (has((a) => a.includes("angle") || a.includes("reading the room"))) return "searching for an angle";
  return "holding";
}

/** Per-scenario "what to watch for" — the unique thing each shows off. */
export function whatToWatch(id: SquadScenarioId): string[] {
  switch (id) {
    case "skirmish":
      return [
        "There are NO waypoints — the play area is a fluid grid of cells (the faint dots). Each unit SEARCHES a multi-step route to a firing line.",
        "Select a unit: the bright dashed path is the covered approach its planner found — it weighs exposure against closing the distance, not a straight line.",
        "Each squad plans from its OWN belief and reactively re-routes as it discovers the other's moves (watch the replan count climb).",
      ];
    case "blockedFlank":
      return [
        "A central barricade blocks every direct shot — the only angles are around the ends.",
        "Nobody scripted a flank: each unit's GOAP search DERIVES the long way around to a cell that can see the enemy (its red sight line turns green on arrival).",
        "A greedy 'walk toward the enemy' would stall at the wall — the multi-step search is what gets them an angle.",
      ];
    case "breach":
      return [
        "A Red fire-team breaches a room a Blue team is holding.",
        "Red stacks and breaches together inside a deadline window enforced INSIDE the planner's search (projected clock).",
        "Then it's close-quarters — watch both sides' plans invalidate and re-route in real time.",
      ];
    case "companion":
      return [
        "This is YOUR Blue squad (fully autonomous) vs a Red squad — you don't move anyone.",
        "Issue an order to a Blue unit (Engage / Regroup / Hold fire) — routed through Planner.setGoals, the LLM seam.",
        "Watch the unit's plan + route change in the AI Director the instant you order it, on the LIVE sim.",
      ];
  }
}
