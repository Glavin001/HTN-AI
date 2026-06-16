/**
 * Squad Combat — a F.E.A.R.-style tactical scenario where coordinated NPCs flush
 * a target with flank / suppress / advance, reserve distinct cover, search a last
 * known position, regroup when hurt, and announce their tactics with barks — all
 * driven by the *real* reactive Planner, one per unit.
 *
 * It is the first scenario that exercises htn-ai as **game AI**, and the place the
 * library's signature spatial reasoning (discover a multi-step solution from world
 * state — see staircase.ts) is turned on combat: a unit with no line of sight
 * *derives* a flanking route to a cover that can see the target, rather than
 * following a scripted path.
 *
 * Architecture (everything below is built from existing extension points, no core
 * change):
 *   • One Model + ExecState per AI unit, authored "from my point of view" with
 *     global belief fluents — each planner's ExecState IS that unit's working
 *     memory (belief), distinct from ground truth.
 *   • A shared SquadWorld (ground-truth kinematics + a coordination blackboard)
 *     captured by the registry closures. Executors enact actions on the world;
 *     operator preconditions read belief.
 *   • Perception copies world → belief every tick (the dirty `state.set` writes
 *     that trigger fluent-precise reactive replanning, exec.ts), gated by
 *     line-of-sight + memory decay — so a stale belief (getting flanked) emerges
 *     for free.
 *   • Every IR effect is `planOnly`: planning simulates over belief, execution
 *     mutates the world, perception reconciles. (A clean use of the effect-timing
 *     tiers — no double counting.)
 *
 * Shared by tests/squad.ts (ground-truth assertions) and the web preview.
 */
import {
  type DomainDoc,
  type ExecutorApi,
  type ExtQuery,
  type Formula,
  type GoalSpec,
  type Model,
  type Planner as PlannerT,
  type Rejection,
  type Snap,
  type TaskStatus,
  type TraceEvent,
  E,
  F,
  N,
  Planner,
  createModel,
  planSummary,
} from "../src/index";

// ---------------------------------------------------------------- tunables

export const SHOT_DAMAGE = 24; // per hit; threat starts at 100 ⇒ ~5 shots
export const SUPPRESS_DAMAGE = 4; // suppression chips but mainly pins
export const AMMO_MAX = 8;
export const MOVE_SPEED = 3.2; // world units / second
export const SHOT_TIME = 0.32; // seconds to take a shot
export const RELOAD_TIME = 1.6;
export const SUPPRESS_MAX = 5; // a suppressor sustains fire up to this long (or until the flanker is set)
export const MEMORY_SECONDS = 4; // how long a lost target is remembered before "search"
export const LOW_HP = 48; // pull back to cover once this hurt (react to taking fire)
export const SIGHT_RANGE = 22;
export const BREACH_WINDOW = 6; // seconds the synchronized breach must complete within

// ---- tactical positioning model (cover is directional + dynamic; range matters) ----
// A "soft cover" crate is a half-height structure you stand BESIDE: it doesn't block
// shooting line-of-sight (you peek/shoot over it) or movement, but if its footprint
// sits between you and a shooter, that shooter's hit chance on you is cut. Which
// enemies it shields you from depends on which side of the crate you stand — so the
// same spot's value changes as enemies move or a new one appears on your flank.
export const COVER_HALF_W = 0.6; // soft-cover footprint half-width (≈ drawn crate)
export const COVER_HALF_D = 0.4; // soft-cover footprint half-depth
export const COVER_REACH = 1.8; // how close you must hug a crate for it to shield you
export const COVER_HIT_MULT = 0.28; // incoming hit chance is scaled by this when in cover
export const BASE_ACCURACY = 0.96; // point-blank hit chance (open, no cover)
export const ACC_MIN = 0.42; // hit chance at the edge of sight range (open)
export const PEEK_PENALTY = 0.82; // your OWN outgoing accuracy when you shoot from cover
// expected damage the planner reasons with when it sees a believed target (it plans
// over the *average* shot; execution rolls the seeded RNG around it)
export const EXPECTED_HIT = 0.78;

// ---- search weights: the tactical trade-off the planner OPTIMISES OVER ----
// These live in operator COST, not a greedy one-shot utility, so the planner's
// weighted-A* composes multi-step plans (stage through cover, then push to the
// strong angle) that a one-hop greedy score would miss.
// The planner is myopic (it plans one shot per beat, then replans), so a single
// exposed shot must stand in for the SUSTAINED danger of holding an exposed spot —
// hence W_EXPOSE is large relative to the one-off cost of relocating. This is what
// makes "break contact and reach cover" win over "trade shots in the open".
export const W_MOVE = 0.35; // cost per world-unit travelled
export const W_EXPOSE = 5.0; // cost per enemy with a clear shot on you (the danger lever)
export const W_PATH_EXPOSE = 0.8; // cost for crossing exposed ground to reach a spot
export const W_RANGE = 0.12; // mild pull toward comfortable firing range (don't let it dominate cover)
export const IDEAL_RANGE = 12; // closer than this you fight well; far costs a little accuracy
export const SPOT_GRID = 3.2; // spacing of the auto-generated walkable grid
export const MAX_SPOTS = 48; // cap on tactical points exposed to the planner (branching)

/** Fluents the move-cost externals read — listed so a foe moving (perception) dirties
 *  the cost and the unit re-decides each beat. */
const TACTICAL_READS = ["myPos", "coverPos", "threatPos", "foePos", "foeAlive"];

// ---------------------------------------------------------------- instance shapes

export type Side = "enemy" | "ally" | "player";
export type Role = "assault" | "flanker" | "suppressor" | "leader";

export interface Vec2 {
  x: number;
  z: number;
}

export interface UnitSpec {
  name: string;
  side: Side;
  x: number;
  z: number;
  hp?: number;
  ammo?: number;
  role?: Role;
}

export interface CoverSpec {
  name: string;
  x: number;
  z: number;
  /** a flanking position (used by the coordinated flank tactic) */
  flank?: boolean;
  /** elevated cover — grants a height advantage (E1 spatial tactics) */
  high?: boolean;
  /** a breach stack-up point (E4 synchronized assault) */
  breach?: boolean;
  /** a fall-back / rally point used when retreating */
  rally?: boolean;
  /** an auto-generated tactical standing position (grid / cover edge) — invisible,
   *  not a crate, evaluated by the planner as a candidate firing/cover spot */
  spot?: boolean;
}

/** Axis-aligned obstacle that blocks line of sight AND movement (a wall / crate). */
export interface WallSpec {
  x: number;
  z: number;
  w: number;
  d: number;
  /** a breachable door: blocks sight + movement until a breach action breaks it */
  door?: boolean;
}

export interface SquadInstance {
  units: UnitSpec[];
  covers: CoverSpec[];
  walls?: WallSpec[];
  /** scripted waypoints the player avatar walks (the NPCs react to it) */
  playerPath?: Vec2[];
  /** seconds the player dwells at each waypoint */
  playerDwell?: number;
  /** open with a synchronized breach-and-clear (E4) instead of a standing fight */
  breach?: boolean;
}

// ---------------------------------------------------------------- ground-truth world

interface Actor {
  name: string;
  side: Side;
  x: number;
  z: number;
  hp: number;
  ammo: number;
  alive: boolean;
  /** seconds remaining of being suppressed (pinned) */
  suppressedFor: number;
  cover: string | null;
  elevation: number;
}

/** One team's coordination blackboard (squad comms — shared within a team only). */
export interface TeamState {
  tactic: "hold" | "flank" | "breach";
  /** a flanker on this team has reached position — its suppressors push up */
  flankerReady: boolean;
  /** this team has breached the door */
  breached: boolean;
}

const HOSTILE: Record<Side, Side[]> = {
  enemy: ["player", "ally"],
  ally: ["enemy"],
  player: ["enemy"],
};

