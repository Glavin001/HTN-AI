"use client";
/**
 * Read-only "what is the unit seeing / thinking" layer for the 3D combat view.
 *
 * It does NOT re-implement any planning. It rebuilds the SAME geometry the planner
 * reasons over (a SquadWorld + the auto-generated tactical spot graph) from the
 * instance, snaps every actor to its position in the current frame, and then asks
 * the library's own primitives — losClear, inCoverVs, exposureAt, coverCountAt — the
 * exact questions the planner's costs are built from. That lets the scene overlay,
 * for a selected unit, the score/risk the planner assigns to each candidate position
 * (exposure, cover, line of fire, whole-engagement cost) and whether the unit itself
 * is currently shielded by a crate — i.e. it visualises the planner's spatial reasoning
 * rather than inventing a parallel one.
 */
import {
  SquadWorld,
  generateTacticalSpots,
  isSoftCover,
  ACC_MIN,
  BASE_ACCURACY,
  COVER_HIT_MULT,
  SHOT_DAMAGE,
  SIGHT_RANGE,
  W_EXPOSE,
  W_MOVE,
  type CoverSpec,
  type SquadFrame,
  type SquadInstance,
  type UnitFrame,
} from "@scenarios/squad-combat";

export interface ScoredSpot {
  name: string;
  x: number;
  z: number;
  /** named, drawn cover crate/anchor vs. an invisible auto-generated grid/edge spot */
  named: boolean;
  /** how many living enemies have a clear line of fire on this spot (the risk) */
  exposure: number;
  /** how many of those enemies a crate at this spot shields you from (the value) */
  cover: number;
  /** does this spot have a line of fire to the unit's current threat? */
  hasLos: boolean;
  /** straight-line distance the unit would travel to reach it */
  travel: number;
  /** whole-engagement cost the planner would pay to fight from here (lower = better);
   *  null when the spot has no line of fire (it is not a firing position) */
  cost: number | null;
  /** 0..1 desirability among the firing positions (1 = the cheapest place to fight) */
  desirability: number;
  /** the unit is standing here right now */
  current: boolean;
  /** the cheapest firing position (where the planner wants the unit to be) */
  best: boolean;
}

export interface UnitTactical {
  /** the unit's current believed primary threat (nearest living hostile), if any */
  threat: UnitFrame | null;
  /** has a clear line of fire to that threat right now */
  hasShot: boolean;
  /** how many enemies can shoot the unit where it stands now */
  exposure: number;
  /** how many enemies a crate currently shields the unit from */
  cover: number;
  /** the unit is tucked behind soft cover relative to its nearest threat */
  inCover: boolean;
  /** range (world units) to the nearest hostile */
  range: number | null;
}

export interface TacticalRead {
  spots: ScoredSpot[];
  unit: UnitTactical | null;
}

const HOSTILE: Record<string, string[]> = {
  enemy: ["player", "ally"],
  ally: ["enemy"],
  player: ["enemy"],
};

function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

/** Hit-chance falloff with range (mirrors the scenario's private rangeFalloff). */
function rangeFalloff(d: number): number {
  const t = Math.min(1, Math.max(0, d / SIGHT_RANGE));
  return BASE_ACCURACY + (ACC_MIN - BASE_ACCURACY) * t;
}

/** Build a SquadWorld for the instance (incl. the planner's auto tactical spots) and
 *  snap every actor + the door to the current frame. */
export function buildTacticalWorld(instance: SquadInstance, frame: SquadFrame): SquadWorld {
  const augmented: SquadInstance = { ...instance, covers: [...instance.covers, ...generateTacticalSpots(instance)] };
  const world = new SquadWorld(augmented);
  for (const u of frame.units) {
    const a = world.actors.get(u.name);
    if (!a) continue;
    a.x = u.x;
    a.z = u.z;
    a.hp = u.hp;
    a.alive = u.alive;
    a.cover = u.cover;
    a.elevation = u.elevation;
  }
  world.doorBroken = frame.doorBroken;
  return world;
}

/** The believed-foe positions a unit reasons about (its living hostiles). */
function hostilePositions(world: SquadWorld, side: string): { x: number; z: number }[] {
  return [...world.actors.values()].filter((a) => a.alive && (HOSTILE[side] ?? []).includes(a.side)).map((a) => ({ x: a.x, z: a.z }));
}

