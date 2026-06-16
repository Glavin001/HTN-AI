"use client";
/**
 * Bridge between the htn-ai squad-combat scenario and the 3D view. We build the
 * shared SquadSim, run the *real* reactive Planners (one per NPC) to a terminal
 * state, and capture a world snapshot after every step plus each unit's live plan
 * and trace. The scene then scrubs through these frames — deterministic replay of
 * the engagement (seed + fixed timestep), so the playback slider IS the glass-box
 * director's replay scrubber. Nothing here re-implements planning.
 */
import { SquadSim, breachInstance, skirmishInstance, type SquadFrame, type SquadInstance } from "@scenarios/squad-combat";
import type { TraceEvent } from "htn-ai";

export type SquadScenarioId = "skirmish" | "blockedFlank" | "breach" | "companion";

export interface SquadRun {
  scenario: SquadScenarioId;
  instance: SquadInstance;
  frames: SquadFrame[];
  trace: { unit: string; e: TraceEvent }[];
  /** the AI unit names (enemies + ally) for the director's unit picker */
  units: string[];
}

/** A wall forces the only line of fire to the flanks — the staircase emergence in combat. */
function blockedFlankInstance(): SquadInstance {
  return {
    units: [
      { name: "E1", side: "enemy", x: -9, z: -2, role: "suppressor" },
      { name: "E2", side: "enemy", x: -9, z: 2, role: "flanker" },
      { name: "player", side: "player", x: 9, z: 0 },
    ],
    covers: [
      { name: "cNear", x: -3, z: 0 }, // behind the barricade — no line of fire
      { name: "fN", x: 4, z: -7, flank: true }, // around the side — clear shot
      { name: "fS", x: 4, z: 7, flank: true },
      { name: "rally", x: -11, z: 0, rally: true },
    ],
    walls: [{ x: -1, z: -3, w: 2, d: 6 }], // a central barricade blocking the direct lane
  };
}

/** An allied companion fights beside the player against two enemies. */
function companionInstance(): SquadInstance {
  return {
    units: [
      { name: "ally", side: "ally", x: 2, z: 1 },
      { name: "player", side: "player", x: 2, z: -1 },
      { name: "E1", side: "enemy", x: -9, z: -2, role: "suppressor" },
      { name: "E2", side: "enemy", x: -9, z: 3, role: "flanker" },
    ],
    covers: [
      { name: "cN", x: -2, z: -4 },
      { name: "cS", x: -2, z: 4 },
      { name: "fN", x: -6, z: -7, flank: true },
      { name: "fS", x: -6, z: 7, flank: true },
      { name: "rally", x: 7, z: 0, rally: true },
    ],
    walls: [{ x: -1, z: -1.5, w: 1.5, d: 3 }],
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
  /** inject a player order to the ally at a given step (E2 commands, deterministic replay) */
  allyCommand?: { at: number; order: "engage" | "regroup" | "holdFire"; unit?: string };
  maxSteps?: number;
}

export function runSquad(id: SquadScenarioId, opts: SquadRunOptions = {}): SquadRun {
  const instance = squadInstance(id);
  const sim = new SquadSim(instance, { seed: 1 });
  const maxSteps = opts.maxSteps ?? 600;
  const frames: SquadFrame[] = [sim.snapshot()];
  for (let i = 0; i < maxSteps; i++) {
    if (opts.allyCommand && i === opts.allyCommand.at) {
      sim.command(opts.allyCommand.unit ?? "ally", opts.allyCommand.order);
    }
    frames.push(sim.step());
    if (sim.engagementOver()) break;
  }
  return {
    scenario: id,
    instance,
    frames,
    trace: sim.trace,
    units: sim.units.map((u) => u.name),
  };
}

/** Counts per trace event kind, for the summary panel. */
export function squadTraceSummary(trace: { unit: string; e: TraceEvent }[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const { e } of trace) counts.set(e.t, (counts.get(e.t) ?? 0) + 1);
  return [...counts.entries()].map(([label, count]) => ({ label, count }));
}