function dist2(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

/** Segment (a→b) vs axis-aligned box intersection — used for line-of-sight. */
function segHitsBox(ax: number, az: number, bx: number, bz: number, w: WallSpec): boolean {
  // slab method on the box [x, x+w] × [z, z+d]
  const dx = bx - ax;
  const dz = bz - az;
  let t0 = 0;
  let t1 = 1;
  const minX = w.x;
  const maxX = w.x + w.w;
  const minZ = w.z;
  const maxZ = w.z + w.d;
  for (const [p, q0, q1] of [
    [-dx, ax - minX, 0],
    [dx, maxX - ax, 0],
    [-dz, az - minZ, 0],
    [dz, maxZ - az, 0],
  ] as [number, number, number][]) {
    void q1;
    if (p === 0) {
      if (q0 < 0) return false; // parallel and outside this slab
    } else {
      const t = q0 / p;
      if (p < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return t0 <= t1;
}

/** Roughly the agent's body radius — obstacle corners are padded by it so paths clear walls. */
const UNIT_RADIUS = 0.6;

/** The four padded corners of a box, as candidate path waypoints. */
function boxCorners(w: WallSpec, pad: number): Vec2[] {
  return [
    { x: w.x - pad, z: w.z - pad },
    { x: w.x + w.w + pad, z: w.z - pad },
    { x: w.x - pad, z: w.z + w.d + pad },
    { x: w.x + w.w + pad, z: w.z + w.d + pad },
  ];
}

/** A cover crate is "soft cover" — a half-height thing you fight from beside —
 *  unless it's a maneuver anchor (flank / high / breach / rally), which are open
 *  waypoints, not crates. Only soft cover blocks incoming fire directionally. */
export function isSoftCover(c: CoverSpec): boolean {
  return !c.flank && !c.high && !c.breach && !c.rally && !c.spot;
}

/** The axis-aligned footprint of a soft-cover crate (used for directional cover). */
export function coverFootprint(c: CoverSpec): WallSpec {
  return { x: c.x - COVER_HALF_W, z: c.z - COVER_HALF_D, w: 2 * COVER_HALF_W, d: 2 * COVER_HALF_D };
}

/**
 * Auto-generate the invisible tactical standing positions the planner evaluates:
 * the padded corners of every wall + crate (the "peek the edge" spots) plus a
 * coarse walkable grid over the play area. These are NOT crates (spot:true ⇒ not
 * soft cover) and are not drawn — only real geometry is. Deterministic + capped so
 * the planner's branching stays bounded.
 */
export function generateTacticalSpots(inst: SquadInstance): CoverSpec[] {
  const walls = inst.walls ?? [];
  const obstacles: WallSpec[] = [...walls, ...inst.covers.filter(isSoftCover).map(coverFootprint)];
  const insideWall = (x: number, z: number) => walls.some((w) => x > w.x - 0.3 && x < w.x + w.w + 0.3 && z > w.z - 0.3 && z < w.z + w.d + 0.3);
  const pts: Vec2[] = [];
  // cover-edge spots first (kept preferentially under the cap): the 4 corners (peek
  // an angle) AND the 4 edge-midpoints (tuck directly behind cover from a head-on
  // shooter). Together these are the "go around the crate to block their line" spots.
  const EDGE = UNIT_RADIUS + 0.7;
  for (const o of obstacles) {
    const cx = o.x + o.w / 2;
    const cz = o.z + o.d / 2;
    const offs: [number, number][] = [
      [-1, -1], [1, -1], [-1, 1], [1, 1], // corners
      [0, -1], [0, 1], [-1, 0], [1, 0], // edge midpoints (head-on cover)
    ];
    for (const [sx, sz] of offs) {
      const x = cx + sx * (o.w / 2 + EDGE);
      const z = cz + sz * (o.d / 2 + EDGE);
      if (!insideWall(x, z)) pts.push({ x, z });
    }
    // a wider standoff ring — diagonal firing angles a step back from the crate, so a
    // unit can pick an OBLIQUE line on the enemy (more interesting perspectives than
    // just hugging the box edge)
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]) {
      const x = cx + sx * (o.w / 2 + EDGE * 2.6);
      const z = cz + sz * (o.d / 2 + EDGE * 2.6);
      if (!insideWall(x, z)) pts.push({ x, z });
    }
  }
  // coarse walkable grid over the bounding area
  const xs = [...inst.units.map((u) => u.x), ...inst.covers.map((c) => c.x)];
  const zs = [...inst.units.map((u) => u.z), ...inst.covers.map((c) => c.z)];
  const pad = 3;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minZ = Math.min(...zs) - pad;
  const maxZ = Math.max(...zs) + pad;
  for (let x = minX; x <= maxX; x += SPOT_GRID) for (let z = minZ; z <= maxZ; z += SPOT_GRID) if (!insideWall(x, z)) pts.push({ x, z });
  // dedupe + drop points that coincide with a named cover (already a candidate)
  const near = (a: Vec2, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z) < SPOT_GRID * 0.6;
  const kept: Vec2[] = [];
  for (const p of pts) {
    if (kept.some((k) => near(k, p))) continue;
    if (inst.covers.some((c) => near(p, c))) continue;
    kept.push(p);
  }
  return kept.slice(0, MAX_SPOTS).map((p, i) => ({ name: `spot${i}`, x: round(p.x), z: round(p.z), spot: true }));
}

/** Distance from a point to an axis-aligned box (0 if inside). */
function distToBox(px: number, pz: number, b: WallSpec): number {
  const dx = Math.max(b.x - px, 0, px - (b.x + b.w));
  const dz = Math.max(b.z - pz, 0, pz - (b.z + b.d));
  return Math.hypot(dx, dz);
}

/** Hit-chance falloff with range: full at point-blank, ACC_MIN at sight range. */
function rangeFalloff(d: number): number {
  const t = Math.min(1, Math.max(0, d / SIGHT_RANGE));
  return BASE_ACCURACY + (ACC_MIN - BASE_ACCURACY) * t;
}

/** Position reached by walking `dist` along a polyline; `done` once past the end. */
function walkPolyline(path: Vec2[], dist: number): { x: number; z: number; done: boolean } {
  let rem = dist;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = dist2(path[i].x, path[i].z, path[i + 1].x, path[i + 1].z);
    if (rem <= seg) {
      const t = seg > 0 ? rem / seg : 1;
      return { x: lerp(path[i].x, path[i + 1].x, t), z: lerp(path[i].z, path[i + 1].z, t), done: false };
    }
    rem -= seg;
  }
  const last = path[path.length - 1];
  return { x: last.x, z: last.z, done: true };
}

/**
 * The shared world: ground-truth actor kinematics + vitals, the static cover
 * geometry, line-of-sight obstacles, and a coordination blackboard. Belief lives
 * in each planner's ExecState; this is truth.
 */
export class SquadWorld {
  public clock = 0;
  public readonly actors = new Map<string, Actor>();
  public readonly covers: CoverSpec[];
  public readonly coverByName = new Map<string, CoverSpec>();
  public readonly walls: WallSpec[];
  /** half-height crate footprints — block incoming fire directionally, not LOS/movement */
  public readonly softCovers: WallSpec[];

  // ---- blackboard — PER TEAM (each side coordinates its own squad; the two teams
  //      share no memory, only physical cover reservations) ----
  private readonly teamState = new Map<Side, TeamState>();
  /** cover name → owning unit name (reservation); prevents two units per slot */
  public readonly coverOwner = new Map<string, string | null>();
  /** most recent bark per unit, for the view */
  public readonly barks = new Map<string, { text: string; at: number }>();

  /** the coordination blackboard for one team (lazily created). */
  team(side: Side): TeamState {
    let t = this.teamState.get(side);
    if (!t) this.teamState.set(side, (t = { tactic: "hold", flankerReady: false, breached: false }));
    return t;
  }

  /** the blackboard for the team `self` belongs to. */
  teamOf(self: string): TeamState | null {
    const a = this.actors.get(self);
    return a ? this.team(a.side) : null;
  }

  constructor(inst: SquadInstance) {
    this.covers = inst.covers;
    this.walls = inst.walls ?? [];
    this.softCovers = inst.covers.filter(isSoftCover).map(coverFootprint);
    for (const c of inst.covers) {
      this.coverByName.set(c.name, c);
      this.coverOwner.set(c.name, null);
    }
    for (const u of inst.units) {
      this.actors.set(u.name, {
        name: u.name,
        side: u.side,
        x: u.x,
        z: u.z,
        hp: u.hp ?? 100,
        ammo: u.ammo ?? AMMO_MAX,
        alive: true,
        suppressedFor: 0,
        cover: null,
        elevation: 0,
      });
    }
  }

  /** the breach door has been broken — it no longer blocks sight or movement */
  public doorBroken = false;

  /** obstacles currently blocking sight + movement (the door drops once breached) */
  activeWalls(): WallSpec[] {
    return this.doorBroken ? this.walls.filter((w) => !w.door) : this.walls;
  }

  losClear(ax: number, az: number, bx: number, bz: number): boolean {
    for (const w of this.activeWalls()) if (segHitsBox(ax, az, bx, bz, w)) return false;
    return true;
  }

  /** Is a unit AT (px,pz) in soft cover against a shooter at (ex,ez)? True when a
   *  crate it is hugging sits on the line between them — directional + dynamic, so
   *  it lapses the instant the shooter rounds the crate (or a new one flanks). */
  inCoverVs(px: number, pz: number, ex: number, ez: number): boolean {
    for (const c of this.softCovers) {
      if (distToBox(px, pz, c) > COVER_REACH) continue; // must be hugging THIS crate
      if (segHitsBox(px, pz, ex, ez, c)) return true; // crate blocks the incoming line
    }
    return false;
  }

  /** Every living actor hostile to `side` (ground truth — used for tuning/tests). */
  hostilesOf(side: Side): Actor[] {
    return [...this.actors.values()].filter((a) => a.alive && HOSTILE[side].includes(a.side));
  }

  /** The names of every actor hostile to `self` (static — the set of possible foes,
   *  alive or not). Each becomes a `foe` entity so belief can track it individually. */
  foeNamesFor(self: string): string[] {
    const me = this.actors.get(self);
    if (!me) return [];
    return [...this.actors.values()].filter((a) => HOSTILE[me.side].includes(a.side)).map((a) => a.name);
  }

  /** Probability a shot from `shooter` lands on `target`, given range + the target's
   *  cover relative to the shooter (and a small peek penalty if the shooter itself is
   *  hugging cover). Deterministic inputs → the executor rolls a seeded RNG against it. */
  hitChance(shooter: Actor, target: Actor): number {
    const d = dist2(shooter.x, shooter.z, target.x, target.z);
    let p = rangeFalloff(d);
    if (this.inCoverVs(target.x, target.z, shooter.x, shooter.z)) p *= COVER_HIT_MULT;
    // shooting from behind your own crate trims your accuracy a touch (you're peeking)
    if (this.softCovers.some((c) => distToBox(shooter.x, shooter.z, c) <= COVER_REACH && segHitsBox(shooter.x, shooter.z, target.x, target.z, c))) p *= PEEK_PENALTY;
    return Math.min(1, Math.max(0.02, p));
  }

  /** How many of `foes` currently have a clear line of fire on (px,pz) AND no soft
   *  cover denies them — i.e. how exposed this spot is. Pass believed foe positions. */
  exposureAt(px: number, pz: number, foes: { x: number; z: number }[]): number {
    let n = 0;
    for (const f of foes) {
      if (dist2(px, pz, f.x, f.z) > SIGHT_RANGE) continue;
      if (!this.losClear(px, pz, f.x, f.z)) continue; // a wall already shields you here
      if (this.inCoverVs(px, pz, f.x, f.z)) continue; // a crate denies this shooter
      n++;
    }
    return n;
  }

  /** How many of `foes` this spot has soft cover against (the spot's defensive value). */
  coverCountAt(px: number, pz: number, foes: { x: number; z: number }[]): number {
    let n = 0;
    for (const f of foes) if (dist2(px, pz, f.x, f.z) <= SIGHT_RANGE && this.inCoverVs(px, pz, f.x, f.z)) n++;
    return n;
  }

  /** Shortest walkable path from (ax,az) to (bx,bz) around obstacles (visibility
   *  graph over padded box corners + Dijkstra). Returns waypoints incl. the goal. */
  findPath(ax: number, az: number, bx: number, bz: number): Vec2[] {
    const walls = this.activeWalls();
    if (walls.every((w) => !segHitsBox(ax, az, bx, bz, w))) return [{ x: bx, z: bz }];
    const inside = (p: Vec2) => walls.some((w) => p.x > w.x - 0.01 && p.x < w.x + w.w + 0.01 && p.z > w.z - 0.01 && p.z < w.z + w.d + 0.01);
    const nodes: Vec2[] = [{ x: ax, z: az }, ...walls.flatMap((w) => boxCorners(w, UNIT_RADIUS)).filter((c) => !inside(c)), { x: bx, z: bz }];
    const n = nodes.length;
    const clear = (i: number, j: number) => walls.every((w) => !segHitsBox(nodes[i].x, nodes[i].z, nodes[j].x, nodes[j].z, w));
    const adj: number[][] = nodes.map(() => []);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (clear(i, j)) { adj[i].push(j); adj[j].push(i); }
    const dist = new Array(n).fill(Infinity);
    const prev = new Array(n).fill(-1);
    const done = new Array(n).fill(false);
    dist[0] = 0;
    for (let it = 0; it < n; it++) {
      let u = -1;
      let best = Infinity;
      for (let k = 0; k < n; k++) if (!done[k] && dist[k] < best) { best = dist[k]; u = k; }
      if (u < 0) break;
      done[u] = true;
      for (const v of adj[u]) {
        const d = dist[u] + dist2(nodes[u].x, nodes[u].z, nodes[v].x, nodes[v].z);
        if (d < dist[v]) { dist[v] = d; prev[v] = u; }
      }
    }
    if (dist[n - 1] === Infinity) return [{ x: bx, z: bz }]; // unreachable → straight (best effort)
    const path: Vec2[] = [];
    for (let cur = n - 1; cur > 0; cur = prev[cur]) path.unshift({ x: nodes[cur].x, z: nodes[cur].z });
    return path;
  }

  /** the nearest hostile actor to `self`; optionally requiring line of sight */
  nearestHostile(self: string, requireLos: boolean): Actor | null {
    const me = this.actors.get(self);
    if (!me) return null;
    let best: Actor | null = null;
    let bestD = Infinity;
    for (const other of this.actors.values()) {
      if (!other.alive || !HOSTILE[me.side].includes(other.side)) continue;
      const d = dist2(me.x, me.z, other.x, other.z);
      if (d > SIGHT_RANGE) continue;
      if (requireLos && !this.losClear(me.x, me.z, other.x, other.z)) continue;
      if (d < bestD) {
        bestD = d;
        best = other;
      }
    }
    return best;
  }

  /** release any cover `self` holds, evict any prior owner, then claim `cover`
   *  (strict single-owner — the invariant the reservation test relies on). */
  claimCover(self: string, cover: string): void {
    for (const [c, owner] of this.coverOwner) if (owner === self) this.coverOwner.set(c, null);
    const prev = this.coverOwner.get(cover);
    if (prev && prev !== self) {
      const pa = this.actors.get(prev);
      if (pa) pa.cover = null;
    }
    this.coverOwner.set(cover, self);
    const a = this.actors.get(self);
    if (a) a.cover = cover;
  }

  bark(self: string, text: string): void {
    this.barks.set(self, { text, at: this.clock });
  }
}

// ---------------------------------------------------------------- the domain (one POV)

/**
 * The combat domain, authored from a single unit's point of view (global "my…"
 * fluents). Every AI unit — adversary or ally — runs this same domain; only its
 * side (perception) and who sets its tactic (the coordinator vs. player commands)
 * differ. Compiled once per unit with a registry that closes over the shared
 * world and that unit's identity.
 */
export const squadDomain: DomainDoc = {
  name: "squad-combat",
  types: [{ name: "cover" }, { name: "foe" }],
  fluents: [
    // --- self (belief; perception mirrors truth, ungated) ---
    { name: "myPos", kind: "vec2" },
    { name: "myAmmo", kind: "int", initial: AMMO_MAX },
    { name: "myHp", kind: "float", initial: 100 },
    { name: "role", kind: "enum", values: ["assault", "flanker", "suppressor", "leader"], initial: "assault" },
    { name: "tactic", kind: "enum", values: ["hold", "flank", "breach", "regroup"], initial: "hold" },
    { name: "myCover", kind: "entity", entityType: "cover" },
    // how much to weight staying alive right now (1 = normal). The coordinator raises
    // it when a unit is outgunned or hurt, so it values cover + breaking contact more —
    // an outnumbered unit flows to cover/escape instead of trading in the open.
    { name: "caution", kind: "float", initial: 1 },
    // the spot-graph route's decision for THIS beat (written by perception): either
    // "engage from where I am" or the next hop of the optimal multi-step route. The
    // deliberation (pick a spot now because it unlocks a better one) lives in that
    // search; the planner just enacts the decision and re-decides as the world moves.
    { name: "engageHere", kind: "boolean", initial: false },
    { name: "chosenSpot", kind: "entity", entityType: "cover" },
    // selects the positioning engine: false ⇒ the bespoke spot-graph route (default);
    // true ⇒ the generic GOAP search over move+engage, guided by a domain potential-
    // field heuristic (the planner DISCOVERS the route itself). Set per-unit at init.
    { name: "useGoap", kind: "boolean", initial: false },
    // --- threat (belief; perception gates by line-of-sight + memory) ---
    { name: "threatPos", kind: "vec2" },
    { name: "threatHp", kind: "float", initial: 100 },
    { name: "threatSeen", kind: "boolean", initial: false }, // have a current line of sight
    { name: "hasThreat", kind: "boolean", initial: false }, // have a position fix at all (sight OR hearing)
    // --- known hostiles (belief; one set of slots per foe, gated like the threat).
    //     This is what makes EXPOSURE real: a spot's danger = how many of THESE have a
    //     line of fire on it. A foe you haven't seen yet isn't dodged — so when one
    //     appears on your flank, your cover lapses and you reactively reposition. ---
    { name: "foePos", params: [{ name: "f", type: "foe" }], kind: "vec2" },
    { name: "foeAlive", params: [{ name: "f", type: "foe" }], kind: "boolean", initial: false },
    { name: "foeSeen", params: [{ name: "f", type: "foe" }], kind: "boolean", initial: false },
    // --- squad blackboard (belief; written by the coordinator) ---
    { name: "flankerReady", kind: "boolean", initial: false },
    // --- cover descriptors (static, set at init) ---
    { name: "coverPos", params: [{ name: "c", type: "cover" }], kind: "vec2" },
    { name: "coverFlank", params: [{ name: "c", type: "cover" }], kind: "boolean", initial: false },
    { name: "coverHigh", params: [{ name: "c", type: "cover" }], kind: "boolean", initial: false },
    { name: "coverBreach", params: [{ name: "c", type: "cover" }], kind: "boolean", initial: false },
    { name: "coverRally", params: [{ name: "c", type: "cover" }], kind: "boolean", initial: false },
    // dynamic: reserved by another unit (perception mirrors the world blackboard) —
    // a claim by one unit dirties this for the others, who then replan to a free slot
    { name: "coverTaken", params: [{ name: "c", type: "cover" }], kind: "boolean", initial: false },
  ],
  compounds: [{ name: "Fight" }, { name: "Regroup" }, { name: "Neutralize" }],
  operators: [
    {
      // seek a free cover (the workhorse move; GOAP picks WHICH cover gives LOS)
      name: "advanceTo",
      params: [{ name: "c", type: "cover" }],
      pre: F.not(F.lit("coverTaken", ["?c"])),
      // abort the move the instant the slot is taken OR a line of fire opens up —
      // don't blindly run across open ground when you suddenly have a shot
      verify: F.and(F.not(F.lit("coverTaken", ["?c"])), F.not(F.ext("canSee", [], ["myPos", "threatPos"]))),
      eff: [
        E.setVec("myPos", [], N.ext("coverX", ["?c"], ["coverPos"]), N.ext("coverZ", ["?c"], ["coverPos"]), undefined, "planOnly"),
        E.set("myCover", [], "?c", "planOnly"),
      ],
      cost: N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.1)),
      duration: N.div(N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.1)), N.c(MOVE_SPEED)),
      executor: "move",
    },
    {
      // the fluid tactical move: relocate to ANY useful standing position (grid spot,
      // cover edge, or named cover). Its COST carries the whole positional trade-off —
      // travel + the danger of crossing exposed ground to get there + being out of
      // comfortable range — so the planner's weighted-A* composes multi-step plans
      // (stage through cover, then push to the strong angle) a greedy score can't.
      // Destination exposure isn't charged here; the following takeShot pays for
      // firing while exposed, so "move to cover then fire" is what gets optimised.
      name: "moveToSpot",
      params: [{ name: "c", type: "cover" }],
      pre: F.and(F.not(F.lit("coverTaken", ["?c"])), F.ext("isChosen", ["?c"], ["chosenSpot"])),
      // abort the move the instant the slot is taken OR the route re-decides (a foe
      // moved, a new one appeared on your flank — the chosen hop is no longer best)
      verify: F.and(F.not(F.lit("coverTaken", ["?c"])), F.ext("isChosen", ["?c"], ["chosenSpot"])),
      eff: [
        E.setVec("myPos", [], N.ext("coverX", ["?c"], ["coverPos"]), N.ext("coverZ", ["?c"], ["coverPos"]), undefined, "planOnly"),
        E.set("myCover", [], "?c", "planOnly"),
      ],
      cost: N.add(
        N.mul(N.dist("myPos", [], "coverPos", ["?c"]), N.c(W_MOVE)),
        N.add(N.mul(N.ext("pathExposure", ["?c"], TACTICAL_READS), N.c(W_PATH_EXPOSE)), N.mul(N.ext("spotRange", ["?c"], TACTICAL_READS), N.c(W_RANGE))),
      ),
      duration: N.div(N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.1)), N.c(MOVE_SPEED)),
      executor: "move",
    },
    {
      // GOAP-mode positioning: relocate to any FIRING position (a spot that sees the
      // threat — the move executor pathfinds around walls to reach it). Used only by
      // the generic kill-search (neutralizeGoap); its cost is travel + crossing danger,
      // and engageFrom adds the firefight cost, so the search minimises the total. The
      // potential-field heuristic is what keeps this search from wandering.
      name: "moveFree",
      params: [{ name: "c", type: "cover" }],
      pre: F.and(F.lit("useGoap"), F.not(F.lit("coverTaken", ["?c"])), F.ext("coverSeesThreat", ["?c"], ["coverPos", "threatPos"])),
      verify: F.and(F.not(F.lit("coverTaken", ["?c"])), F.ext("coverSeesThreat", ["?c"], ["coverPos", "threatPos"])),
      eff: [
        E.setVec("myPos", [], N.ext("coverX", ["?c"], ["coverPos"]), N.ext("coverZ", ["?c"], ["coverPos"]), undefined, "planOnly"),
        E.set("myCover", [], "?c", "planOnly"),
      ],
      cost: N.add(N.mul(N.dist("myPos", [], "coverPos", ["?c"]), N.c(W_MOVE)), N.mul(N.ext("pathExposure", ["?c"], TACTICAL_READS), N.c(W_PATH_EXPOSE))),
      duration: N.div(N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.1)), N.c(MOVE_SPEED)),
      executor: "move",
    },
    {
      // move to a flanking cover (coordinated flank tactic); same motion, tagged
      name: "flankTo",
      params: [{ name: "c", type: "cover" }],
      pre: F.and(F.lit("coverFlank", ["?c"]), F.not(F.lit("coverTaken", ["?c"]))),
      // a flank is a deliberate maneuver to break symmetry — commit to it (only
      // bail if the slot is taken; being hurt is handled by the retreat method)
      verify: F.not(F.lit("coverTaken", ["?c"])),
      eff: [
        E.setVec("myPos", [], N.ext("coverX", ["?c"], ["coverPos"]), N.ext("coverZ", ["?c"], ["coverPos"]), undefined, "planOnly"),
        E.set("myCover", [], "?c", "planOnly"),
      ],
      cost: N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.1)),
      duration: N.div(N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.1)), N.c(MOVE_SPEED)),
      executor: "move",
    },
    {
      // climb to elevated cover — a height advantage (E1 emergent spatial tactics)
      name: "climbTo",
      params: [{ name: "c", type: "cover" }],
      pre: F.and(F.lit("coverHigh", ["?c"]), F.not(F.lit("coverTaken", ["?c"]))),
      verify: F.and(F.not(F.lit("coverTaken", ["?c"])), F.not(F.ext("canSee", [], ["myPos", "threatPos"]))),
      eff: [
        E.setVec("myPos", [], N.ext("coverX", ["?c"], ["coverPos"]), N.ext("coverZ", ["?c"], ["coverPos"]), undefined, "planOnly"),
        E.set("myCover", [], "?c", "planOnly"),
      ],
      cost: N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.6)),
      duration: N.div(N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.6)), N.c(MOVE_SPEED)),
      executor: "move",
    },
    {
      // stack up at the breach point (E4 synchronized assault); distinct slots so
      // the breachers don't pile onto the same spot at the door
      name: "moveToBreach",
      params: [{ name: "c", type: "cover" }],
      pre: F.and(F.lit("coverBreach", ["?c"]), F.not(F.lit("coverTaken", ["?c"]))),
      verify: F.not(F.lit("coverTaken", ["?c"])),
      eff: [
        E.setVec("myPos", [], N.ext("coverX", ["?c"], ["coverPos"]), N.ext("coverZ", ["?c"], ["coverPos"]), undefined, "planOnly"),
        E.set("myCover", [], "?c", "planOnly"),
      ],
      cost: N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.1)),
      duration: N.div(N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.1)), N.c(MOVE_SPEED)),
      executor: "move",
    },
    {
      // fall back to a rally point when hurt
      name: "retreatTo",
      params: [{ name: "c", type: "cover" }],
      pre: F.and(F.lit("coverRally", ["?c"]), F.not(F.lit("coverTaken", ["?c"]))),
      verify: F.not(F.lit("coverTaken", ["?c"])),
      eff: [
        E.setVec("myPos", [], N.ext("coverX", ["?c"], ["coverPos"]), N.ext("coverZ", ["?c"], ["coverPos"]), undefined, "planOnly"),
        E.set("myCover", [], "?c", "planOnly"),
      ],
      cost: N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.1)),
      duration: N.div(N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.1)), N.c(MOVE_SPEED)),
      executor: "move",
    },
    {
      // fire on the threat; reactively aborts the instant line-of-sight is lost.
      // Like suppress, excluded from the GOAP kill-search (not(useGoap)): it chips
      // threatHp per shot and burns ammo, so as a route to "threatHp ≤ 0" it spawns
      // deep (threatHp × ammo) chip-chains that explode the search even with dedup.
      // The GOAP search uses engageFrom (the whole-burst finisher) as its kill action.
      name: "takeShot",
      pre: F.and(
        F.not(F.lit("useGoap")),
        F.lit("hasThreat"),
        F.ext("canSee", [], ["myPos", "threatPos"]),
        F.gt(N.fl("myAmmo"), N.c(0)),
        F.gt(N.fl("threatHp"), N.c(0)),
      ),
      verify: F.ext("canSee", [], ["myPos", "threatPos"]),
      // planning reasons over the EXPECTED damage of a shot from where I am: closer +
      // a target not in cover ⇒ more damage per shot, so the planner values closing in
      // and denying the target its cover (execution rolls the seeded RNG around this).
      eff: [E.dec("myAmmo", [], N.c(1), "planOnly"), E.dec("threatHp", [], N.ext("shotDamage", [], ["myPos", "threatPos"]), "planOnly")],
      // firing from an exposed position is COSTLY (every enemy with a clear shot on you
      // costs W_EXPOSE), so the planner prefers to reach cover before it opens up —
      // and weighs that against the travel it would take. This is the lever that makes
      // "fight from cover" emerge instead of trading shots in the open.
      cost: N.add(N.c(1), N.mul(N.ext("myExposure", [], ["myPos", "foePos", "foeAlive"]), N.c(W_EXPOSE))),
      duration: SHOT_TIME,
      executor: "shoot",
    },
    {
      // ENGAGE FROM HERE — the macro the kill-search reasons over. It stands for
      // "fight the threat from this position to the finish": its planning COST is the
      // whole engagement (shots-to-kill × the per-shot exposure of THIS spot), so the
      // search compares "engage from the open" against "move to cover, then engage"
      // over the full firefight, not one beat — which is what makes fighting from cover
      // (and closing for accuracy) win. Search stays shallow (it's one op per position),
      // while execution fires a burst and hands control back so the unit re-reads the
      // room between magazines. The planOnly effect optimistically projects the kill so
      // a single engageFrom satisfies the goal during search.
      name: "engageFrom",
      pre: F.and(F.lit("hasThreat"), F.ext("canSee", [], ["myPos", "threatPos"]), F.gt(N.fl("threatHp"), N.c(0))),
      verify: F.ext("canSee", [], ["myPos", "threatPos"]),
      eff: [E.set("threatHp", [], N.c(0), "planOnly")],
      cost: N.ext("engageCost", [], ["myPos", "threatPos", "threatHp", "foePos", "foeAlive"]),
      duration: N.ext("engageDur", [], ["myPos", "threatPos", "threatHp"]),
      executor: "engage",
    },
    {
      // suppressing fire: pins the target so a flanker can move (chips little HP).
      // Excluded from the GOAP kill-search (not(useGoap)): it chips threatHp a little
      // per shot, so as a path to "threatHp ≤ 0" it spawns deep chip-chains (threatHp ×
      // ammo states spatialDedup can't fold) that explode the search. It's a coordinated
      // team tactic (suppress-and-flank), not a solo finisher — engageFrom is the kill.
      name: "suppress",
      pre: F.and(F.not(F.lit("useGoap")), F.lit("hasThreat"), F.ext("canSee", [], ["myPos", "threatPos"]), F.gt(N.fl("myAmmo"), N.c(0))),
      verify: F.ext("canSee", [], ["myPos", "threatPos"]),
      eff: [E.dec("myAmmo", [], N.c(1), "planOnly"), E.dec("threatHp", [], N.c(SUPPRESS_DAMAGE), "planOnly")],
      // suppressing is firing too — it exposes you, so the solo kill-search won't pick
      // it over aimed shots; it earns its keep only in the coordinated suppress-and-flank
      cost: N.add(N.c(1), N.mul(N.ext("myExposure", [], ["myPos", "foePos", "foeAlive"]), N.c(W_EXPOSE))),
      duration: 1.2,
      executor: "suppress",
    },
    {
      // breach the door (only as part of a breach assault — not a shoot-through-walls
      // shortcut; a standing fight must still earn a line of sight by flanking)
      name: "breach",
      pre: F.and(F.lit("tactic", [], "breach"), F.lit("hasThreat"), F.gt(N.fl("threatHp"), N.c(0))),
      eff: [E.dec("threatHp", [], N.c(SHOT_DAMAGE), "planOnly")],
      cost: 1,
      duration: 0.4,
      executor: "breach",
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
    // 1. hurt → fall back to the NEAREST rally point (utility prefers closest)
    {
      name: "retreat",
      task: "Fight",
      params: [{ name: "r", type: "cover" }],
      pre: F.and(F.lt(N.fl("myHp"), N.c(LOW_HP)), F.lit("coverRally", ["?r"]), F.not(F.lit("coverTaken", ["?r"]))),
      utility: N.sub(N.c(0), N.dist("myPos", [], "coverPos", ["?r"])),
      subtasks: [{ do: "retreatTo", args: ["?r"] }],
    },
    // 2. synchronized breach (E4) — stack up AND breach inside one deadline window.
    // The scoped deadline prunes any unit that can't reach the door in time *during
    // search* (projected clock), so only those who can make the window commit.
    {
      name: "breachAssault",
      task: "Fight",
      params: [{ name: "bp", type: "cover" }],
      pre: F.and(F.lit("tactic", [], "breach"), F.lit("coverBreach", ["?bp"]), F.not(F.lit("coverTaken", ["?bp"]))),
      subtasks: [
        {
          scope: { deadline: BREACH_WINDOW, label: "breach-window" },
          subtasks: [{ do: "moveToBreach", args: ["?bp"] }, { do: "breach" }],
        },
        { do: "Neutralize" },
      ],
    },
    // 3. assigned flanker → take a flank cover, then neutralize from there
    {
      name: "flankAttack",
      task: "Fight",
      params: [{ name: "fc", type: "cover" }],
      pre: F.and(F.lit("role", [], "flanker"), F.lit("coverFlank", ["?fc"]), F.not(F.lit("coverTaken", ["?fc"]))),
      subtasks: [{ do: "flankTo", args: ["?fc"] }, { do: "Neutralize" }],
    },
    // 4. assigned suppressor → suppress UNTIL the flanker is in position, then push
    {
      name: "suppressCover",
      task: "Fight",
      pre: F.lit("role", [], "suppressor"),
      subtasks: [
        { scope: { maintain: F.not(F.lit("flankerReady")), label: "suppress-cover" }, subtasks: [{ do: "suppress" }] },
        { do: "Neutralize" },
      ],
    },
    // 5. no threat fix at all → stand by in short beats (reactively wakes on contact)
    {
      name: "idle",
      task: "Fight",
      pre: F.not(F.lit("hasThreat")),
      subtasks: [{ hold: 0.5 }],
    },
    // 6. default → neutralize the threat
    {
      name: "assault",
      task: "Fight",
      // while a breach is on, units commit to the breach (breachAssault) rather than
      // wandering toward a room cover they can't reach through the closed door
      pre: F.not(F.lit("tactic", [], "breach")),
      subtasks: [{ do: "Neutralize" }],
    },
    // 7. there's a threat but no firing solution right now (e.g. a defender behind
    // a closed door) → hold ready in short beats rather than fail; a changed world
    // (door breached, enemy steps into view) reactively wakes it.
    {
      name: "holdReady",
      task: "Fight",
      pre: F.lit("hasThreat"),
      subtasks: [{ hold: 0.4 }],
    },
    // --- Neutralize: reload if dry, fire if there's a line of sight, else
    // reposition to a cover that geometrically has one (the flank EMERGES from
    // method selection; short reactive plans, re-entered each beat).
    // Neutralize ENACTS the spot-graph route computed in perception. That search is a
    // bounded A*/Dijkstra over the discrete tactical-spot graph (≈two dozen nodes):
    // edges are walkable hops costed by travel + the danger of crossing, and each node
    // with a line of fire is a terminal costed by the whole engagement from there
    // (shots-to-kill × the per-shot exposure of that spot). It returns the min-cost
    // route to a killing position and we take its FIRST move — so the hop is chosen for
    // the whole-route optimum (it will step through a so-so covered spot now precisely
    // because that unlocks a much stronger angle next), which a greedy one-hop score
    // can't do. Re-solved each beat, so it adapts as the fight moves. Two outcomes:
    //   • engage from here (the route says this spot is already the best place), or
    //   • move to the route's next hop, then re-decide.
    {
      name: "engageHere",
      task: "Neutralize",
      pre: F.and(F.lit("hasThreat"), F.lit("engageHere"), F.ext("canSee", [], ["myPos", "threatPos"])),
      subtasks: [{ do: "engageFrom" }],
    },
    {
      name: "advanceRoute",
      task: "Neutralize",
      params: [{ name: "c", type: "cover" }],
      pre: F.and(F.lit("hasThreat"), F.ext("isChosen", ["?c"], ["chosenSpot"]), F.not(F.lit("coverTaken", ["?c"]))),
      subtasks: [{ do: "moveToSpot", args: ["?c"] }],
    },
    // ALTERNATE engine (useGoap): let the generic planner DISCOVER the move+engage
    // sequence itself, as a GOAP goal (threatHp ≤ 0). On its own this wanders — the
    // goal is numeric so the symbolic heuristic is blind to geometry — so the planner
    // is given a domain potential-field heuristic (customHeuristic) that estimates the
    // remaining cost to reach a firing position. THAT is what makes the search
    // goal-directed and fast. Selectable so it can be compared against the spot-graph
    // route; both produce fight-from-cover behaviour.
    {
      name: "neutralizeGoap",
      task: "Neutralize",
      pre: F.and(F.lit("useGoap"), F.lit("hasThreat")),
      subtasks: [{ achieve: F.lte(N.fl("threatHp"), N.c(0)) }],
    },
    // fallback: there's a threat but no actionable route right now (e.g. a defender
    // behind a closed door — you can't yet walk to any angle on them). Hold ready in
    // short beats rather than fail; a changed world (door breached, enemy steps out)
    // re-solves the route and wakes it. This also lets methods that embed Neutralize
    // (the breach assault) finish planning — the kill happens reactively once a line
    // of fire opens up.
    {
      name: "holdEngage",
      task: "Neutralize",
      pre: F.lit("hasThreat"),
      subtasks: [{ hold: 0.4 }],
    },
    // player order: fall back to a rally point (HTN — a direct decomposition, no
    // goal search; the `setGoals` seam routes "regroup" here)
    {
      name: "regroupTo",
      task: "Regroup",
      params: [{ name: "r", type: "cover" }],
      pre: F.and(F.lit("coverRally", ["?r"]), F.not(F.lit("coverTaken", ["?r"]))),
      utility: N.sub(N.c(0), N.dist("myPos", [], "coverPos", ["?r"])), // nearest rally
      // fall back to the rally, THEN hold and fight from there (defensive) rather
      // than sitting passively and getting overrun
      subtasks: [{ do: "retreatTo", args: ["?r"] }, { do: "Fight" }],
    },
  ],
};

