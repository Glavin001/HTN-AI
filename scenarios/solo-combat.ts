/**
 * Solo Combat — a single-agent F.E.A.R./Halo/Killzone-grade tactical scenario. One
 * reactive Planner drives one NPC against scripted threats in a dynamic, real-time,
 * 2.5D arena. NO squads, roles, teams, or coordination — the focus is *robust single
 * agent behavior*: emergent posture (cover / open / hip-fire), expected-HP costing,
 * IAUS-scored selection, a position-queryable spatial field, dynamic replanning on
 * disruption, multi-step lookahead that beats greedy, threat-aware navigation,
 * personality from data, and anti-dithering.
 *
 * Built entirely from existing engine seams (no core change):
 *   • belief fluents in the unit's ExecState = its working memory; perception writes
 *     them (dirty → fluent-precise reactive replan).
 *   • `planOnly` IR effects: planning simulates over belief; executors mutate the world.
 *   • method `utility` = an IAUS score (src/iaus); operator `cost` = expected-HP
 *     currency (src/combat-model) so weighted-A* lookahead sums multi-step economics.
 *   • a SpatialField (scenarios/lib/field) rebuilt once per perception from a threat
 *     snapshot, sampled at the PROJECTED myPos during planning — rollout-correct.
 */

import {
  type Consideration,
  type DomainDoc,
  type ExecutorApi,
  type ExtQuery,
  type Formula,
  type GoalSpec,
  type Model,
  type Planner as PlannerT,
  type ResponseCurve,
  type TaskStatus,
  type TraceEvent,
  type Rng,
  E,
  F,
  N,
  Planner,
  createModel,
  createRng,
  exchangeCost,
  scoreOption,
} from "../src/index";
import { type Box, type Foe, type Vec2, COVER_TOP, dist2, findPath, generateTacticalSpots, inCoverVs, losClear, walkPolyline } from "./lib/geometry";
import { type SpatialField, type ThreatSnapshot, buildField } from "./lib/field";

// ---------------------------------------------------------------- tunables

export const SHOT_DAMAGE = 24;
export const AMMO_MAX = 8;
export const MOVE_SPEED = 3.2;
export const SHOT_TIME = 0.32;
export const RELOAD_TIME = 1.6;
export const SIGHT_RANGE = 22;
export const MEMORY_SECONDS = 4;
export const IDEAL_RANGE = 12;
export const LOW_HP = 48;

export const BASE_ACCURACY = 0.96;
export const ACC_MIN = 0.42;
export const COVER_HIT_MULT = 0.28;
export const HIPFIRE_ACC = 0.45; // baseline hip-fire accuracy (a profile can raise it)
export const INCOMING_DAMAGE = 24;

export const COVER_HALF_W = 0.6;
export const COVER_HALF_D = 0.4;
export const COVER_REACH = 1.8;

export const W_MOVE = 0.35;
export const W_PATH = 0.8;
export const W_RANGE = 0.05;
export const SPOT_GRID = 4.2;
export const MAX_SPOTS = 22;
export const TRAVEL_MAX = 14; // travel-cost bookend for the IAUS "travel" consideration (→[0,1])
export const FIELD_CFG = { reach: COVER_REACH, sight: SIGHT_RANGE, integralStep: 1.0 };

/** belief fluents the tactical externals read — listed so a change dirties + replans */
const TACTICAL_READS = ["myPos", "myElev", "coverPos", "coverElev", "coverStandable", "threatPos", "threatHp", "caution", "currentPosture", "inertia"];

// ---------------------------------------------------------------- instance shapes

export interface UnitSpec {
  name: string;
  side: "npc" | "threat";
  x: number;
  z: number;
  elev?: number;
  hp?: number;
  ammo?: number;
}

export interface CoverSpec {
  name: string;
  x: number;
  z: number;
  /** elevation you STAND at when using this position (high ground) */
  elev?: number;
  /** elevated firing position (height advantage) */
  high?: boolean;
  /** fall-back / rally point */
  rally?: boolean;
  /** auto-generated tactical standing position (invisible) */
  spot?: boolean;
  /** dynamically destroyed / blocked mid-engagement (S2) */
  blocked?: boolean;
}

export interface WallSpec {
  x: number;
  z: number;
  w: number;
  d: number;
  height?: number;
  /** removed when destroyed (S2 disruption) */
  destructible?: boolean;
}

export interface SoloInstance {
  units: UnitSpec[];
  covers: CoverSpec[];
  walls?: WallSpec[];
}

/** A data-only behavior profile (C14-style authoring seam). NEVER branched on in logic. */
export interface Personality {
  name: string;
  /** the single risk-aversion knob → caution fluent (aggressive ~0.6, defensive ~1.8) */
  riskAversion: number;
  /** hip-fire confidence in [0,1]: scales advance-firing outgoing accuracy */
  hipFireConfidence?: number;
  /** anti-dither: cost discount for continuing the current posture */
  inertiaBonus?: number;
  /** IAUS response-curve overrides (data, not code) */
  curves?: { safety?: ResponseCurve; effectiveness?: ResponseCurve; travel?: ResponseCurve };
}

export const AGGRESSIVE: Personality = { name: "aggressive", riskAversion: 0.6, hipFireConfidence: 0.7, inertiaBonus: 0.15, curves: { safety: { kind: "linear", m: 0.6 } } };
export const DEFENSIVE: Personality = { name: "defensive", riskAversion: 1.9, hipFireConfidence: 0.3, inertiaBonus: 0.15, curves: { safety: { kind: "logistic", k: 10, x0: 0.4 } } };

// ---------------------------------------------------------------- ground-truth world

interface Actor {
  name: string;
  side: "npc" | "threat";
  x: number;
  z: number;
  elev: number;
  hp: number;
  ammo: number;
  alive: boolean;
  cover: string | null;
}

function coverFootprint(c: CoverSpec): Box {
  return { x: c.x - COVER_HALF_W, z: c.z - COVER_HALF_D, w: 2 * COVER_HALF_W, d: 2 * COVER_HALF_D, height: COVER_TOP };
}

/** a named cover is "soft cover" (a crate you fight beside) unless it's a maneuver anchor */
export function isSoftCover(c: CoverSpec): boolean {
  return !c.high && !c.rally && !c.spot;
}

export class SoloWorld {
  public clock = 0;
  public readonly actors = new Map<string, Actor>();
  public readonly covers: CoverSpec[];
  public readonly coverByName = new Map<string, CoverSpec>();
  public walls: WallSpec[];
  public readonly barks = new Map<string, string>();

  constructor(inst: SoloInstance) {
    this.covers = inst.covers;
    this.walls = inst.walls ?? [];
    for (const c of inst.covers) this.coverByName.set(c.name, c);
    for (const u of inst.units) {
      this.actors.set(u.name, {
        name: u.name,
        side: u.side,
        x: u.x,
        z: u.z,
        elev: u.elev ?? 0,
        hp: u.hp ?? 100,
        ammo: u.ammo ?? AMMO_MAX,
        alive: true,
        cover: null,
      });
    }
  }

  /** active obstacles (destroyed destructibles drop out) — for LOS + pathing */
  activeWalls(): Box[] {
    return this.walls.map((w) => ({ x: w.x, z: w.z, w: w.w, d: w.d, height: w.height }));
  }

  /** soft-cover footprints of every usable (not blocked) named crate */
  softCovers(): Box[] {
    return this.covers.filter((c) => isSoftCover(c) && !c.blocked).map(coverFootprint);
  }

  losClear(ax: number, az: number, bx: number, bz: number): boolean {
    return losClear(ax, az, bx, bz, this.activeWalls());
  }

  /** living actors hostile to `side` (i.e. the enemies of that side). */
  enemiesOf(side: "npc" | "threat"): Actor[] {
    const enemy = side === "npc" ? "threat" : "npc";
    return [...this.actors.values()].filter((a) => a.alive && a.side === enemy);
  }

