"use client";
/**
 * Read-only helpers that turn the planner's own spatial cost into a plain-language
 * "position read" for the glass-box director. It does NOT re-implement planning: it
 * builds a geometry-only SquadWorld from the instance and calls the library's exported
 * `evaluateSpot` (the SAME risk/reward cost the planner's spot search optimises) over
 * the unit's BELIEF (what it knows) or ground TRUTH, for the unit's current position
 * and every candidate spot — so the panel text matches the 3D heat overlay.
 */
import {
  SquadWorld,
  evaluateSpot,
  type SpotEval,
  type SquadFrame,
  type SquadInstance,
  type UnitFrame,
} from "@scenarios/squad-combat";

const HOSTILE: Record<string, string[]> = {
  enemy: ["player", "ally"],
  ally: ["enemy"],
  player: ["enemy"],
};

function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

function nearestHostile(frame: SquadFrame, self: UnitFrame): UnitFrame | null {
  let best: UnitFrame | null = null;
  let bestD = Infinity;
  for (const h of frame.units) {
    if (!h.alive || !(HOSTILE[self.side] ?? []).includes(h.side)) continue;
    const d = dist(self.x, self.z, h.x, h.z);
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

export interface BestSpot {
  name: string;
  x: number;
  z: number;
  eval: SpotEval;
  travel: number;
}

export interface TacticalRead {
  /** the unit's risk/reward where it stands now (null when it knows of no threat) */
  here: SpotEval | null;
  /** how many enemies a crate currently shields the unit from */
  cover: number;
  /** range to the (believed or real) threat */
  range: number | null;
  /** the cheapest firing spot the unit could relocate to (among the candidate spots) */
  best: BestSpot | null;
  /** how many candidate spots are firing positions */
  firingCount: number;
}

/** Score the selected unit's current spot + every candidate spot against its belief
 *  ("what it knows") or ground truth, mirroring the planner's spot search cost. */
export function tacticalRead(
  instance: SquadInstance | null,
  frame: SquadFrame | null,
  spots: { name: string; x: number; z: number }[],
  selected: string | null,
  mode: "belief" | "truth" = "belief",
): TacticalRead | null {
  if (!instance || !frame) return null;
  const self = selected ? frame.units.find((u) => u.name === selected) : undefined;
  if (!self || !self.alive) return null;

  const truthThreat = nearestHostile(frame, self);
  const threat = mode === "belief" ? self.believedThreat : truthThreat ? { x: truthThreat.x, z: truthThreat.z } : null;
  if (!threat) return { here: null, cover: 0, range: null, best: null, firingCount: 0 };
  const foes =
    mode === "belief"
      ? self.believedFoes
      : frame.units.filter((u) => u.alive && (HOSTILE[self.side] ?? []).includes(u.side)).map((u) => ({ x: u.x, z: u.z }));

  const world = new SquadWorld(instance);
  const here = evaluateSpot(world, self.x, self.z, threat, foes);
  const cover = world.coverCountAt(self.x, self.z, foes);

  let best: BestSpot | null = null;
  let firingCount = 0;
  for (const s of spots) {
    const e = evaluateSpot(world, s.x, s.z, threat, foes);
    if (!e.firing) continue;
    firingCount++;
    if (!best || e.cost < best.eval.cost) best = { name: s.name, x: s.x, z: s.z, eval: e, travel: dist(self.x, self.z, s.x, s.z) };
  }
  return { here, cover, range: dist(self.x, self.z, threat.x, threat.z), best, firingCount };
}