// ---------------------------------------------------------------- tactical belief reads

/** The believed positions of every hostile this unit currently thinks is alive —
 *  read from belief (not ground truth), so reasoning is honest about what it knows. */
function believedFoes(q: ExtQuery, foes: string[]): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (const f of foes) {
    if (q.get("foeAlive", f) < 0.5) continue;
    const p = q.vec("foePos", f);
    out.push({ x: p[0], z: p[1] });
  }
  return out;
}

/** Whether a position has a line of fire to the believed primary threat. */
function spotHasLos(world: SquadWorld, x: number, z: number, t: number[]): boolean {
  if (x === t[0] && z === t[1]) return false;
  return world.losClear(x, z, t[0], t[1]) && dist2(x, z, t[0], t[1]) <= SIGHT_RANGE;
}

/** The risk/reward of standing at (sx,sz) to fight `threat`, with `foes` able to shoot
 *  you — the SAME cost the planner's spot search optimises, exposed so the view can
 *  paint the potential field. `cost` is the whole-engagement cost (shots-to-kill ×
 *  per-shot exposure); `firing` is false when the spot has no line of fire (cost ∞). */
export interface SpotEval {
  firing: boolean;
  exposure: number;
  cost: number;
}
export function evaluateSpot(world: SquadWorld, sx: number, sz: number, threat: { x: number; z: number }, foes: { x: number; z: number }[], caution = 1): SpotEval {
  const exposure = world.exposureAt(sx, sz, foes);
  if (!spotHasLos(world, sx, sz, [threat.x, threat.z])) return { firing: false, exposure, cost: Infinity };
  let hit = rangeFalloff(dist2(sx, sz, threat.x, threat.z));
  if (world.inCoverVs(threat.x, threat.z, sx, sz)) hit *= COVER_HIT_MULT;
  const shots = Math.max(1, Math.ceil(100 / (SHOT_DAMAGE * Math.max(0.12, hit))));
  return { firing: true, exposure, cost: shots * (1 + caution * W_EXPOSE * exposure) };
}