  nearestThreat(self: string, requireLos: boolean): Actor | null {
    const me = this.actors.get(self);
    if (!me) return null;
    let best: Actor | null = null;
    let bestD = Infinity;
    for (const o of this.enemiesOf(me.side)) {
      const d = dist2(me.x, me.z, o.x, o.z);
      if (d > SIGHT_RANGE) continue;
      if (requireLos && !this.losClear(me.x, me.z, o.x, o.z)) continue;
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  /** probability a shot from shooter lands on target (range + the target's cover) */
  hitChance(shooter: Actor, target: Actor): number {
    const d = dist2(shooter.x, shooter.z, target.x, target.z);
    let p = rangeFalloff(d);
    if (inCoverVs(target.x, target.z, target.elev, shooter.x, shooter.z, shooter.elev, this.softCovers(), COVER_REACH)) p *= COVER_HIT_MULT;
    return Math.min(1, Math.max(0.02, p));
  }

  destroyCover(name: string): void {
    const c = this.coverByName.get(name);
    if (c) c.blocked = true;
  }

  destroyWall(pred: (w: WallSpec) => boolean): void {
    this.walls = this.walls.filter((w) => !(w.destructible && pred(w)));
  }
}

function rangeFalloff(d: number): number {
  const t = Math.min(1, Math.max(0, d / SIGHT_RANGE));
  return BASE_ACCURACY + (ACC_MIN - BASE_ACCURACY) * t;
}

/**
 * The whole-engagement expected-HP economics of fighting the believed threat from a
 * position — the single source of truth shared by the planner's `engageCost` external
 * AND the greedy baseline, so the comparison in the lookahead test is honest. Pure:
 * reads only the passed field (a per-replan snapshot) + scalars.
 */
function engagementNet(field: SpatialField, mx: number, mz: number, mElev: number, tx: number, tz: number, tElev: number, threatHp: number, caution: number): { net: number; reward: number; risk: number; shots: number } {
  const d = dist2(mx, mz, tx, tz);
  const pHit = rangeFalloff(d);
  const shots = Math.max(1, Math.ceil(threatHp / Math.max(1e-3, pHit * SHOT_DAMAGE)));
  const ha = Math.max(0, Math.min(1, (mElev - tElev) / 2));
  const ec = exchangeCost({
    outgoing: { pHit, damage: SHOT_DAMAGE },
    incoming: { pHit, damage: INCOMING_DAMAGE },
    exposedEnemies: field.exposureAt(mx, mz, mElev),
    shotsToResolve: shots,
    riskAversion: caution,
    heightAdvantage: ha,
  });
  return { net: ec.net, reward: ec.reward, risk: ec.risk, shots };
}

/** travel cost to a spot: distance + the threat-aware crossing exposure integral. */
function moveCostTo(field: SpatialField, mx: number, mz: number, mElev: number, cx: number, cz: number, tx: number, tz: number): number {
  return W_MOVE * dist2(mx, mz, cx, cz) + W_PATH * field.exposureIntegral(mx, mz, cx, cz, mElev) + W_RANGE * Math.max(0, dist2(cx, cz, tx, tz) - IDEAL_RANGE);
}

// ---------------------------------------------------------------- the domain (one POV)

export const soloDomain: DomainDoc = {
  name: "solo-combat",
  types: [{ name: "cover" }, { name: "foe" }],
  fluents: [
    { name: "myPos", kind: "vec2" },
    { name: "myElev", kind: "float", initial: 0 },
    { name: "myAmmo", kind: "int", initial: AMMO_MAX },
    { name: "myHp", kind: "float", initial: 100 },
    { name: "caution", kind: "float", initial: 1 },
    { name: "hipFire", kind: "float", initial: HIPFIRE_ACC },
    { name: "inertia", kind: "float", initial: 0 },
    // posture currently committed (anti-dither + telemetry)
    { name: "currentPosture", kind: "enum", values: ["none", "open", "cover", "advance"], initial: "none" },
    // threat belief (perception gates by LOS + memory)
    { name: "threatPos", kind: "vec2" },
    { name: "threatElev", kind: "float", initial: 0 },
    { name: "threatHp", kind: "float", initial: 100 },
    { name: "threatSeen", kind: "boolean", initial: false },
    { name: "hasThreat", kind: "boolean", initial: false },
    { name: "threatConfidence", kind: "float", initial: 0 },
    // per-foe belief (exposure = how many of THESE can shoot a spot)
    { name: "foePos", params: [{ name: "f", type: "foe" }], kind: "vec2" },
    { name: "foeElev", params: [{ name: "f", type: "foe" }], kind: "float", initial: 0 },
    { name: "foeAlive", params: [{ name: "f", type: "foe" }], kind: "boolean", initial: false },
    // cover descriptors (static, set at init)
    { name: "coverPos", params: [{ name: "c", type: "cover" }], kind: "vec2" },
    { name: "coverElev", params: [{ name: "c", type: "cover" }], kind: "float", initial: 0 },
    { name: "coverHigh", params: [{ name: "c", type: "cover" }], kind: "boolean", initial: false },
    { name: "coverRally", params: [{ name: "c", type: "cover" }], kind: "boolean", initial: false },
    // a position you STAND at to fire (a spot / anchor) — soft crates are NOT standable
    // (you fight from beside them, at a generated spot), so they're excluded as targets
    { name: "coverStandable", params: [{ name: "c", type: "cover" }], kind: "boolean", initial: false },
    // dynamic: a cover destroyed / blocked mid-engagement (S2)
    { name: "coverBlocked", params: [{ name: "c", type: "cover" }], kind: "boolean", initial: false },
  ],
  compounds: [{ name: "Fight" }, { name: "Neutralize" }],
  operators: [
    {
      // relocate to a tactical firing spot (cover edge, grid point, or named cover).
      // COST carries the positional trade-off (travel + danger of crossing) so A*
      // composes multi-step plans a greedy one-hop score would miss (stepping stone).
      name: "moveToSpot",
      params: [{ name: "c", type: "cover" }],
      pre: F.and(F.lit("coverStandable", ["?c"]), F.not(F.lit("coverBlocked", ["?c"])), F.ext("spotUseful", ["?c"], TACTICAL_READS)),
      // abort the instant the spot is destroyed or stops being useful (a disruption,
      // a threat moving) — and don't keep crossing open ground once you have a shot
      verify: F.and(F.not(F.lit("coverBlocked", ["?c"])), F.ext("spotUseful", ["?c"], TACTICAL_READS)),
      eff: [
        E.setVec("myPos", [], N.ext("coverX", ["?c"], ["coverPos"]), N.ext("coverZ", ["?c"], ["coverPos"]), undefined, "planOnly"),
        E.set("myElev", [], N.fl("coverElev", "?c"), "planOnly"),
      ],
      cost: N.add(
        N.add(N.mul(N.dist("myPos", [], "coverPos", ["?c"]), N.c(W_MOVE)), N.mul(N.ext("pathExposure", ["?c"], TACTICAL_READS), N.c(W_PATH))),
        N.add(N.mul(N.ext("spotRange", ["?c"], TACTICAL_READS), N.c(W_RANGE)), N.ext("switchCost", [], ["currentPosture", "inertia"])),
      ),
      duration: N.div(N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.1)), N.c(MOVE_SPEED)),
      executor: "move",
    },
    {
      // climb to elevated cover — high ground (2.5D advantage flows through engageCost)
      name: "climbTo",
      params: [{ name: "c", type: "cover" }],
      pre: F.and(F.lit("coverHigh", ["?c"]), F.not(F.lit("coverBlocked", ["?c"]))),
      verify: F.not(F.lit("coverBlocked", ["?c"])),
      eff: [
        E.setVec("myPos", [], N.ext("coverX", ["?c"], ["coverPos"]), N.ext("coverZ", ["?c"], ["coverPos"]), undefined, "planOnly"),
        E.set("myElev", [], N.fl("coverElev", "?c"), "planOnly"),
      ],
      cost: N.add(N.mul(N.dist("myPos", [], "coverPos", ["?c"]), N.c(W_MOVE)), N.c(0.6)),
      duration: N.div(N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.6)), N.c(MOVE_SPEED)),
      executor: "move",
    },
    {
      // fall back to a rally point when hurt
      name: "retreatTo",
      params: [{ name: "c", type: "cover" }],
      pre: F.and(F.lit("coverRally", ["?c"]), F.not(F.lit("coverBlocked", ["?c"]))),
      verify: F.not(F.lit("coverBlocked", ["?c"])),
      eff: [E.setVec("myPos", [], N.ext("coverX", ["?c"], ["coverPos"]), N.ext("coverZ", ["?c"], ["coverPos"]), undefined, "planOnly")],
      cost: N.add(N.mul(N.dist("myPos", [], "coverPos", ["?c"]), N.c(W_MOVE)), N.c(0.1)),
      duration: N.div(N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.1)), N.c(MOVE_SPEED)),
      executor: "move",
    },
    {
      // hip-fire while closing the distance to effective range (the SuppressedAdvance
      // posture). Reduced outgoing accuracy, but it advances range AND denies a clean
      // shot — wins when there is no safe cover and you must close.
      name: "advanceFiring",
      pre: F.and(F.lit("hasThreat"), F.ext("canSee", [], ["myPos", "threatPos"]), F.gt(N.dist("myPos", [], "threatPos", []), N.c(IDEAL_RANGE + 0.5))),
      verify: F.ext("canSee", [], ["myPos", "threatPos"]),
      eff: [
        E.setVec("myPos", [], N.ext("advanceX", [], ["myPos", "threatPos"]), N.ext("advanceZ", [], ["myPos", "threatPos"]), undefined, "planOnly"),
        E.dec("threatHp", [], N.ext("hipFireDamage", [], ["myPos", "threatPos", "hipFire"]), "planOnly"),
      ],
      cost: N.ext("advanceCost", [], ["myPos", "threatPos", "caution", "hipFire", "currentPosture", "inertia"]),
      duration: N.c(1.0),
      executor: "advance",
    },
    {
      // ENGAGE FROM HERE — fight the threat to the finish from the current position.
      // planning COST is the whole engagement (shots-to-kill × per-shot exposure of
      // THIS spot, in expected-HP currency), so A* compares "engage from the open"
      // against "move to cover then engage" over the full firefight.
      name: "engageFrom",
      pre: F.and(F.lit("hasThreat"), F.ext("canSee", [], ["myPos", "threatPos"]), F.gt(N.fl("threatHp"), N.c(0))),
      verify: F.ext("canSee", [], ["myPos", "threatPos"]),
      eff: [E.set("threatHp", [], N.c(0), "planOnly")],
      cost: N.ext("engageCost", [], ["myPos", "myElev", "threatPos", "threatElev", "threatHp", "caution"]),
      duration: N.ext("engageDur", [], ["myPos", "threatPos", "threatHp"]),
      executor: "engage",
    },
    {
      name: "reload",
      pre: F.lt(N.fl("myAmmo"), N.c(AMMO_MAX)),
      eff: [E.set("myAmmo", [], N.c(AMMO_MAX), "planOnly")],
      cost: 2,
      duration: RELOAD_TIME,
      executor: "reload",
    },
  ],
  methods: [
    // hurt → fall back to the nearest rally point
    {
      name: "retreat",
      task: "Fight",
      params: [{ name: "r", type: "cover" }],
      pre: F.and(F.lt(N.fl("myHp"), N.c(LOW_HP)), F.lit("coverRally", ["?r"]), F.not(F.lit("coverBlocked", ["?r"]))),
      utility: N.sub(N.c(0), N.dist("myPos", [], "coverPos", ["?r"])),
      subtasks: [{ do: "retreatTo", args: ["?r"] }, { do: "Neutralize" }],
    },
    // no threat fix → stand by in short beats (reactively wakes on contact)
    { name: "idle", task: "Fight", pre: F.not(F.lit("hasThreat")), subtasks: [{ hold: 0.5 }] },
    // default → neutralize the threat
    { name: "assault", task: "Fight", pre: F.lit("hasThreat"), subtasks: [{ do: "Neutralize" }] },

    // --- Neutralize: the three postures, ranked by an IAUS score (higher wins).
    //     The posture EMERGES from the score, not from an if-table.
    {
      // ShootInOpen / shoot-from-here
      name: "engageHere",
      task: "Neutralize",
      pre: F.and(F.lit("hasThreat"), F.ext("canSee", [], ["myPos", "threatPos"]), F.gt(N.fl("threatHp"), N.c(0))),
      utility: N.ext("iausEngageHere", [], ["myPos", "myElev", "threatPos", "threatElev", "threatHp", "caution", "currentPosture", "inertia"]),
      subtasks: [{ do: "engageFrom" }],
    },
    {
      // RunToCoverThenShoot
      name: "repositionEngage",
      task: "Neutralize",
      params: [{ name: "c", type: "cover" }],
      pre: F.and(F.lit("hasThreat"), F.not(F.lit("coverBlocked", ["?c"])), F.ext("spotUseful", ["?c"], TACTICAL_READS)),
      utility: N.ext("iausReposition", ["?c"], [...TACTICAL_READS, "threatElev", "threatHp"]),
      subtasks: [{ do: "moveToSpot", args: ["?c"] }, { do: "engageFrom" }],
    },
    {
      // SuppressedAdvance (hip-fire while closing)
      name: "pushAndEngage",
      task: "Neutralize",
      pre: F.and(F.lit("hasThreat"), F.ext("canSee", [], ["myPos", "threatPos"]), F.gt(N.dist("myPos", [], "threatPos", []), N.c(IDEAL_RANGE + 0.5))),
      utility: N.ext("iausAdvance", [], ["myPos", "threatPos", "threatHp", "caution", "hipFire", "currentPosture", "inertia"]),
      subtasks: [{ do: "advanceFiring" }, { do: "Neutralize" }],
    },
    // there's a threat but no firing solution right now → hold ready (reactively wakes)
    { name: "holdReady", task: "Neutralize", pre: F.lit("hasThreat"), subtasks: [{ hold: 0.4 }] },
  ],
};