/** The nearest living hostile to a unit (its primary threat), preferring one in sight. */
function nearestHostileFrame(frame: SquadFrame, self: UnitFrame): UnitFrame | null {
  const hostiles = frame.units.filter((u) => u.alive && (HOSTILE[self.side] ?? []).includes(u.side));
  let best: UnitFrame | null = null;
  let bestD = Infinity;
  for (const h of hostiles) {
    const d = dist(self.x, self.z, h.x, h.z);
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

/** Read a single unit's current tactical posture (cover / exposure / range / shot). */
export function readUnit(world: SquadWorld, frame: SquadFrame, self: UnitFrame): UnitTactical {
  const foes = hostilePositions(world, self.side);
  const threat = nearestHostileFrame(frame, self);
  const hasShot =
    !!threat &&
    dist(self.x, self.z, threat.x, threat.z) <= SIGHT_RANGE &&
    world.losClear(self.x, self.z, threat.x, threat.z);
  const inCover = !!threat && world.inCoverVs(self.x, self.z, threat.x, threat.z);
  return {
    threat,
    hasShot,
    exposure: world.exposureAt(self.x, self.z, foes),
    cover: world.coverCountAt(self.x, self.z, foes),
    inCover,
    range: threat ? dist(self.x, self.z, threat.x, threat.z) : null,
  };
}

/**
 * Score every candidate position the planner could relocate to, from the selected
 * unit's point of view: its exposure (risk), the cover it grants, whether it has a
 * line of fire, and the whole-engagement cost of fighting from there. Mirrors the
 * scenario's spot-graph terminal cost so the overlay shows the planner's own ranking.
 */
export function scoreSpots(world: SquadWorld, instance: SquadInstance, self: UnitFrame, frame: SquadFrame): ScoredSpot[] {
  const foes = hostilePositions(world, self.side);
  const threat = nearestHostileFrame(frame, self);
  const namedNames = new Set(instance.covers.map((c) => c.name));
  const candidates: CoverSpec[] = world.covers.filter((c) => {
    const owner = world.coverOwner.get(c.name);
    return !owner || owner === self.name;
  });

  const out: ScoredSpot[] = candidates.map((c) => {
    const hasLos = !!threat && dist(c.x, c.z, threat.x, threat.z) <= SIGHT_RANGE && world.losClear(c.x, c.z, threat.x, threat.z);
    const exposure = world.exposureAt(c.x, c.z, foes);
    const cover = world.coverCountAt(c.x, c.z, foes);
    const travel = dist(self.x, self.z, c.x, c.z);
    let cost: number | null = null;
    if (hasLos && threat) {
      let hit = rangeFalloff(dist(c.x, c.z, threat.x, threat.z));
      if (world.inCoverVs(threat.x, threat.z, c.x, c.z)) hit *= COVER_HIT_MULT;
      const dmg = SHOT_DAMAGE * Math.max(0.12, hit);
      const shots = Math.max(1, Math.ceil(Math.max(1, threat.hp) / dmg));
      cost = W_MOVE * travel + shots * (1 + W_EXPOSE * exposure);
    }
    const here = c.x === self.x && c.z === self.z;
    return {
      name: c.name,
      x: c.x,
      z: c.z,
      named: namedNames.has(c.name),
      exposure,
      cover,
      hasLos,
      travel,
      cost,
      desirability: 0,
      current: here || c.name === self.cover,
      best: false,
    };
  });

  // normalise desirability across the firing positions (cheapest = 1) and flag the best
  const firing = out.filter((s) => s.cost != null);
  if (firing.length) {
    const costs = firing.map((s) => s.cost as number);
    const lo = Math.min(...costs);
    const hi = Math.max(...costs);
    for (const s of firing) s.desirability = hi > lo ? 1 - ((s.cost as number) - lo) / (hi - lo) : 1;
    let bestSpot = firing[0];
    for (const s of firing) if ((s.cost as number) < (bestSpot.cost as number)) bestSpot = s;
    bestSpot.best = true;
  }
  return out;
}

export function tacticalRead(instance: SquadInstance | null, frame: SquadFrame | null, selected: string | null): TacticalRead {
  if (!instance || !frame) return { spots: [], unit: null };
  const self = selected ? frame.units.find((u) => u.name === selected) : undefined;
  const world = buildTacticalWorld(instance, frame);
  if (!self || !self.alive) return { spots: [], unit: null };
  return { spots: scoreSpots(world, instance, self, frame), unit: readUnit(world, frame, self) };
}

/** Identify soft cover (a crate that blocks fire) vs. an open maneuver anchor. */
export function coverIsSoft(c: CoverSpec): boolean {
  return isSoftCover(c);
}