/**
 * Builds the DOMAIN potential-field heuristic for one unit's GOAP kill-search: an
 * estimate of the remaining cost to neutralize the threat from a given state. For each
 * firing position it sums travel (straight-line · W_MOVE ≤ the real walked path) and
 * the engagement from there (shots-to-kill × per-shot exposure), and takes the min.
 * Including exposure makes the field TIGHT, so A* heads straight to the cheapest
 * covered angle instead of wandering over equal-looking firing spots — the spatial
 * structure the symbolic relaxation is blind to.
 *
 * The field (which covers are firing positions, and the full engagement cost from
 * each) depends ONLY on the threat (position + HP), caution, and foe positions — all
 * constant within a search and slow-changing between ticks. So we MEMOIZE it by that
 * signature and rebuild only when the situation changes; the per-node work then
 * collapses to a cheap distance to each precomputed firing spot (plus one line-of-fire
 * check for the current position). That is what keeps the generic search's per-node
 * cost on par with the bespoke route's single Dijkstra. Deterministic.
 */
function makeEngageHeuristic(world: SquadWorld, model: Model, foeNames: string[]): (s: Snap) => number {
  const hasThreatSlot = model.slotOf("hasThreat");
  const hpSlot = model.slotOf("threatHp");
  const mypSlot = model.slotOf("myPos");
  const tpSlot = model.slotOf("threatPos");
  const cautionSlot = model.slotOf("caution");
  const foeSlots = foeNames.map((f) => ({ alive: model.slotOf("foeAlive", model.entityId(f)), pos: model.slotOf("foePos", model.entityId(f)) }));
  // cached field for the current situation
  let sig = "";
  let field: { x: number; z: number; engage: number }[] = [];
  let tx = 0;
  let tz = 0;
  let hp = 0;
  let caution = 0;
  let foes: { x: number; z: number }[] = [];
  const engageCostAt = (x: number, z: number): number => {
    let hit = rangeFalloff(dist2(x, z, tx, tz));
    if (world.inCoverVs(tx, tz, x, z)) hit *= COVER_HIT_MULT;
    const shots = Math.max(1, Math.ceil(hp / (SHOT_DAMAGE * Math.max(0.12, hit))));
    return shots * (1 + caution * W_EXPOSE * world.exposureAt(x, z, foes));
  };
  return (s: Snap): number => {
    if (s.get(hasThreatSlot) < 0.5) return 0;
    const curHp = s.get(hpSlot);
    if (curHp <= 0) return 0;
    const ctx = s.get(tpSlot);
    const ctz = s.get(tpSlot + 1);
    const ccaution = s.get(cautionSlot);
    let nsig = `${ctx},${ctz},${curHp},${ccaution}`;
    const cfoes: { x: number; z: number }[] = [];
    for (const fs of foeSlots) {
      if (s.get(fs.alive) < 0.5) continue;
      const fx = s.get(fs.pos);
      const fz = s.get(fs.pos + 1);
      cfoes.push({ x: fx, z: fz });
      nsig += `;${fx.toFixed(2)},${fz.toFixed(2)}`;
    }
    if (nsig !== sig) {
      // situation changed — rebuild the field once, then reuse it for every node
      sig = nsig;
      tx = ctx;
      tz = ctz;
      hp = curHp;
      caution = ccaution;
      foes = cfoes;
      field = [];
      const t = [tx, tz];
      for (const c of world.covers) if (spotHasLos(world, c.x, c.z, t)) field.push({ x: c.x, z: c.z, engage: engageCostAt(c.x, c.z) });
    }
    const mx = s.get(mypSlot);
    const mz = s.get(mypSlot + 1);
    let best = spotHasLos(world, mx, mz, [tx, tz]) ? engageCostAt(mx, mz) : Infinity; // engage from here
    for (const f of field) {
      const c = W_MOVE * dist2(mx, mz, f.x, f.z) + f.engage;
      if (c < best) best = c;
    }
    return best === Infinity ? 1e6 : best;
  };
}