// ---------------------------------------------------------------- belief reads

function believedFoes(q: ExtQuery, foes: string[]): Foe[] {
  const out: Foe[] = [];
  for (const f of foes) {
    if (q.get("foeAlive", f) < 0.5) continue;
    const p = q.vec("foePos", f);
    out.push({ x: p[0], z: p[1], elev: q.get("foeElev", f) });
  }
  return out;
}

function spotHasLos(world: SoloWorld, x: number, z: number, t: number[]): boolean {
  if (x === t[0] && z === t[1]) return false;
  return world.losClear(x, z, t[0], t[1]) && dist2(x, z, t[0], t[1]) <= SIGHT_RANGE;
}

/** projected myPos after advancing toward the threat to effective range (along LOS). */
function advancePoint(m: number[], t: number[]): Vec2 {
  const d = dist2(m[0], m[1], t[0], t[1]);
  if (d <= IDEAL_RANGE) return { x: m[0], z: m[1] };
  const k = (d - IDEAL_RANGE) / d;
  return { x: m[0] + (t[0] - m[0]) * k, z: m[1] + (t[1] - m[1]) * k };
}

// ---------------------------------------------------------------- per-unit model

/** A mutable holder the registry closes over: the spatial field, rebuilt each
 *  perception (once per replan), plus telemetry sinks. Externals read `ctx.field`,
 *  never the live world — the rollout-correctness guarantee. */
export interface SoloCtx {
  field: SpatialField;
  fieldBuilds: number;
  /** cost-decomposition + sampled-position records (C17 / rollout-correctness) */
  costTrace: { op: string; net: number; reward: number; risk: number; sampledMyPos: [number, number] }[];
  debug: boolean;
}

function curveOr(c: ResponseCurve | undefined, dflt: ResponseCurve): ResponseCurve {
  return c ?? dflt;
}

