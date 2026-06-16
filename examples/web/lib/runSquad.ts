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
      { name: "ally", side: "ally", x: 4, z: 0, hp: 240 },
      { name: "player", side: "player", x: 7, z: 0, hp: 160 },
      { name: "E1", side: "enemy", x: -9, z: -2, hp: 60, role: "suppressor" },
      { name: "E2", side: "enemy", x: -9, z: 3, hp: 60, role: "flanker" },
    ],
    covers: [
      { name: "cN", x: 0, z: -4 },
      { name: "cS", x: 0, z: 4 },
      { name: "fN", x: -5, z: -7, flank: true },
      { name: "fS", x: -5, z: 7, flank: true },
      { name: "rally", x: 10, z: 0, rally: true },
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

/** The squad's current coordination state, as a short banner. */
export function squadTacticBanner(frame: SquadFrame): { label: string; hint: string } {
  const tactic = frame.squadTactic;
  if (tactic === "breach") return { label: "BREACH", hint: "stack on the door + breach inside the deadline window" };
  if (tactic === "flank") return { label: "FLANK", hint: frame.flankerReady ? "flanker in position — suppressor pushing up" : "one suppresses while the other swings wide" };
  return { label: "HOLD", hint: "engaging from cover" };
}

/** A plain-English caption of what's happening this frame — the live educator. */
export function squadNarration(frame: SquadFrame): string {
  const enemies = frame.units.filter((u) => u.side === "enemy");
  const friends = frame.units.filter((u) => u.side !== "enemy");
  if (enemies.length && enemies.every((u) => !u.alive)) return "✓ Enemies neutralized — the engagement is over.";
  if (friends.length && friends.every((u) => !u.alive)) return "✓ Target down — the squad cleared the area.";

  const ai = frame.units.filter((u) => u.side !== "player" && u.alive);
  const names = (verb: (a: string) => boolean) => ai.filter((u) => verb(u.action)).map((u) => u.name);
  const breaching = names((a) => a === "breaching" || a === "stacking on door");
  const suppressing = names((a) => a.startsWith("suppress"));
  const flanking = names((a) => a === "flanking");
  const firing = names((a) => a.startsWith("firing"));
  const moving = names((a) => a.includes("moving") || a.includes("high ground"));
  const fallingBack = names((a) => a === "falling back");

  if (breaching.length) return `${list(breaching)} stacking on the door — breaching in sync inside the deadline window.`;
  if (suppressing.length && flanking.length) return `${list(suppressing)} pins the target with covering fire while ${list(flanking)} swings to a flank — coordinated, not scripted.`;
  if (suppressing.length) return `${list(suppressing)} laying down suppressing fire to free up the flank.`;
  if (flanking.length) return `${list(flanking)} routing to a cover that can actually see the target — a flank the planner discovered.`;
  if (fallingBack.length) return `${list(fallingBack)} breaking contact and falling back on orders.`;
  if (moving.length && firing.length) return `${list(firing)} engaging while ${list(moving)} repositions for a better angle.`;
  if (firing.length) return `${list(firing)} engaging the target from cover.`;
  if (moving.length) return `${list(moving)} repositioning — no clean line of fire from here yet.`;
  return "Sizing up the engagement…";
}

function list(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} & ${xs[xs.length - 1]}`;
}

/** Per-scenario "what to watch for" — the unique thing each shows off. */
export function whatToWatch(id: SquadScenarioId): string[] {
  switch (id) {
    case "skirmish":
      return [
        "One NPC pins the target with covering fire while the other swings wide to a flank cover.",
        "The moment the flanker is set, the suppressor reactively stops and pushes — watch the AI Director plan change.",
        "Every move is the real planner's; the barks announce the tactic, F.E.A.R.-style.",
      ];
    case "blockedFlank":
      return [
        "The barricade blocks the direct line of fire (try selecting an NPC — its sight line turns red).",
        "Nobody scripted a route: the planner DISCOVERS it must reach a cover that can see the target.",
        "Compare with Skirmish (no wall) where they just shoot — proof this is search, not a script.",
      ];
    case "breach":
      return [
        "The fire-team stacks on the door, then breaches together.",
        "It happens inside a deadline window enforced INSIDE the planner's search (projected clock).",
        "Anyone who can't reach the door in time is pruned from the plan — temporal coordination.",
      ];
    case "companion":
      return [
        "Your ally fights on its own and never targets a friendly.",
        "Tap an order (Engage / Regroup / Hold fire) — it's routed through Planner.setGoals, not a state machine.",
        "Watch the ally's plan change in the AI Director the instant you give the order.",
      ];
  }
}