// ---------------------------------------------------------------- registry / model per unit

function buildUnitModel(self: string, world: SquadWorld, inst: SquadInstance): Model {
  const entities: Record<string, string> = {};
  for (const c of inst.covers) entities[c.name] = "cover";
  const foes = world.foeNamesFor(self);
  for (const f of foes) entities[f] = "foe";
  return createModel(
    squadDomain,
    {
      entities,
      init: (w) => {
        for (const c of inst.covers) {
          w.set("coverPos", [c.name], [c.x, c.z]);
          if (c.flank) w.set("coverFlank", [c.name], true);
          if (c.high) w.set("coverHigh", [c.name], true);
          if (c.breach) w.set("coverBreach", [c.name], true);
          if (c.rally) w.set("coverRally", [c.name], true);
        }
        const me = world.actors.get(self);
        if (me) {
          w.set("myPos", [], [me.x, me.z]);
          w.set("myHp", [], me.hp);
          w.set("myAmmo", [], me.ammo);
        }
      },
    },
    {
      predicates: {
        // line of sight from my believed position to the threat's believed position
        canSee: (q) => {
          const m = q.vec("myPos");
          const t = q.vec("threatPos");
          if (m[0] === t[0] && m[1] === t[1]) return false; // no threat fix yet
          return world.losClear(m[0], m[1], t[0], t[1]) && dist2(m[0], m[1], t[0], t[1]) <= SIGHT_RANGE;
        },
        // would cover `c` have a line of fire to the threat? This is what lets the
        // flank EMERGE: method selection picks a cover that geometrically sees the
        // target, rather than searching deep over move+shoot combinations.
        coverSeesThreat: (q) => {
          const c = q.vec("coverPos", q.args[0]);
          const t = q.vec("threatPos");
          if (c[0] === t[0] && c[1] === t[1]) return false;
          return world.losClear(c[0], c[1], t[0], t[1]) && dist2(c[0], c[1], t[0], t[1]) <= SIGHT_RANGE;
        },
        // Is `c` the next hop the spot-graph route chose this beat? (entities encode as
        // gid+1; chosenSpot holds that, 0 = none.) Lets the planner bind the route's
        // chosen spot as the move target while staying a normal precondition.
        isChosen: (q) => Math.round(q.get("chosenSpot")) === q.args[0] + 1,
      },
      numerics: {
        coverX: (q) => q.vec("coverPos", q.args[0])[0],
        coverZ: (q) => q.vec("coverPos", q.args[0])[1],
        // expected damage of a shot from myPos at the believed threat — range falloff
        // plus the target's cover relative to me. Drives "close in / break their cover".
        shotDamage: (q) => {
          const m = q.vec("myPos");
          const t = q.vec("threatPos");
          let p = rangeFalloff(dist2(m[0], m[1], t[0], t[1]));
          if (world.inCoverVs(t[0], t[1], m[0], m[1])) p *= COVER_HIT_MULT;
          return SHOT_DAMAGE * Math.max(0.12, p);
        },
        // --- tactical costs (used by operator costs + the spot-graph route) ---
        // how exposed I am RIGHT NOW — makes firing from the open costly in takeShot
        myExposure: (q) => {
          const m = q.vec("myPos");
          return world.exposureAt(m[0], m[1], believedFoes(q, foes));
        },
        // danger of CROSSING to a spot (sampled along the straight approach) — this is
        // what makes a staged route through cover beat a direct dash over open ground
        pathExposure: (q) => {
          const m = q.vec("myPos");
          const c = q.vec("coverPos", q.args[0]);
          const fb = believedFoes(q, foes);
          let e = 0;
          for (const t of [0.34, 0.67]) e += world.exposureAt(m[0] + (c[0] - m[0]) * t, m[1] + (c[1] - m[1]) * t, fb);
          return e * 0.5;
        },
        // cost for a spot being beyond comfortable firing range of the threat
        spotRange: (q) => {
          const c = q.vec("coverPos", q.args[0]);
          const t = q.vec("threatPos");
          return Math.max(0, dist2(c[0], c[1], t[0], t[1]) - IDEAL_RANGE);
        },
        // the WHOLE-engagement cost of fighting the threat from my current position:
        // shots-to-kill (range + the target's cover decide damage/shot) × the per-shot
        // danger of standing here (1 + every enemy that can shoot me). This is the lever
        // the kill-search optimises — exposed positions are dear over a full firefight.
        engageCost: (q) => {
          const m = q.vec("myPos");
          const t = q.vec("threatPos");
          let p = rangeFalloff(dist2(m[0], m[1], t[0], t[1]));
          if (world.inCoverVs(t[0], t[1], m[0], m[1])) p *= COVER_HIT_MULT;
          const dmg = SHOT_DAMAGE * Math.max(0.12, p);
          const shots = Math.max(1, Math.ceil(q.get("threatHp") / dmg));
          const exposure = world.exposureAt(m[0], m[1], believedFoes(q, foes));
          return shots * (1 + q.get("caution") * W_EXPOSE * exposure);
        },
        // projected duration of that engagement (shots-to-kill × aim time), so a scoped
        // deadline or a racing flanker is reasoned about over the real firefight length
        engageDur: (q) => {
          const m = q.vec("myPos");
          const t = q.vec("threatPos");
          let p = rangeFalloff(dist2(m[0], m[1], t[0], t[1]));
          if (world.inCoverVs(t[0], t[1], m[0], m[1])) p *= COVER_HIT_MULT;
          const dmg = SHOT_DAMAGE * Math.max(0.12, p);
          return Math.max(1, Math.ceil(q.get("threatHp") / dmg)) * SHOT_TIME;
        },
      },
      executors: {
        move: moveExecutor(self, world),
        shoot: shootExecutor(self, world),
        engage: engageExecutor(self, world),
        suppress: suppressExecutor(self, world),
        breach: breachExecutor(self, world),
        reload: reloadExecutor(self, world),
      },
    },
  );
}

// ---------------------------------------------------------------- executors (enact on the world)

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}

function moveExecutor(self: string, world: SquadWorld): (api: ExecutorApi) => TaskStatus {
  return (api) => {
    const a = world.actors.get(self);
    if (!a || !a.alive) return "failure";
    const coverName = api.model.entityName(api.args[0]);
    const cover = world.coverByName.get(coverName);
    if (!cover) return "failure";
    const mem = api.remember(() => {
      // commit the reservation the instant the move starts (so rivals replan away)
      world.claimCover(self, coverName);
      // route AROUND obstacles (so units don't walk through walls)
      return { path: [{ x: a.x, z: a.z }, ...world.findPath(a.x, a.z, cover.x, cover.z)], t0: api.clock() };
    }) as { path: Vec2[]; t0: number };
    const traveled = (api.clock() - mem.t0) * MOVE_SPEED;
    const at = walkPolyline(mem.path, traveled);
    a.x = at.x;
    a.z = at.z;
    a.elevation = cover.high ? 1 : 0;
    if (at.done) {
      a.x = cover.x;
      a.z = cover.z;
      if (cover.flank) world.team(a.side).flankerReady = true; // flanker reached position
      return "success";
    }
    return "continue";
  };
}

function shootExecutor(self: string, world: SquadWorld): (api: ExecutorApi) => TaskStatus {
  return (api) => {
    const a = world.actors.get(self);
    if (!a || !a.alive) return "failure";
    const target = world.nearestHostile(self, true);
    if (!target) return "failure"; // lost line of sight → repair
    if (api.elapsedInStep() < SHOT_TIME) return "continue"; // aiming
    a.ammo = Math.max(0, a.ammo - 1);
    // roll the seeded RNG against the real hit chance (range + the target's cover):
    // a covered or distant target is often missed, so position genuinely matters.
    if (api.rng.next() < world.hitChance(a, target)) {
      target.hp = Math.max(0, target.hp - SHOT_DAMAGE);
      if (target.hp <= 0) target.alive = false;
    }
    return "success";
  };
}

function engageExecutor(self: string, world: SquadWorld): (api: ExecutorApi) => TaskStatus {
  return (api) => {
    const a = world.actors.get(self);
    if (!a || !a.alive) return "failure";
    const target = world.nearestHostile(self, true);
    if (!target) return "failure"; // lost the line of fire → repair / re-search a position
    const mem = api.remember(() => ({ next: 0, reloadAt: -1 })) as { next: number; reloadAt: number };
    const el = api.elapsedInStep();
    // out of ammo → reload, then hand back so the unit re-reads the room with a fresh mag
    if (a.ammo <= 0 && mem.reloadAt < 0) mem.reloadAt = el;
    if (mem.reloadAt >= 0) {
      if (el - mem.reloadAt < RELOAD_TIME) return "continue";
      a.ammo = AMMO_MAX;
      return "success";
    }
    if (el >= mem.next) {
      a.ammo -= 1;
      mem.next = el + SHOT_TIME;
      if (api.rng.next() < world.hitChance(a, target)) {
        target.hp = Math.max(0, target.hp - SHOT_DAMAGE);
        if (target.hp <= 0) {
          target.alive = false;
          return "success"; // threat down — the goal is met
        }
      }
    }
    return "continue"; // keep firing this magazine
  };
}

function suppressExecutor(self: string, world: SquadWorld): (api: ExecutorApi) => TaskStatus {
  return (api) => {
    const a = world.actors.get(self);
    if (!a || !a.alive) return "failure";
    const target = world.nearestHostile(self, true);
    if (!target) return "failure"; // lost line of sight → repair
    // sustain suppressing fire at a controlled rate; this keeps the
    // `suppress-cover` scope active so it can be interrupted the instant the
    // flanker reaches position (scope.violated{maintain}) — the F.E.A.R. beat.
    const mem = api.remember(() => ({ nextShot: 0 })) as { nextShot: number };
    if (api.elapsedInStep() >= mem.nextShot && a.ammo > 0) {
      a.ammo -= 1;
      mem.nextShot += 0.4;
      target.suppressedFor = 1.0; // pinned
      target.hp = Math.max(0, target.hp - SUPPRESS_DAMAGE * api.rng.next());
    }
    if (world.team(a.side).flankerReady || a.ammo <= 0 || api.elapsedInStep() > SUPPRESS_MAX) return "success";
    return "continue";
  };
}