export function buildSoloModel(self: string, world: SoloWorld, inst: SoloInstance, profile: Personality, ctx: SoloCtx): Model {
  const entities: Record<string, string> = {};
  for (const c of inst.covers) entities[c.name] = "cover";
  // include ALL hostile names (alive or not) so belief can track each individually
  const allFoes = [...world.actors.values()].filter((a) => a.side !== world.actors.get(self)!.side).map((a) => a.name);
  for (const f of allFoes) entities[f] = "foe";

  const safetyCurve = curveOr(profile.curves?.safety, { kind: "linear" });
  const effCurve = curveOr(profile.curves?.effectiveness, { kind: "linear" });
  const travelCurve = curveOr(profile.curves?.travel, { kind: "linear" });

  // --- expected-HP economics of fighting from (mx,mz,mElev), reading PROJECTED state ---
  function engageNet(q: ExtQuery, mx: number, mz: number, mElev: number): { net: number; reward: number; risk: number; shots: number } {
    const t = q.vec("threatPos");
    const r = engagementNet(ctx.field, mx, mz, mElev, t[0], t[1], q.get("threatElev"), q.get("threatHp"), q.get("caution"));
    if (ctx.debug) ctx.costTrace.push({ op: "engage", net: r.net, reward: r.reward, risk: r.risk, sampledMyPos: [mx, mz] });
    return r;
  }

  // IAUS considerations for a candidate firing position. Inputs come from the
  // PROJECTED state via `q` and the per-replan field — so they are rollout-correct.
  interface SpotCtx { safety01: number; effectiveness01: number; travel01: number; }
  const considerations: Consideration<SpotCtx>[] = [
    { name: "safety", read: (c) => c.safety01, normalize: (r) => r, curve: safetyCurve },
    { name: "effectiveness", read: (c) => c.effectiveness01, normalize: (r) => r, curve: effCurve },
    { name: "travel", read: (c) => c.travel01, normalize: (r) => r, curve: travelCurve },
  ];

  // normalize the expected-HP terms into [0,1] considerations. Bookends are wide so
  // the curves don't saturate — that's what lets posture DIFFERENTIATE (a saturating
  // safety made cover always win regardless of threat/distance).
  // risk = expected HP/beat; weighted by the risk-aversion knob (caution) so a
  // cautious profile perceives the SAME exposure as more dangerous → seeks cover
  // sooner. This is the single lever that makes personality change behavior (data only).
  function safetyFromRisk(risk: number, caution: number): number {
    return Math.max(0, 1 - Math.min(1, (caution * risk) / INCOMING_DAMAGE));
  }
  function effFromReward(reward: number): number {
    return Math.max(0, Math.min(1, reward / SHOT_DAMAGE)); // reward = expected HP dealt/shot
  }
  function travelFrom(travelCost: number): number {
    return Math.max(0, 1 - Math.min(1, travelCost / TRAVEL_MAX));
  }

  return createModel(
    soloDomain,
    {
      entities,
      init: (w) => {
        for (const c of inst.covers) {
          w.set("coverPos", [c.name], [c.x, c.z]);
          if (c.elev) w.set("coverElev", [c.name], c.elev);
          if (c.high) w.set("coverHigh", [c.name], true);
          if (c.rally) w.set("coverRally", [c.name], true);
          if (!isSoftCover(c)) w.set("coverStandable", [c.name], true); // spots/anchors are standable; crates are not
        }
        const me = world.actors.get(self);
        if (me) {
          w.set("myPos", [], [me.x, me.z]);
          w.set("myElev", [], me.elev);
          w.set("myHp", [], me.hp);
          w.set("myAmmo", [], me.ammo);
        }
        w.set("caution", [], profile.riskAversion);
        w.set("hipFire", [], profile.hipFireConfidence ?? HIPFIRE_ACC);
        w.set("inertia", [], profile.inertiaBonus ?? 0);
      },
    },
    {
      predicates: {
        canSee: (q) => {
          const m = q.vec("myPos");
          const t = q.vec("threatPos");
          if (m[0] === t[0] && m[1] === t[1]) return false;
          return world.losClear(m[0], m[1], t[0], t[1]) && dist2(m[0], m[1], t[0], t[1]) <= SIGHT_RANGE;
        },
        // a candidate must be a firing position AND a genuine improvement (LOS we
        // lack, safer, or closer) — strict progress so the search terminates and the
        // stepping-stone (a spot only useful AFTER reaching an intermediate) emerges.
        spotUseful: (q) => {
          if (q.get("coverStandable", q.args[0]) < 0.5) return false; // you fight beside crates, not on them
          const c = q.vec("coverPos", q.args[0]);
          const m = q.vec("myPos");
          const t = q.vec("threatPos");
          if (t[0] === 0 && t[1] === 0) return false;
          if (dist2(c[0], c[1], m[0], m[1]) < 0.4) return false; // already here
          if (!spotHasLos(world, c[0], c[1], t)) return false;
          const fb = believedFoes(q, allFoes);
          const cElev = q.get("coverElev", q.args[0]);
          const meSeen = spotHasLos(world, m[0], m[1], t);
          if (!meSeen) return true; // no shot now → any firing position is progress
          const expC = world_exposure(c[0], c[1], cElev, fb, world);
          const expMe = world_exposure(m[0], m[1], q.get("myElev"), fb, world);
          if (expC < expMe) return true; // safer firing position
          const closer = dist2(c[0], c[1], t[0], t[1]) < dist2(m[0], m[1], t[0], t[1]) - 2;
          return expC === expMe && closer; // better range at no extra risk
        },
      },
      numerics: {
        coverX: (q) => q.vec("coverPos", q.args[0])[0],
        coverZ: (q) => q.vec("coverPos", q.args[0])[1],
        // danger of crossing to a spot — the exposure INTEGRAL along the approach
        pathExposure: (q) => {
          const m = q.vec("myPos");
          const c = q.vec("coverPos", q.args[0]);
          return ctx.field.exposureIntegral(m[0], m[1], c[0], c[1], q.get("myElev"));
        },
        spotRange: (q) => {
          const c = q.vec("coverPos", q.args[0]);
          const t = q.vec("threatPos");
          return Math.max(0, dist2(c[0], c[1], t[0], t[1]) - IDEAL_RANGE);
        },
        // anti-dither: changing posture costs `inertia`; continuing is free
        switchCost: (q) => (q.get("currentPosture") === enumIdx("cover") ? 0 : q.get("inertia")),
        // whole-engagement expected-HP cost from the current (projected) position
        engageCost: (q) => {
          const m = q.vec("myPos");
          return engageNet(q, m[0], m[1], q.get("myElev")).net;
        },
        engageDur: (q) => {
          const m = q.vec("myPos");
          const t = q.vec("threatPos");
          const dmg = SHOT_DAMAGE * Math.max(0.12, rangeFalloff(dist2(m[0], m[1], t[0], t[1])));
          return Math.max(1, Math.ceil(q.get("threatHp") / dmg)) * SHOT_TIME;
        },
        // --- advance (hip-fire) projections + cost ---
        advanceX: (q) => advancePoint(q.vec("myPos"), q.vec("threatPos")).x,
        advanceZ: (q) => advancePoint(q.vec("myPos"), q.vec("threatPos")).z,
        hipFireDamage: (q) => {
          const m = q.vec("myPos");
          const t = q.vec("threatPos");
          return SHOT_DAMAGE * q.get("hipFire") * Math.max(0.3, rangeFalloff(dist2(m[0], m[1], t[0], t[1])));
        },
        advanceCost: (q) => {
          const m = q.vec("myPos");
          const t = q.vec("threatPos");
          const dest = advancePoint(m, t);
          const cross = ctx.field.exposureIntegral(m[0], m[1], dest.x, dest.z, q.get("myElev"));
          // advancing under fire: travel + a discounted crossing exposure (you're
          // suppressing) + a small fixed beat. Cheap when closing unlocks a good shot.
          const sc = q.get("currentPosture") === enumIdx("advance") ? 0 : q.get("inertia");
          return W_MOVE * dist2(m[0], m[1], dest.x, dest.z) + W_PATH * 0.5 * cross + 1.0 + sc;
        },
        // --- IAUS utilities (the scalar the planner's method `utility` seam consumes).
        //     Each posture is scored on the SAME three axes (safety, effectiveness,
        //     travel) so the winner is whichever balances them best from data — the
        //     posture emerges, it isn't branched on. ---
        iausEngageHere: (q) => {
          const m = q.vec("myPos");
          const { reward, risk } = engageNet(q, m[0], m[1], q.get("myElev"));
          const s = scoreOption({}, { safety01: safetyFromRisk(risk, q.get("caution")), effectiveness01: effFromReward(reward), travel01: 1 }, considerations).score;
          return s - (q.get("currentPosture") === enumIdx("open") ? 0 : q.get("inertia"));
        },
        iausReposition: (q) => {
          const c = q.vec("coverPos", q.args[0]);
          const m = q.vec("myPos");
          const cElev = q.get("coverElev", q.args[0]);
          const { reward, risk } = engageNet(q, c[0], c[1], cElev);
          const travelDist = W_MOVE * dist2(m[0], m[1], c[0], c[1]) + W_PATH * ctx.field.exposureIntegral(m[0], m[1], c[0], c[1], q.get("myElev"));
          const s = scoreOption({}, { safety01: safetyFromRisk(risk, q.get("caution")), effectiveness01: effFromReward(reward), travel01: travelFrom(travelDist) }, considerations).score;
          return s - (q.get("currentPosture") === enumIdx("cover") ? 0 : q.get("inertia"));
        },
        iausAdvance: (q) => {
          const m = q.vec("myPos");
          const t = q.vec("threatPos");
          const dest = advancePoint(m, t);
          const { reward, risk } = engageNet(q, dest.x, dest.z, q.get("myElev"));
          const travelDist = W_MOVE * dist2(m[0], m[1], dest.x, dest.z) + W_PATH * 0.5 * ctx.field.exposureIntegral(m[0], m[1], dest.x, dest.z, q.get("myElev"));
          // advancing's effectiveness is the SHOT IT UNLOCKS by closing to effective
          // range; its incoming risk is DISCOUNTED because hip-firing on the move
          // suppresses the enemy (the "suppressed advance" beat). So when there is no
          // safe cover and the threat is far, closing-while-firing scores best.
          const SUPPRESS = 0.5;
          const s = scoreOption({}, { safety01: safetyFromRisk(risk * SUPPRESS, q.get("caution")), effectiveness01: effFromReward(reward), travel01: travelFrom(travelDist) }, considerations).score;
          return s - (q.get("currentPosture") === enumIdx("advance") ? 0 : q.get("inertia"));
        },
      },
      executors: {
        move: moveExecutor(self, world),
        engage: engageExecutor(self, world),
        advance: advanceExecutor(self, world),
        reload: reloadExecutor(self, world),
      },
    },
  );
}