function breachExecutor(self: string, world: SquadWorld): (api: ExecutorApi) => TaskStatus {
  return (api) => {
    const a = world.actors.get(self);
    if (!a || !a.alive) return "failure";
    // emergent synchronization: the first unit to reach the door HOLDS (weapon
    // ready) until the whole fire-team has stacked, so they breach + flow in
    // together rather than one going alone under fire. A short cap means a lone
    // survivor still breaches.
    const team = [...world.actors.values()].filter((x) => x.alive && x.side === a.side);
    const atDoor = (x: Actor) => {
      const c = x.cover ? world.coverByName.get(x.cover) : undefined;
      return !!(c && c.breach && dist2(x.x, x.z, c.x, c.z) < 0.9);
    };
    if (!world.doorBroken && !team.every(atDoor) && api.elapsedInStep() < 2.5) return "continue";
    world.doorBroken = true; // the door is down — sight + movement open into the room
    const target = world.nearestHostile(self, false);
    if (target) {
      target.hp = Math.max(0, target.hp - SHOT_DAMAGE);
      if (target.hp <= 0) target.alive = false;
    }
    world.team(a.side).breached = true;
    return "success";
  };
}

function reloadExecutor(self: string, world: SquadWorld): (api: ExecutorApi) => TaskStatus {
  return (api) => {
    const a = world.actors.get(self);
    if (!a || !a.alive) return "failure";
    if (api.elapsedInStep() < RELOAD_TIME) return "continue";
    a.ammo = AMMO_MAX;
    return "success";
  };
}

// ---------------------------------------------------------------- belief write helpers

function setBelief(p: UnitPlanner, fluent: string, args: (string | number)[], value: number | string | boolean): void {
  const gids = args.map((x) => (typeof x === "string" ? p.model.entityId(x) : x));
  p.planner.state.set(p.model.slotOf(fluent, ...gids), p.model.encodeValue(fluent, value));
}

function setBeliefVec(p: UnitPlanner, fluent: string, x: number, z: number): void {
  const slot = p.model.slotOf(fluent);
  p.planner.state.set(slot, x);
  p.planner.state.set(slot + 1, z);
}

function setBeliefVecArgs(p: UnitPlanner, fluent: string, args: (string | number)[], x: number, z: number): void {
  const gids = args.map((a) => (typeof a === "string" ? p.model.entityId(a) : a));
  const slot = p.model.slotOf(fluent, ...gids);
  p.planner.state.set(slot, x);
  p.planner.state.set(slot + 1, z);
}

// ---------------------------------------------------------------- unit planner wrapper

export interface UnitPlanner {
  name: string;
  side: Side;
  role: Role;
  model: Model;
  planner: PlannerT;
  lastSeen: number;
  /** the static set of this unit's possible foes (hostile actor names) */
  foes: string[];
  /** per-foe clock of the last time this unit had a clear line of sight to it */
  foeLastSeen: Map<string, number>;
  trace: TraceEvent[];
  /** most recent "why a branch was rejected" reasons (glass-box director, E3) */
  why: string[];
  /** the unit's current goal, in plain words + how the library expresses it */
  goalText: string;
  goalExpr: string;
  /** this unit's positioning engine (resolved from SquadSimOptions.positioning) */
  mode: "spotgraph" | "goap";
}

const DEFAULT_GOAL = { text: "Win the firefight — neutralize the enemy squad", expr: 'task("Fight")' };

// ---------------------------------------------------------------- the sim

export interface UnitFrame {
  name: string;
  side: Side;
  role: Role;
  x: number;
  z: number;
  hp: number;
  ammo: number;
  alive: boolean;
  elevation: number;
  cover: string | null;
  /** label of the step currently executing (drives the bark) */
  step: string;
  /** a clear, human-readable verb for what the unit is doing right now */
  action: string;
  bark: string;
  /** the unit this one is currently firing on (beam target), if any */
  firingAt: string | null;
  firingKind: "shot" | "suppress" | "breach" | null;
  /** the hostile this unit currently has a line of sight to (sight line) */
  sees: string | null;
  tactic: string;
  status: string;
  /** the unit's current goal in plain words + the library form (glass-box director) */
  goalText: string;
  goalExpr: string;
  /** the plan was just invalidated and is being recomputed */
  replanning: boolean;
  /** the unit's current plan, as readable step labels (glass-box director) */
  plan: string[];
  /** recent trace event kinds (glass-box director) */
  events: string[];
  /** most recent "why a branch was rejected" reasons (glass-box director) */
  why: string[];
  /** plain-English read of the unit's current tactical posture (glass-box director):
   *  whether it is in cover, how many enemies can shoot it, and its range to the threat */
  posture: string;
  /** the unit's BELIEVED primary threat position (null when it knows of no threat) —
   *  what it scores spots against, for a belief-honest heatmap */
  believedThreat: { x: number; z: number } | null;
  /** the unit's BELIEVED positions of foes it thinks are alive */
  believedFoes: { x: number; z: number }[];
}

export interface TeamFrame {
  side: Side;
  /** current squad tactic of this team */
  tactic: string;
  flankerReady: boolean;
  alive: number;
  total: number;
}

export interface SquadFrame {
  clock: number;
  units: UnitFrame[];
  /** per-team coordination state (each side is its own squad) */
  teams: TeamFrame[];
  /** cover name → owner unit (for the view) */
  reservations: Record<string, string | null>;
  /** the breach door has been broken open (E4) */
  doorBroken: boolean;
}

export interface SquadSimOptions {
  seed?: number;
  /** fixed sim timestep in seconds (deterministic offline rollout) */
  dt?: number;
  /** per-unit planning node budget per tick */
  nodes?: number;
  /** override the bark author (the LLM-rewrite seam, Phase D); defaults to `barkFor` */
  bark?: BarkAuthor;
  /** positioning engine: "spotgraph" (bespoke route search, default) or "goap" (the
   *  generic planner search over move+engage, guided by a domain potential-field
   *  heuristic). A `(side) => mode` function selects per side, so the two engines can
   *  be pitted head-to-head. Exposed to compare the two approaches. */
  positioning?: "spotgraph" | "goap" | ((side: Side) => "spotgraph" | "goap");
}

/**
 * Headless, deterministic squad-combat simulation. Drives one real reactive
 * Planner per AI unit over a shared world, with a perception step and a squad
 * coordinator between ticks. Used verbatim by tests and the web preview.
 */
export class SquadSim {
  public readonly world: SquadWorld;
  public readonly units: UnitPlanner[] = [];
  public readonly trace: { unit: string; e: TraceEvent }[] = [];
  private readonly inst: SquadInstance;
  private readonly dt: number;
  private readonly nodes: number;
  private readonly barkAuthor: BarkAuthor;
  /** positioning engine ("mixed" when chosen per-side) — see SquadSimOptions.positioning */
  public readonly positioning: "spotgraph" | "goap" | "mixed";
  /** the invisible tactical standing positions the planner chooses among (grid + cover
   *  edges) — the discrete candidate set the spot search/route scores each beat. The
   *  view renders these so you can watch which the planner considers and picks. */
  public readonly spots: { name: string; x: number; z: number }[];
  private readonly modeOf: (side: Side) => "spotgraph" | "goap";
  private playerLeg = 0;
  private playerLegT = 0;

  constructor(inst: SquadInstance, opts: SquadSimOptions = {}) {
    this.inst = inst;
    this.dt = opts.dt ?? 0.1;
    this.nodes = opts.nodes ?? 60_000;
    this.barkAuthor = opts.bark ?? barkFor;
    const pos = opts.positioning ?? "spotgraph";
    this.modeOf = typeof pos === "function" ? pos : () => pos;
    this.positioning = typeof pos === "function" ? "mixed" : pos;
    // augment the map with invisible tactical standing positions (grid + cover edges)
    // the planner can reposition to — fluid movement, not a handful of waypoints
    const tacticalSpots = generateTacticalSpots(inst);
    this.spots = tacticalSpots.map((c) => ({ name: c.name, x: c.x, z: c.z }));
    const augmented: SquadInstance = { ...inst, covers: [...inst.covers, ...tacticalSpots] };
    this.world = new SquadWorld(augmented);
    if (inst.breach) this.world.team("enemy").tactic = "breach"; // the attacking team breaches
    let seedBump = 0;
    for (const u of inst.units) {
      if (u.side === "player") continue;
      const model = buildUnitModel(u.name, this.world, augmented);
      const trace: TraceEvent[] = [];
      const entry: UnitPlanner = {
        name: u.name,
        side: u.side,
        role: u.role ?? "assault",
        model,
        planner: undefined as unknown as PlannerT,
        lastSeen: -Infinity,
        foes: this.world.foeNamesFor(u.name),
        foeLastSeen: new Map(),
        trace,
        why: [],
        goalText: DEFAULT_GOAL.text,
        goalExpr: DEFAULT_GOAL.expr,
        mode: this.modeOf(u.side),
      };
      const goap = entry.mode === "goap";
      entry.planner = new Planner(model, {
        goals: [{ kind: "task", name: "Fight" }],
        now: () => this.world.clock,
        seed: (opts.seed ?? 1) + seedBump++,
        // GOAP mode runs greedier (higher weight) with a tight node cap so the generic
        // search satisfices fast; if it ever hits the cap, holdEngage covers the beat.
        weight: goap ? 2.6 : 1.6,
        maxNodes: goap ? 4000 : undefined,
        collectRejections: true,
        // GOAP mode: feed the generic search the spatial potential-field heuristic so
        // it stays goal-directed instead of wandering over the fine move space.
        customHeuristic: goap ? makeEngageHeuristic(this.world, model, entry.foes) : undefined,
        // the kill goal is time-independent (no deadline), so collapse positions that
        // differ only in elapsed clock — turns the move search from combinatorial into
        // ~a Dijkstra over positions.
        spatialDedup: goap,
        trace: (e) => {
          trace.push(e);
          this.trace.push({ unit: entry.name, e });
          if (e.t === "plan.failed" && e.rejections) entry.why = summarizeRejections(e.rejections);
        },
      });
      this.units.push(entry);
    }
  }

  // ---- perception: world (truth) → each unit's ExecState (belief) ----
  private perceive(p: UnitPlanner): void {
    const a = this.world.actors.get(p.name);
    if (!a) return;
    setBeliefVec(p, "myPos", a.x, a.z);
    setBelief(p, "myAmmo", [], a.ammo);
    setBelief(p, "myHp", [], a.hp);
    // sight: a clear line of fire — sets the believed position AND lets us shoot.
    const seen = this.world.nearestHostile(p.name, true);
    // hearing/comms: in range but behind cover — we know roughly WHERE (so we can
    // flank toward it) but can't yet fire. This is what makes the flank emerge.
    const heard = seen ?? this.world.nearestHostile(p.name, false);
    if (seen) {
      p.lastSeen = this.world.clock;
      setBelief(p, "threatSeen", [], true);
    } else if (this.world.clock - p.lastSeen > MEMORY_SECONDS) {
      setBelief(p, "threatSeen", [], false); // forget — fall back to searching last-known
    }
    if (heard) {
      setBeliefVec(p, "threatPos", heard.x, heard.z);
      setBelief(p, "threatHp", [], heard.hp);
    }
    setBelief(p, "hasThreat", [], !!heard);
    // per-foe belief: track every known hostile individually (drives exposure/cover).
    // LOS now → write truth; recently lost → keep last fix but mark unseen; long lost
    // → drop it (you stop dodging someone you've lost track of).
    for (const fname of p.foes) {
      const fa = this.world.actors.get(fname);
      if (!fa) continue;
      const los = fa.alive && dist2(a.x, a.z, fa.x, fa.z) <= SIGHT_RANGE && this.world.losClear(a.x, a.z, fa.x, fa.z);
      if (los) {
        p.foeLastSeen.set(fname, this.world.clock);
        setBeliefVecArgs(p, "foePos", [fname], fa.x, fa.z);
        setBelief(p, "foeAlive", [fname], fa.alive);
        setBelief(p, "foeSeen", [fname], true);
      } else {
        setBelief(p, "foeSeen", [fname], false);
        const lost = this.world.clock - (p.foeLastSeen.get(fname) ?? -Infinity);
        if (!fa.alive || lost > MEMORY_SECONDS) setBelief(p, "foeAlive", [fname], false);
      }
    }
    setBelief(p, "myCover", [], a.cover ?? false); // reconcile claimed cover (for the regroup goal)
    for (const c of this.world.covers) {
      const owner = this.world.coverOwner.get(c.name) ?? null;
      setBelief(p, "coverTaken", [c.name], owner !== null && owner !== p.name);
    }
    setBelief(p, "flankerReady", [], this.world.team(p.side).flankerReady);
    setBelief(p, "useGoap", [], p.mode === "goap");
    if (p.mode === "goap") {
      // GOAP mode: the planner's own search (guided by the heuristic) decides — clear
      // the spot-graph route beliefs so its methods stay inactive.
      setBelief(p, "engageHere", [], false);
      setBelief(p, "chosenSpot", [], false);
    } else {
      // the DEEP decision: solve the spot-graph route from belief and write the result
      // the planner enacts this beat (engage from here, or the next hop toward the
      // optimal killing position).
      const route = this.computeEngageRoute(p);
      setBelief(p, "engageHere", [], route.engageHere);
      setBelief(p, "chosenSpot", [], route.nextSpot ?? false);
    }
  }

  /** Believed positions of every hostile this unit currently thinks is alive (belief,
   *  not ground truth) — the foes the route reasons about for exposure/cover. */
  private believedFoePositions(p: UnitPlanner): { x: number; z: number }[] {
    const out: { x: number; z: number }[] = [];
    for (const f of p.foes) {
      const fid = p.model.entityId(f);
      if (p.planner.state.get(p.model.slotOf("foeAlive", fid)) < 0.5) continue;
      const ps = p.model.slotOf("foePos", fid);
      out.push({ x: p.planner.state.get(ps), z: p.planner.state.get(ps + 1) });
    }
    return out;
  }

  /**
   * The spot-graph search — the genuinely deep, emergent positioning. Over the
   * discrete graph of tactical positions (current spot + every cover/edge/grid spot
   * not reserved by someone else), a Dijkstra finds the minimum-cost route to a
   * KILLING position, where:
   *   • a hop i→j costs travel (W_MOVE·dist) + the danger of crossing it
   *     (W_PATH_EXPOSE · exposure sampled along the straight, walkable leg), and
   *   • each node with a line of fire is a terminal costing the whole engagement from
   *     there: shots-to-kill × (1 + caution·W_EXPOSE·exposure) — cover and range fold
   *     in via shots-to-kill and exposure.
   * It returns the FIRST hop of the optimal route (or "engage here" when staying put
   * is the cheapest terminal). Because the whole route is costed, it will deliberately
   * stage through a weaker covered spot when that unlocks a far better angle — the
   * multi-step, non-greedy behaviour a one-hop score misses. Bounded (~two dozen
   * nodes) so it is fast and deterministic, re-solved every beat.
   */
  private computeEngageRoute(p: UnitPlanner): { engageHere: boolean; nextSpot: string | null } {
    const me = this.world.actors.get(p.name);
    const st = p.planner.state;
    const none = { engageHere: false, nextSpot: null };
    if (!me || st.get(p.model.slotOf("hasThreat")) < 0.5) return none;
    const tp = p.model.slotOf("threatPos");
    const threat = { x: st.get(tp), z: st.get(tp + 1) };
    const threatHp = st.get(p.model.slotOf("threatHp"));
    const caution = st.get(p.model.slotOf("caution"));
    const foes = this.believedFoePositions(p);
    const w = this.world;

    // nodes: my current position (index 0) + every available cover/spot
    const nodes: { x: number; z: number; name: string | null }[] = [{ x: me.x, z: me.z, name: null }];
    for (const c of w.covers) {
      const owner = w.coverOwner.get(c.name);
      if (owner && owner !== p.name) continue; // someone else holds it — not a candidate
      nodes.push({ x: c.x, z: c.z, name: c.name });
    }
    const n = nodes.length;
    const crossExposure = (a: { x: number; z: number }, b: { x: number; z: number }): number => {
      let e = 0;
      for (const k of [0.34, 0.67]) e += w.exposureAt(a.x + (b.x - a.x) * k, a.z + (b.z - a.z) * k, foes);
      return e * 0.5;
    };
    // Dijkstra over straight walkable hops (the move executor pathfinds within a hop;
    // routes around walls emerge by stepping through corner/edge spots)
    const dist = new Array<number>(n).fill(Infinity);
    const prev = new Array<number>(n).fill(-1);
    const done = new Array<boolean>(n).fill(false);
    dist[0] = 0;
    for (let it = 0; it < n; it++) {
      let u = -1;
      let best = Infinity;
      for (let k = 0; k < n; k++) if (!done[k] && dist[k] < best) { best = dist[k]; u = k; }
      if (u < 0) break;
      done[u] = true;
      for (let v = 0; v < n; v++) {
        if (v === u || done[v]) continue;
        if (!w.losClear(nodes[u].x, nodes[u].z, nodes[v].x, nodes[v].z)) continue; // not a straight walkable hop
        const step = W_MOVE * dist2(nodes[u].x, nodes[u].z, nodes[v].x, nodes[v].z) + W_PATH_EXPOSE * crossExposure(nodes[u], nodes[v]);
        if (dist[u] + step < dist[v]) { dist[v] = dist[u] + step; prev[v] = u; }
      }
    }
    // pick the cheapest KILLING terminal: route cost to a node with a line of fire +
    // the whole-engagement cost from it
    const engageCostAt = (node: { x: number; z: number }): number => {
      let hit = rangeFalloff(dist2(node.x, node.z, threat.x, threat.z));
      if (w.inCoverVs(threat.x, threat.z, node.x, node.z)) hit *= COVER_HIT_MULT;
      const dmg = SHOT_DAMAGE * Math.max(0.12, hit);
      const shots = Math.max(1, Math.ceil(threatHp / dmg));
      return shots * (1 + caution * W_EXPOSE * w.exposureAt(node.x, node.z, foes));
    };
    let bestNode = -1;
    let bestTotal = Infinity;
    for (let i = 0; i < n; i++) {
      if (dist[i] === Infinity) continue;
      if (!spotHasLos(w, nodes[i].x, nodes[i].z, [threat.x, threat.z])) continue; // not a firing position
      const total = dist[i] + engageCostAt(nodes[i]);
      if (total < bestTotal) { bestTotal = total; bestNode = i; }
    }
    if (bestNode < 0) return none; // no reachable line of fire (boxed in) → hold
    if (bestNode === 0) return { engageHere: true, nextSpot: null }; // here IS the best place
    // walk the route back to the first hop out of the current node
    let cur = bestNode;
    while (prev[cur] !== 0 && prev[cur] !== -1) cur = prev[cur];
    return { engageHere: false, nextSpot: nodes[cur].name };
  }

  /** a fallen unit releases its cover reservation (so the slot frees up). */
  private reapDead(): void {
    for (const a of this.world.actors.values()) {
      if (a.alive) continue;
      for (const [c, owner] of this.world.coverOwner) if (owner === a.name) this.world.coverOwner.set(c, null);
      a.cover = null;
    }
  }

  /**
   * Issue a player order to a unit — the `setGoals` seam (a stand-in for an LLM
   * goal selector). The companion ally otherwise auto-assists; a command swaps its
   * active goal, which the reactive planner picks up on the next tick.
   */
  command(unit: string, order: "engage" | "regroup" | "holdFire"): void {
    const p = this.units.find((u) => u.name === unit);
    if (!p) return;
    if (order === "regroup") {
      p.planner.setGoals([{ kind: "task", name: "Regroup" }]);
      p.goalText = "Regroup — fall back to the nearest rally";
      p.goalExpr = 'task("Regroup")';
    } else if (order === "holdFire") {
      p.planner.setGoals([]); // stand down
      p.goalText = "Hold fire — stand down";
      p.goalExpr = "goals: [] (idle)";
    } else {
      p.planner.setGoals([{ kind: "task", name: "Fight" }]);
      p.goalText = DEFAULT_GOAL.text;
      p.goalExpr = DEFAULT_GOAL.expr;
    }
  }

  // ---- the squad coordinator: assigns roles/tactic into each unit's belief ----
  /** Each team coordinates its OWN squad independently (no cross-team memory). */
  private coordinate(): void {
    const sides = [...new Set(this.units.map((u) => u.side))];
    for (const side of sides) {
      const members = this.units.filter((u) => u.side === side && (this.world.actors.get(u.name)?.alive ?? false));
      const tb = this.world.team(side);
      // a breach opening ends once the door is cleared, then it's a standing fight
      if (tb.tactic === "breach" && tb.breached) tb.tactic = "hold";
      const inContact = members.filter((u) => this.world.nearestHostile(u.name, true));
      if (tb.tactic !== "breach") {
        if (inContact.length >= 2) {
          // two-or-more in contact → coordinated flank: one suppresses, one flanks
          tb.tactic = "flank";
          members.forEach((u, i) => {
            u.role = i === 0 ? "suppressor" : i === 1 ? "flanker" : "assault";
          });
        } else {
          // not enough to coordinate (e.g. a lone survivor) → drop the roles and
          // just assault decisively, rather than keep chasing a flank
          if (tb.tactic === "flank") tb.tactic = "hold";
          for (const u of members) u.role = "assault";
        }
      }
      // flankerReady is set by the flanker reaching its flank cover; clear it when
      // the team isn't flanking so a stale flag doesn't linger
      if (tb.tactic !== "flank") tb.flankerReady = false;
      for (const u of members) {
        setBelief(u, "role", [], u.role);
        setBelief(u, "tactic", [], tb.tactic === "breach" ? "breach" : tb.tactic === "flank" ? "flank" : "hold");
        // caution: value safety more when locally outgunned (this unit sees more foes
        // than it has friends in the fight) or hurt — so it leans to cover / breaking
        // contact rather than trading shots. This is the "outnumbered ⇒ go to ground".
        const me = this.world.actors.get(u.name);
        const seenFoes = me ? this.world.hostilesOf(u.side).filter((h) => dist2(me.x, me.z, h.x, h.z) <= SIGHT_RANGE && this.world.losClear(me.x, me.z, h.x, h.z)).length : 0;
        const outgunned = seenFoes > members.length;
        const hurt = (me?.hp ?? 100) < LOW_HP;
        setBelief(u, "caution", [], 1 + (outgunned ? 0.9 : 0) + (hurt ? 0.7 : 0));
      }
    }
  }

  // ---- the scripted player avatar (a moving threat the NPCs react to) ----
  private movePlayer(): void {
    const path = this.inst.playerPath;
    const player = [...this.world.actors.values()].find((a) => a.side === "player");
    if (!player || !path || path.length === 0) return;
    if (this.playerLeg >= path.length - 1) {
      const last = path[path.length - 1];
      player.x = last.x;
      player.z = last.z;
      return;
    }
    const from = path[this.playerLeg];
    const to = path[this.playerLeg + 1];
    const legLen = Math.max(0.001, dist2(from.x, from.z, to.x, to.z));
    this.playerLegT += (MOVE_SPEED * 0.6 * this.dt) / legLen;
    if (this.playerLegT >= 1) {
      this.playerLegT = 0;
      this.playerLeg += 1;
      player.x = to.x;
      player.z = to.z;
    } else {
      player.x = lerp(from.x, to.x, this.playerLegT);
      player.z = lerp(from.z, to.z, this.playerLegT);
    }
  }

  /** advance the world one fixed step and return a snapshot. */
  step(): SquadFrame {
    this.world.clock += this.dt;
    // decay suppression
    for (const a of this.world.actors.values()) a.suppressedFor = Math.max(0, a.suppressedFor - this.dt);
    this.movePlayer();
    this.coordinate();
    // perceive + plan each unit in turn — perceiving right before the tick means a
    // later unit sees an earlier one's just-made cover claim, so there's no
    // reservation race (clean stacking at the door, clean cover splits)
    for (const p of this.units) {
      if (!(this.world.actors.get(p.name)?.alive ?? false)) continue;
      this.perceive(p);
      p.planner.tick({ nodes: this.nodes });
    }
    this.reapDead();
    this.emitBarks();
    return this.snapshot();
  }