/** posture enum index (matches the fluent's declared `values` order). */
function enumIdx(name: "none" | "open" | "cover" | "advance"): number {
  return ["none", "open", "cover", "advance"].indexOf(name);
}

/** exposure at a spot against believed foes, using the live geometry (static within a
 *  plan). Used only by spotUseful's comparative gate, not by cost (cost uses the field). */
function world_exposure(x: number, z: number, elev: number, fb: Foe[], world: SoloWorld): number {
  let n = 0;
  for (const f of fb) {
    if (dist2(x, z, f.x, f.z) > SIGHT_RANGE) continue;
    if (!world.losClear(x, z, f.x, f.z)) continue;
    if (inCoverVs(x, z, elev, f.x, f.z, f.elev, world.softCovers(), COVER_REACH)) continue;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- executors

function moveExecutor(self: string, world: SoloWorld): (api: ExecutorApi) => TaskStatus {
  return (api) => {
    const a = world.actors.get(self);
    if (!a || !a.alive) return "failure";
    const coverName = api.model.entityName(api.args[0]);
    const cover = world.coverByName.get(coverName);
    if (!cover) return "failure";
    const mem = api.remember(() => ({ path: [{ x: a.x, z: a.z }, ...findPath(a.x, a.z, cover.x, cover.z, world.activeWalls())], t0: api.clock() })) as { path: Vec2[]; t0: number };
    const traveled = (api.clock() - mem.t0) * MOVE_SPEED;
    const at = walkPolyline(mem.path, traveled);
    a.x = at.x;
    a.z = at.z;
    if (at.done) {
      a.x = cover.x;
      a.z = cover.z;
      a.elev = cover.elev ?? 0;
      a.cover = coverName;
      return "success";
    }
    return "continue";
  };
}

function engageExecutor(self: string, world: SoloWorld): (api: ExecutorApi) => TaskStatus {
  return (api) => {
    const a = world.actors.get(self);
    if (!a || !a.alive) return "failure";
    const target = world.nearestThreat(self, true);
    if (!target) return "failure"; // lost the line of fire → repair / re-search
    const mem = api.remember(() => ({ next: 0, reloadAt: -1 })) as { next: number; reloadAt: number };
    const el = api.elapsedInStep();
    if (a.ammo <= 0 && mem.reloadAt < 0) mem.reloadAt = el;
    if (mem.reloadAt >= 0) {
      if (el - mem.reloadAt < RELOAD_TIME) return "continue";
      a.ammo = AMMO_MAX;
      return "success"; // re-read the room with a fresh mag
    }
    if (el >= mem.next) {
      a.ammo -= 1;
      mem.next = el + SHOT_TIME;
      if (api.rng.next() < world.hitChance(a, target)) {
        target.hp = Math.max(0, target.hp - SHOT_DAMAGE);
        if (target.hp <= 0) {
          target.alive = false;
          return "success";
        }
      }
    }
    return "continue";
  };
}

function advanceExecutor(self: string, world: SoloWorld): (api: ExecutorApi) => TaskStatus {
  return (api) => {
    const a = world.actors.get(self);
    if (!a || !a.alive) return "failure";
    const target = world.nearestThreat(self, true);
    if (!target) return "failure";
    const mem = api.remember(() => ({ path: [{ x: a.x, z: a.z }, ...findPath(a.x, a.z, ...advanceTuple(a, target), world.activeWalls())], t0: api.clock(), next: 0 })) as { path: Vec2[]; t0: number; next: number };
    const traveled = (api.clock() - mem.t0) * MOVE_SPEED;
    const at = walkPolyline(mem.path, traveled);
    a.x = at.x;
    a.z = at.z;
    // hip-fire on the move (suppression): occasional shot at reduced accuracy
    const el = api.elapsedInStep();
    if (el >= mem.next && a.ammo > 0) {
      a.ammo -= 1;
      mem.next = el + SHOT_TIME * 1.5;
      if (api.rng.next() < world.hitChance(a, target) * HIPFIRE_ACC) {
        target.hp = Math.max(0, target.hp - SHOT_DAMAGE);
        if (target.hp <= 0) target.alive = false;
      }
    }
    if (at.done || dist2(a.x, a.z, target.x, target.z) <= IDEAL_RANGE + 0.5) return "success";
    return "continue";
  };
}

function advanceTuple(a: Actor, t: Actor): [number, number] {
  const p = advancePoint([a.x, a.z], [t.x, t.z]);
  return [p.x, p.z];
}

function reloadExecutor(self: string, world: SoloWorld): (api: ExecutorApi) => TaskStatus {
  return (api) => {
    const a = world.actors.get(self);
    if (!a || !a.alive) return "failure";
    if (api.elapsedInStep() < RELOAD_TIME) return "continue";
    a.ammo = AMMO_MAX;
    return "success";
  };
}

// ---------------------------------------------------------------- the sim

export interface SoloSimOptions {
  seed?: number;
  dt?: number;
  nodes?: number;
  weight?: number;
  profile?: Personality;
  /** capture cost-decomposition / sampled-position telemetry (C17) */
  debug?: boolean;
  /** the NPC's goal: default the Fight task; pass a GOAP goal for lookahead tests */
  goals?: GoalSpec[];
  /** bake a mid-run disruption: at sim time `t`, destroy `cover` (or the cover the NPC
   *  is currently moving to) so a deterministic replay shows the reactive replan (S2) */
  disruptAt?: { t: number; cover?: string };
}

export interface SoloFrame {
  clock: number;
  npc: {
    name: string;
    x: number;
    z: number;
    elev: number;
    hp: number;
    ammo: number;
    alive: boolean;
    /** the running operator label (e.g. "moveToSpot(spot4)") */
    step: string;
    /** a humanized verb for the HUD (e.g. "moving to cover", "firing") */
    action: string;
    /** committed posture: open / cover / advance / retreat / none */
    posture: string;
    /** how many threats can shoot the NPC right now (drives "in the open" vs "shielded") */
    exposure: number;
    /** the threat the NPC is firing on this beat, if any (for the tracer beam) */
    firingAt: string | null;
    bark: string;
  };
  threats: { name: string; x: number; z: number; hp: number; alive: boolean; firing: boolean }[];
}

export type PerceptionEvent = { t: number; kind: "saw" | "lost" | "search" | "heard"; detail?: string };

/** A deterministic solo run bundle for replay/visualization (mirrors SquadRun). */
export interface SoloRun {
  scenario: string;
  instance: SoloInstance;
  frames: SoloFrame[];
  trace: TraceEvent[];
  events: PerceptionEvent[];
  postureTrace: { t: number; posture: string }[];
  units: string[];
}

export class SoloSim {
  public readonly world: SoloWorld;
  public readonly ctx: SoloCtx;
  public readonly model: Model;
  public readonly planner: PlannerT;
  public readonly self: string;
  /** the ORIGINAL (un-augmented) instance — named covers + walls only, for rendering */
  public readonly instance: SoloInstance;
  public readonly trace: TraceEvent[] = [];
  public readonly events: PerceptionEvent[] = [];
  public readonly postureTrace: { t: number; posture: string }[] = [];
  private readonly foes: string[];
  private readonly dt: number;
  private readonly nodes: number;
  private lastSeen = -Infinity;
  private readonly foeLastSeen = new Map<string, number>();
  /** world stochastics (threat fire) — independent of the planner's RNG so the two
   *  streams can't correlate (which would skew hit rolls). */
  private readonly simRng: Rng;
  private readonly disruptAt?: { t: number; cover?: string };
  private disrupted = false;

  constructor(inst: SoloInstance, opts: SoloSimOptions = {}) {
    this.dt = opts.dt ?? 0.1;
    this.nodes = opts.nodes ?? 60_000;
    this.instance = inst;
    this.disruptAt = opts.disruptAt;
    const augmented: SoloInstance = { ...inst, covers: [...inst.covers, ...tacticalSpots(inst)] };
    this.world = new SoloWorld(augmented);
    this.self = inst.units.find((u) => u.side === "npc")!.name;
    const profile = opts.profile ?? AGGRESSIVE;
    this.ctx = { field: buildField([], [], [], FIELD_CFG), fieldBuilds: 0, costTrace: [], debug: opts.debug ?? false };
    this.model = buildSoloModel(this.self, this.world, augmented, profile, this.ctx);
    this.foes = [...this.world.actors.values()].filter((a) => a.side !== "npc").map((a) => a.name);
    this.simRng = createRng((opts.seed ?? 1) ^ 0x9e3779b9);
    this.planner = new Planner(this.model, {
      goals: opts.goals ?? [{ kind: "task", name: "Fight" }],
      now: () => this.world.clock,
      seed: opts.seed ?? 1,
      weight: opts.weight ?? 1.4,
      collectRejections: true,
      trace: (e) => this.trace.push(e),
    });
  }

  // ---- perception: world (truth) → belief, emitting discrete perception events ----
  private perceive(): void {
    const a = this.world.actors.get(this.self);
    if (!a) return;
    setVec(this, "myPos", a.x, a.z);
    set(this, "myElev", [], a.elev);
    set(this, "myAmmo", [], a.ammo);
    set(this, "myHp", [], a.hp);

    const seen = this.world.nearestThreat(this.self, true);
    const heard = seen ?? this.world.nearestThreat(this.self, false);
    const hadFix = this.read("hasThreat") === true;
    const wasSeen = this.read("threatSeen") === true;

    if (seen) {
      if (!wasSeen) this.events.push({ t: round(this.world.clock), kind: "saw", detail: seen.name });
      this.lastSeen = this.world.clock;
      set(this, "threatSeen", [], true);
      set(this, "threatConfidence", [], 1);
      setVec(this, "threatPos", seen.x, seen.z);
      set(this, "threatElev", [], seen.elev);
      set(this, "threatHp", [], seen.hp);
      set(this, "hasThreat", [], true);
    } else {
      if (wasSeen) this.events.push({ t: round(this.world.clock), kind: "lost", detail: "line of sight lost — searching last known" });
      set(this, "threatSeen", [], false);
      const age = this.world.clock - this.lastSeen;
      // confidence decays from 1 → 0 over MEMORY_SECONDS
      const conf = Math.max(0, 1 - age / MEMORY_SECONDS);
      set(this, "threatConfidence", [], conf);
      if (heard) {
        if (!hadFix) this.events.push({ t: round(this.world.clock), kind: "heard", detail: heard.name });
        setVec(this, "threatPos", heard.x, heard.z);
        set(this, "threatElev", [], heard.elev); // keep elevation current so height-advantage costing stays honest
        set(this, "threatHp", [], heard.hp);
        set(this, "hasThreat", [], true);
      } else if (age > MEMORY_SECONDS) {
        if (hadFix) this.events.push({ t: round(this.world.clock), kind: "search", detail: "target lost" });
        set(this, "hasThreat", [], false);
      }
    }

    // per-foe belief (drives exposure) — gated by LOS + memory decay
    const snapshot: ThreatSnapshot[] = [];
    for (const fname of this.foes) {
      const fa = this.world.actors.get(fname);
      if (!fa) continue;
      const los = fa.alive && dist2(a.x, a.z, fa.x, fa.z) <= SIGHT_RANGE && this.world.losClear(a.x, a.z, fa.x, fa.z);
      if (los) {
        this.foeLastSeen.set(fname, this.world.clock);
        setVec(this, "foePos", fa.x, fa.z, fname);
        set(this, "foeElev", [fname], fa.elev);
        set(this, "foeAlive", [fname], fa.alive);
        snapshot.push({ pos: { x: fa.x, z: fa.z }, elev: fa.elev, alive: true });
      } else {
        const lost = this.world.clock - (this.foeLastSeen.get(fname) ?? -Infinity);
        if (!fa.alive || lost > MEMORY_SECONDS) {
          set(this, "foeAlive", [fname], false);
        } else if (this.read2("foeAlive", fname) > 0.5) {
          // keep the last believed fix (still "dodge" a foe we just lost track of)
          snapshot.push({ pos: { x: this.vec("foePos", fname)[0], z: this.vec("foePos", fname)[1] }, elev: this.read2("foeElev", fname), alive: true });
        }
      }
    }
    // reconcile blocked covers (a destroyed crate dirties belief → replan)
    for (const c of this.world.covers) set(this, "coverBlocked", [c.name], !!c.blocked);

    // rebuild the spatial field ONCE per perception (== once per replan) from the snapshot
    this.ctx.field = buildField(snapshot, this.world.activeWalls(), this.world.softCovers(), FIELD_CFG);
    this.ctx.fieldBuilds++;
  }

  /** the posture currently committed, derived from the running plan's step labels. */
  posture(): string {
    const plan = this.planner.getPlan();
    if (!plan) return "none";
    const labels = plan.steps.filter((s) => s.k === "op").map((s) => this.model.describeGroundOp((s as { g: Parameters<Model["describeGroundOp"]>[0] }).g));
    if (labels.some((l) => l.startsWith("advanceFiring"))) return "advance";
    if (labels.some((l) => l.startsWith("moveToSpot") || l.startsWith("climbTo"))) return "cover";
    if (labels.some((l) => l.startsWith("engageFrom"))) {
      const a = this.world.actors.get(this.self)!;
      const exp = this.ctx.field.exposureAt(a.x, a.z, a.elev);
      return exp > 0 ? "open" : "cover";
    }
    if (labels.some((l) => l.startsWith("retreatTo"))) return "retreat";
    return "none";
  }

  /** scripted threats fire back at the NPC at a realistic cadence when they have a
   *  clear shot — so an exposed NPC bleeds and a covered one survives (cover pays). */
  private nextThreatShot = new Map<string, number>();
  /** threats that fired at the NPC on the most recent tick (for the view's tracer beams) */
  private firedThisTick = new Set<string>();
  private threatsFire(): void {
    this.firedThisTick.clear();
    const npc = this.world.actors.get(this.self);
    if (!npc || !npc.alive) return;
    for (const t of this.world.enemiesOf("npc")) {
      if (dist2(t.x, t.z, npc.x, npc.z) > SIGHT_RANGE) continue;
      if (!this.world.losClear(t.x, t.z, npc.x, npc.z)) continue;
      const next = this.nextThreatShot.get(t.name) ?? 0;
      if (this.world.clock < next) continue;
      this.nextThreatShot.set(t.name, this.world.clock + SHOT_TIME);
      this.firedThisTick.add(t.name);
      if (this.simRng.next() < this.world.hitChance(t, npc)) {
        npc.hp = Math.max(0, npc.hp - INCOMING_DAMAGE);
        if (npc.hp <= 0) npc.alive = false;
      }
    }
  }

  /** beats spent firing while exposed vs from cover — the C4 / personality metric. */
  public exposedFireBeats = 0;
  public coveredFireBeats = 0;

  step(): SoloFrame {
    this.world.clock += this.dt;
    // baked disruption: destroy the relied-on cover mid-execution (S2)
    if (this.disruptAt && !this.disrupted && this.world.clock >= this.disruptAt.t) {
      const target = this.disruptAt.cover ?? /moveToSpot\(([^)]+)\)/.exec(this.snapshot().npc.step)?.[1] ?? this.world.actors.get(this.self)?.cover ?? undefined;
      if (target) this.world.destroyCover(target);
      this.disrupted = true;
    }
    this.perceive();
    // write the committed posture into belief BEFORE planning (anti-dither inertia)
    set(this, "currentPosture", [], this.posture() === "open" ? "open" : this.posture() === "cover" ? "cover" : this.posture() === "advance" ? "advance" : "none");
    this.planner.tick({ nodes: this.nodes });
    this.threatsFire();
    // record whether the NPC is firing exposed or from cover (C4 / personality metric)
    const step = this.snapshot().npc.step;
    if (/^(engageFrom|advanceFiring)/.test(step)) {
      const npc = this.world.actors.get(this.self)!;
      if (this.ctx.field.exposureAt(npc.x, npc.z, npc.elev) > 0) this.exposedFireBeats++;
      else this.coveredFireBeats++;
    }
    this.postureTrace.push({ t: round(this.world.clock), posture: this.posture() });
    return this.snapshot();
  }

  run(maxSteps = 600): SoloFrame[] {
    const frames: SoloFrame[] = [this.snapshot()];
    for (let i = 0; i < maxSteps; i++) {
      frames.push(this.step());
      if (this.over()) break;
    }
    return frames;
  }

  over(): boolean {
    const npc = this.world.actors.get(this.self);
    return !npc?.alive || this.world.enemiesOf("npc").length === 0;
  }

  /** count posture changes per second over the run (anti-dither metric). */
  switchesPerSecond(): number {
    let switches = 0;
    for (let i = 1; i < this.postureTrace.length; i++) {
      const prev = this.postureTrace[i - 1].posture;
      const cur = this.postureTrace[i].posture;
      if (prev !== cur && prev !== "none" && cur !== "none") switches++;
    }
    const secs = Math.max(this.dt, this.postureTrace.length * this.dt);
    return switches / secs;
  }

  stepStarts(): string[] {
    return this.trace.filter((e) => e.t === "step.start").map((e) => (e as { label: string }).label);
  }

  hitsTaken(): number {
    return 100 - (this.world.actors.get(this.self)?.hp ?? 0);
  }

  snapshot(): SoloFrame {
    const a = this.world.actors.get(this.self)!;
    const step = this.planner.currentStep();
    const stepLabel = step && step.k === "op" ? this.model.describeGroundOp(step.g) : step ? step.k : "—";
    const status = this.planner.getStatus();
    const firing = /^(engageFrom|advanceFiring)/.test(stepLabel) && a.alive;
    const firingAt = firing ? (this.world.nearestThreat(this.self, true)?.name ?? null) : null;
    return {
      clock: round(this.world.clock),
      npc: {
        name: a.name,
        x: round(a.x),
        z: round(a.z),
        elev: a.elev,
        hp: round(a.hp),
        ammo: a.ammo,
        alive: a.alive,
        step: stepLabel,
        action: describeSoloAction(stepLabel, status, a.alive),
        posture: this.posture(),
        exposure: a.alive ? this.ctx.field.exposureAt(a.x, a.z, a.elev) : 0,
        firingAt,
        bark: this.world.barks.get(a.name) ?? "",
      },
      threats: this.world.enemiesOf("npc").map((t) => ({ name: t.name, x: round(t.x), z: round(t.z), hp: round(t.hp), alive: t.alive, firing: this.firedThisTick.has(t.name) })),
    };
  }

  // ---- small belief-read/write helpers (typed wrappers over the planner state) ----
  private read(fluent: string): number | string | boolean | null {
    return this.model.read(this.planner.state, fluent);
  }
  private read2(fluent: string, arg: string): number {
    return this.model.read(this.planner.state, fluent, arg) as number;
  }
  private vec(fluent: string, arg: string): number[] {
    const slot = this.model.slotOf(fluent, this.model.entityId(arg));
    return [this.planner.state.get(slot), this.planner.state.get(slot + 1)];
  }
}

// belief writers (module-level so the perceive() reads stay terse)
function set(sim: SoloSim, fluent: string, args: (string | number)[], value: number | string | boolean): void {
  const gids = args.map((x) => (typeof x === "string" ? sim.model.entityId(x) : x));
  sim.planner.state.set(sim.model.slotOf(fluent, ...gids), sim.model.encodeValue(fluent, value));
}
function setVec(sim: SoloSim, fluent: string, x: number, z: number, arg?: string): void {
  const slot = arg === undefined ? sim.model.slotOf(fluent) : sim.model.slotOf(fluent, sim.model.entityId(arg));
  sim.planner.state.set(slot, x);
  sim.planner.state.set(slot + 1, z);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------- spot generation

function tacticalSpots(inst: SoloInstance): CoverSpec[] {
  const walls: Box[] = (inst.walls ?? []).map((w) => ({ x: w.x, z: w.z, w: w.w, d: w.d, height: w.height }));
  const softCovers: Box[] = inst.covers.filter(isSoftCover).map(coverFootprint);
  const xs = [...inst.units.map((u) => u.x), ...inst.covers.map((c) => c.x)];
  const zs = [...inst.units.map((u) => u.z), ...inst.covers.map((c) => c.z)];
  const pad = 3;
  const pts = generateTacticalSpots({
    walls,
    softCovers,
    bounds: { minX: Math.min(...xs) - pad, maxX: Math.max(...xs) + pad, minZ: Math.min(...zs) - pad, maxZ: Math.max(...zs) + pad },
    gridSpacing: SPOT_GRID,
    max: MAX_SPOTS,
  });
  // keep cover-hugging spots (they ARE the covered firing positions); only drop spots
  // that coincide almost exactly with a NON-crate named anchor (to avoid duplicates)
  const near = (p: Vec2, c: CoverSpec) => Math.hypot(p.x - c.x, p.z - c.z) < 1.0;
  return pts.filter((p) => !inst.covers.some((c) => !isSoftCover(c) && near(p, c))).map((p, i) => ({ name: `spot${i}`, x: round(p.x), z: round(p.z), spot: true }));
}

// ---------------------------------------------------------------- model convenience

export function soloModel(inst: SoloInstance, self: string, profile: Personality = AGGRESSIVE): { model: Model; world: SoloWorld; ctx: SoloCtx } {
  const augmented: SoloInstance = { ...inst, covers: [...inst.covers, ...tacticalSpots(inst)] };
  const world = new SoloWorld(augmented);
  const ctx: SoloCtx = { field: buildField([], [], [], FIELD_CFG), fieldBuilds: 0, costTrace: [], debug: true };
  const model = buildSoloModel(self, world, augmented, profile, ctx);
  // build the field from the world's threats so direct planOnce() over this model is
  // exposure-aware (the SoloSim does this every perceive; this is the static analog)
  ctx.field = buildField(threatSnapshotsOf(world), world.activeWalls(), world.softCovers(), FIELD_CFG);
  ctx.fieldBuilds++;
  return { model, world, ctx };
}

export function neutralizeGoal(): Formula {
  return F.lte(N.fl("threatHp"), N.c(0));
}

// ---------------------------------------------------------------- view / run helpers

/** the live threats as a field snapshot (one place, reused by soloModel/greedyChoice/soloField). */
function threatSnapshotsOf(world: SoloWorld): ThreatSnapshot[] {
  return world.enemiesOf("npc").map((a) => ({ pos: { x: a.x, z: a.z }, elev: a.elev, alive: true }));
}

/** A humanized verb for the running step — for the web HUD (mirrors squad's describeAction). */
export function describeSoloAction(step: string, status: string, alive: boolean): string {
  if (!alive) return "down";
  if (step.startsWith("engageFrom")) return "firing";
  if (step.startsWith("advanceFiring")) return "advancing under fire";
  if (step.startsWith("climbTo")) return "taking high ground";
  if (step.startsWith("moveToSpot")) return "moving to cover";
  if (step.startsWith("retreatTo")) return "falling back";
  if (step.startsWith("reload")) return "reloading";
  if (step === "wait" || step === "hold") return "holding";
  if (status === "planning") return "thinking…";
  return "holding";
}

/**
 * A position-queryable danger field built from an instance's static geometry + given
 * threat positions — for the web's floor heatmap (sample `exposureAt` over a grid).
 * Reuses the same `buildField` + cover footprints the planner reasons over.
 */
export function soloField(inst: SoloInstance, threats: { x: number; z: number; elev?: number }[]): SpatialField {
  const walls: Box[] = (inst.walls ?? []).map((w) => ({ x: w.x, z: w.z, w: w.w, d: w.d, height: w.height }));
  const softCovers: Box[] = inst.covers.filter((c) => isSoftCover(c) && !c.blocked).map(coverFootprint);
  const snap: ThreatSnapshot[] = threats.map((t) => ({ pos: { x: t.x, z: t.z }, elev: t.elev ?? 0, alive: true }));
  return buildField(snap, walls, softCovers, FIELD_CFG);
}

/** Run a solo scenario to a terminal state and return a deterministic replay bundle. */
export function runSolo(inst: SoloInstance, opts: SoloSimOptions = {}): SoloRun {
  const sim = new SoloSim(inst, opts);
  const frames = sim.run();
  return { scenario: "solo-combat", instance: inst, frames, trace: sim.trace, events: sim.events, postureTrace: sim.postureTrace, units: [sim.self] };
}

// ---------------------------------------------------------------- greedy baseline (S4)

/**
 * A MYOPIC greedy baseline: it takes the immediate shot whenever it has a line of
 * fire (firing now costs no travel), and only moves — to the nearest firing spot —
 * when it has none. It reuses the same field/cost evaluators as the planner, but it
 * never weighs the WHOLE engagement: it cannot see that relocating to cover, though it
 * costs travel now, makes the firefight far cheaper overall. The planner's cumulative
 * (lookahead) costing does. Comparing the two proves the planner earns its keep (S4).
 *
 * Returns the greedy first action plus the EXPECTED-HP cost it would actually incur by
 * committing to it (so the test can show the planner's total beats it).
 */
export function greedyChoice(world: SoloWorld, npcName: string, caution = 1): { label: string; cost: number } {
  const npc = world.actors.get(npcName)!;
  const t = world.enemiesOf("npc")[0];
  const field = buildField(threatSnapshotsOf(world), world.activeWalls(), world.softCovers(), FIELD_CFG);
  const visible = (x: number, z: number) => world.losClear(x, z, t.x, t.z) && dist2(x, z, t.x, t.z) <= SIGHT_RANGE;
  // myopic: a line of fire now ⇒ shoot now (don't reason about the cost of holding an
  // exposed position over the whole fight). The cost reported is what that commitment
  // actually costs in expected HP.
  if (visible(npc.x, npc.z)) return { label: "engageFrom", cost: engagementNet(field, npc.x, npc.z, npc.elev, t.x, t.z, t.elev, t.hp, caution).net };
  // no shot ⇒ move to the nearest firing spot (cheapest to REACH, ignoring its quality)
  const spots: { label: string; reach: number; total: number }[] = [];
  for (const c of world.covers) {
    if (isSoftCover(c) || c.blocked || dist2(c.x, c.z, npc.x, npc.z) < 0.4 || !visible(c.x, c.z)) continue;
    spots.push({
      label: `moveToSpot(${c.name})`,
      reach: moveCostTo(field, npc.x, npc.z, npc.elev, c.x, c.z, t.x, t.z),
      total: moveCostTo(field, npc.x, npc.z, npc.elev, c.x, c.z, t.x, t.z) + engagementNet(field, c.x, c.z, c.elev ?? 0, t.x, t.z, t.elev, t.hp, caution).net,
    });
  }
  spots.sort((a, b) => a.reach - b.reach);
  return spots[0] ? { label: spots[0].label, cost: spots[0].total } : { label: "none", cost: Infinity };
}

// ---------------------------------------------------------------- decision-boundary sweep (S1/C17)

/**
 * Sweep a 2-D decision boundary: for each (coverDistance × threatRange) cell, build a
 * sim from `makeInst`, let it decide for a few beats, and record the emergent posture.
 * The grid (consumed by tests + a web heatmap) shows that posture is a SURFACE over
 * the inputs, not an if-table.
 */
export function sweepDecisionBoundary(
  makeInst: (coverDist: number, threatRange: number) => SoloInstance,
  coverDists: number[],
  threatRanges: number[],
  profile: Personality = AGGRESSIVE,
  beats = 3,
): { coverDist: number; threatRange: number; posture: string }[] {
  const out: { coverDist: number; threatRange: number; posture: string }[] = [];
  for (const coverDist of coverDists) {
    for (const threatRange of threatRanges) {
      const sim = new SoloSim(makeInst(coverDist, threatRange), { seed: 1, profile });
      let posture = "none";
      for (let i = 0; i < beats; i++) {
        sim.step();
        const p = sim.posture();
        if (p !== "none") { posture = p; break; }
      }
      out.push({ coverDist, threatRange, posture });
    }
  }
  return out;
}

// ---------------------------------------------------------------- instance builders

/** Open-ish arena: a threat to the north and a single crate at a tunable distance
 *  south-of-threat so cover-distance × incoming-threat can be swept (S1). */
export function postureArena(coverDist: number, threatRange: number): SoloInstance {
  // NPC at origin; threat `threatRange` to the north; a crate `coverDist` from the NPC
  // (placed between NPC and threat so standing by it shields the NPC).
  return {
    units: [
      { name: "npc", side: "npc", x: 0, z: 0 },
      { name: "t", side: "threat", x: 0, z: threatRange },
    ],
    covers: [{ name: "crate", x: 0, z: Math.min(coverDist, threatRange - 2) }],
  };
}

/** No cover anywhere + a distant threat: the only way to fight well is to close under
 *  fire — the SuppressedAdvance / hip-fire posture should emerge. */
export function openFieldArena(threatRange = 20): SoloInstance {
  return {
    units: [
      { name: "npc", side: "npc", x: 0, z: 0 },
      { name: "t", side: "threat", x: 0, z: threatRange },
    ],
    covers: [],
  };
}

/** High-ground: an elevated firing position vs a ground crate — the planner should
 *  value the height advantage (2.5D). */
export function highGroundArena(): SoloInstance {
  return {
    units: [
      { name: "npc", side: "npc", x: 0, z: 0 },
      { name: "t", side: "threat", x: 0, z: 14 },
    ],
    covers: [
      { name: "ground", x: -4, z: 4 },
      { name: "ledge", x: 4, z: 4, elev: 2, high: true },
    ],
  };
}

/**
 * Lookahead-vs-greedy map (S4): the NPC starts exposed with a clear line of fire, so a
 * myopic greedy takes the shot immediately (no travel cost now) and pays for the whole
 * firefight from the open. A firing spot beside a crate is a short move away and yields
 * a far cheaper engagement. The planner, costing the WHOLE engagement (lookahead),
 * relocates to cover first; greedy does not. (With a single threat a hidden
 * stepping-stone is geometrically impossible — any spot shielded from the lone threat
 * also loses its own firing line — so the honest contrast is shoot-now vs relocate.)
 */
export function steppingStoneArena(): SoloInstance {
  return {
    units: [
      { name: "npc", side: "npc", x: 0, z: -10 },
      { name: "t", side: "threat", x: 0, z: 10 },
    ],
    // a crate near the NPC: the auto-generated spots beside it are covered firing
    // positions a short move away. The NPC starts exposed with a clear shot.
    covers: [{ name: "crate", x: 0, z: -4 }],
  };
}

/** Disruption arena (S2): the NPC commits to a covered firing spot, then it is
 *  destroyed mid-execution; an alternate must be found without freezing. */
export function disruptionArena(): SoloInstance {
  return {
    units: [
      { name: "npc", side: "npc", x: 0, z: -10 },
      { name: "t", side: "threat", x: 0, z: 10 },
    ],
    covers: [
      { name: "primary", x: -3, z: -2 },
      { name: "alt", x: 3, z: -2 },
    ],
  };
}

/** Threat-aware navigation (S5): cross to a destination via a short exposed lane or a
 *  longer covered detour. */
export function navArena(): SoloInstance {
  return {
    units: [
      { name: "npc", side: "npc", x: -12, z: 0 },
      { name: "t", side: "threat", x: 0, z: 10 }, // overlooks the direct lane
    ],
    covers: [
      { name: "direct", x: 0, z: 0 }, // straight across, in the threat's view
      { name: "detour", x: -4, z: -8 }, // longer, but shielded
      { name: "dest", x: 10, z: 0 },
    ],
    walls: [{ x: -2, z: 4, w: 10, d: 0.6 }], // shields the southern detour from the threat
  };
}