  private emitBarks(): void {
    for (const p of this.units) {
      const recent = p.trace.slice(-6);
      for (const e of recent) {
        const text = this.barkAuthor(e, p.name);
        if (text) this.world.bark(p.name, text);
      }
    }
  }

  snapshot(): SquadFrame {
    const sides = [...new Set(this.units.map((u) => u.side))];
    const teams: TeamFrame[] = sides.map((side) => {
      const all = [...this.world.actors.values()].filter((a) => a.side === side);
      const tb = this.world.team(side);
      return { side, tactic: tb.tactic, flankerReady: tb.flankerReady, alive: all.filter((a) => a.alive).length, total: all.length };
    });
    return {
      clock: round(this.world.clock),
      teams,
      doorBroken: this.world.doorBroken,
      reservations: Object.fromEntries(this.world.coverOwner),
      units: [...this.world.actors.values()].map((a) => {
        const up = this.units.find((u) => u.name === a.name);
        const step = up?.planner.currentStep();
        const stepLabel = step && step.k === "op" ? up!.model.describeGroundOp(step.g) : step ? step.k : "—";
        const plan = up?.planner.getPlan();
        const status = up?.planner.getStatus() ?? "—";
        let firingAt: string | null = null;
        let firingKind: UnitFrame["firingKind"] = null;
        let sees: string | null = null;
        // the unit's BELIEF of where the enemy is — what it actually scores spots
        // against (vs ground truth), captured so the view can paint a belief-honest field
        let believedThreat: { x: number; z: number } | null = null;
        let believedFoes: { x: number; z: number }[] = [];
        if (up && a.alive) {
          sees = this.world.nearestHostile(a.name, true)?.name ?? null;
          if (stepLabel.startsWith("takeShot") || stepLabel.startsWith("engageFrom")) { firingKind = "shot"; firingAt = sees; }
          else if (stepLabel.startsWith("suppress")) { firingKind = "suppress"; firingAt = sees; }
          else if (stepLabel.startsWith("breach")) { firingKind = "breach"; firingAt = this.world.nearestHostile(a.name, false)?.name ?? null; }
          const st = up.planner.state;
          if (st.get(up.model.slotOf("hasThreat")) > 0.5) {
            const tp = up.model.slotOf("threatPos");
            believedThreat = { x: round(st.get(tp)), z: round(st.get(tp + 1)) };
          }
          believedFoes = this.believedFoePositions(up).map((f) => ({ x: round(f.x), z: round(f.z) }));
        }
        return {
          name: a.name,
          side: a.side,
          role: up?.role ?? "assault",
          x: round(a.x),
          z: round(a.z),
          hp: round(a.hp),
          ammo: a.ammo,
          alive: a.alive,
          elevation: a.elevation,
          cover: a.cover,
          step: stepLabel,
          action: up ? describeAction(stepLabel, status, a.alive, firingAt) : a.alive ? "target" : "down",
          bark: this.world.barks.get(a.name)?.text ?? "",
          firingAt,
          firingKind,
          sees,
          tactic: up ? this.world.team(a.side).tactic : "—",
          status,
          goalText: up ? up.goalText : "—",
          goalExpr: up ? up.goalExpr : "",
          replanning: up ? up.trace.slice(-3).some((e) => e.t === "replan.dirty" || e.t === "repair.attempt") || status === "planning" : false,
          plan: up && plan ? planSummary(up.model, plan) : [],
          events: up ? up.trace.slice(-6).map((e) => e.t) : [],
          why: up ? up.why : [],
          posture: up && a.alive ? this.describePosture(a) : "—",
          believedThreat,
          believedFoes,
        };
      }),
    };
  }

  /** A plain-English read of a unit's tactical posture for the glass-box director:
   *  in cover or open, how many enemies can actually shoot it, and its range. */
  private describePosture(a: Actor): string {
    const foes = this.world.hostilesOf(a.side).map((h) => ({ x: h.x, z: h.z }));
    const exposed = this.world.exposureAt(a.x, a.z, foes);
    const covered = this.world.coverCountAt(a.x, a.z, foes);
    const nearest = this.world.nearestHostile(a.name, false);
    const range = nearest ? Math.round(dist2(a.x, a.z, nearest.x, nearest.z)) : null;
    const head = covered > 0 ? `in cover vs ${covered}` : exposed > 0 ? "in the open" : "no line of fire";
    const exp = exposed > 0 ? ` · exposed to ${exposed}` : exposed === 0 && covered > 0 ? " · shielded" : "";
    return `${head}${exp}${range != null ? ` · range ${range}` : ""}`;
  }

  /** run the engagement to a terminal state (offline rollout for tests + web). */
  run(maxSteps = 600): SquadFrame[] {
    const frames: SquadFrame[] = [this.snapshot()];
    for (let i = 0; i < maxSteps; i++) {
      frames.push(this.step());
      if (this.engagementOver()) break;
    }
    return frames;
  }

  /** over when no living unit has any living hostile (one side wiped out). */
  engagementOver(): boolean {
    const alive = [...this.world.actors.values()].filter((a) => a.alive);
    return !alive.some((a) => alive.some((b) => (HOSTILE[a.side] ?? []).includes(b.side)));
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------- LLM-ready seams (Phase D)

/**
 * Phase D — typed seams where an LLM can later drive cognition over the planner's
 * *verified* actions (the NVIDIA-ACE pattern). No model calls in the slice; these
 * are the hook points, aligned with ROADMAP P3.
 *
 *  • GoalSelector — choose/score a unit's goals from a context. The symbolic
 *    stand-ins today are the SquadCoordinator (enemies) and SquadSim.command
 *    (the player, routed through Planner.setGoals). An LLM would slot in here,
 *    picking from goals the planner can *prove* reachable (applicableGoals).
 *  • BarkAuthor — turn a trace event into an utterance. `barkFor` is the default
 *    rule table; pass `SquadSimOptions.bark` to swap in a persona-driven rewriter.
 */
export interface GoalContext {
  unit: string;
  side: Side;
  role: Role;
  hp: number;
  hasThreat: boolean;
  squadTactic: string;
}
export type GoalSelector = (ctx: GoalContext) => GoalSpec[];
export type BarkAuthor = (e: TraceEvent, unit: string) => string | null;

/** Dedupe + cap rejection reasons for the glass-box "why not X" view. */
function summarizeRejections(rejections: Rejection[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rejections) {
    const key = `${r.at}: ${r.reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => (n > 1 ? `${k} (×${n})` : k));
}

/** A clear, human-readable verb for what a unit is doing right now (for the view). */
function describeAction(step: string, status: string, alive: boolean, firingAt: string | null): string {
  if (!alive) return "down";
  if (step.startsWith("takeShot") || step.startsWith("engageFrom")) return firingAt ? `firing on ${firingAt}` : "firing";
  if (step.startsWith("suppress")) return firingAt ? `suppressing ${firingAt}` : "suppressing";
  if (step.startsWith("flankTo")) return "flanking";
  if (step.startsWith("climbTo")) return "taking high ground";
  if (step.startsWith("moveToSpot")) return "repositioning to cover";
  if (step.startsWith("advanceTo")) return "moving to cover";
  if (step.startsWith("moveToBreach")) return "stacking on door";
  if (step.startsWith("breach")) return "breaching";
  if (step.startsWith("reload")) return "reloading";
  if (step.startsWith("retreatTo")) return "falling back";
  if (step === "wait" || step === "hold") return "holding";
  if (status === "planning") return "thinking…";
  if (status === "failed") return "looking for a shot";
  return "holding";
}

// ---------------------------------------------------------------- barks (trace → utterance)

/** Map a trace event to a combat bark — the seam an LLM later rewrites (BarkAuthor). */
export function barkFor(e: TraceEvent): string | null {
  if (e.t === "step.start") {
    if (e.label.startsWith("flankTo")) return "Flanking — moving!";
    if (e.label.startsWith("moveToSpot")) return "Repositioning — working the angle!";
    if (e.label.startsWith("advanceTo")) return "Moving up!";
    if (e.label.startsWith("climbTo")) return "Taking the high ground!";
    if (e.label.startsWith("moveToBreach")) return "Stacking up!";
    if (e.label.startsWith("breach")) return "Breaching — go go go!";
    if (e.label.startsWith("takeShot") || e.label.startsWith("engageFrom")) return "Engaging!";
    if (e.label.startsWith("suppress")) return "Suppressing — flank now!";
    if (e.label.startsWith("reload")) return "Reloading — cover me!";
    if (e.label.startsWith("retreatTo")) return "Falling back!";
  }
  if (e.t === "scope.enter" && e.label.includes("suppress")) return "Covering fire!";
  if (e.t === "scope.violated" && e.label.includes("breach")) return "Breach window blown — regroup!";
  if (e.t === "step.fail") return "Lost him — repositioning!";
  return null;
}

// ---------------------------------------------------------------- instances

/** Skirmish: two autonomous squads (Red vs Blue) meet on open ground. Each side
 *  coordinates its own suppress-and-flank from its OWN belief — no shared memory
 *  across teams — and reactively readjusts as it discovers the other's moves. */
export function skirmishInstance(): SquadInstance {
  return {
    units: [
      { name: "R1", side: "enemy", x: -10, z: -2, role: "suppressor" },
      { name: "R2", side: "enemy", x: -10, z: 3, role: "flanker" },
      { name: "B1", side: "ally", x: 10, z: 2, role: "suppressor" },
      { name: "B2", side: "ally", x: 10, z: -3, role: "flanker" },
    ],
    covers: [
      // peek positions around the central building (corner cover)
      { name: "cNW", x: -5, z: -5 },
      { name: "cSW", x: -5, z: 5 },
      { name: "cNE", x: 5, z: -5 },
      { name: "cSE", x: 5, z: 5 },
      // wide flanks (clear line of fire around the building)
      { name: "fN", x: 0, z: -9, flank: true },
      { name: "fS", x: 0, z: 9, flank: true },
      { name: "rRally", x: -12, z: 0, rally: true },
      { name: "bRally", x: 12, z: 0, rally: true },
    ],
    // a central building breaks the direct line of fire — squads must use it for
    // cover and flank around it (routing handled by pathfinding)
    walls: [{ x: -3.5, z: -2.5, w: 7, d: 5 }],
  };
}

/** Breach-and-clear: a Red fire-team breaches a room a Blue team is holding (E4).
 *  Red stacks and breaches in sync inside a deadline window; Blue defends. */
export function breachInstance(): SquadInstance {
  return {
    breach: true,
    units: [
      { name: "R1", side: "enemy", x: -3, z: -1, role: "assault" },
      { name: "R2", side: "enemy", x: 3, z: -1, role: "assault" },
      { name: "B1", side: "ally", x: -3, z: 10, role: "assault" }, // defenders holding the room
      { name: "B2", side: "ally", x: 3, z: 10, role: "assault" },
    ],
    covers: [
      // Red stacks on EITHER side of the door (distinct slots), then breaches
      { name: "stackL", x: -1.4, z: 3.4, breach: true },
      { name: "stackR", x: 1.4, z: 3.4, breach: true },
      // positions inside the room to push to once the door is down
      { name: "roomW", x: -4, z: 8 },
      { name: "roomE", x: 4, z: 8 },
      { name: "roomN", x: 0, z: 12 },
    ],
    // a room: solid walls north, with a central DOOR that blocks sight + movement
    // until Red breaches it
    walls: [
      { x: -8, z: 5, w: 6.5, d: 1 }, // left wall
      { x: 1.5, z: 5, w: 6.5, d: 1 }, // right wall
      { x: -1.5, z: 5, w: 3, d: 1, door: true }, // the breachable door (fills the gap)
      { x: -8, z: 5, w: 1, d: 9 }, // west wall
      { x: 7, z: 5, w: 1, d: 9 }, // east wall
      { x: -8, z: 13, w: 16, d: 1 }, // back wall
    ],
  };
}

export function squadModel(inst: SquadInstance, self: string): Model {
  // exposed for focused unit tests that build a single planner directly
  const world = new SquadWorld(inst);
  return buildUnitModel(self, world, inst);
}

/** Convenience goal: neutralize the threat (the inner GOAP goal of `Fight`). */
export function neutralizeGoal(): Formula {
  return F.lte(N.fl("threatHp"), N.c(0));
}
