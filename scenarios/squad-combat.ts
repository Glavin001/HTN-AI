/**
 * Squad Combat — a F.E.A.R.-style tactical scenario where NPCs fight from emergent,
 * *searched* positions: each unit derives a covered approach to a firing line, reads
 * the room (close for a killing angle vs. stay in cover vs. break contact when hurt),
 * and announces its moves with barks — all driven by the *real* reactive Planner,
 * one per unit.
 *
 * The signature idea (the thing that makes this more than scripted cover-AI): there
 * are NO hand-placed waypoints. The play area is a fluid GRID of cells; a `step`
 * operator moves between adjacent cells at a cost of
 *     1 + EXPOSURE_W·exposure(to) + RANGE_W·range_to_threat(to)
 * and engagement is the GOAP goal `achieve(canSee)`. So the unit *searches* a
 * multi-step route that trades exposure against closing the distance — it will take
 * a longer covered path, or a near so-so cell that opens onto a dominant angle, that
 * a greedy "walk toward the enemy / nearest cover that sees them" would never find.
 * This is the library's staircase-style emergence (scenarios/staircase.ts) turned on
 * combat positioning.
 *
 * Architecture (all from existing extension points, no core change):
 *   • One Model + ExecState per AI unit, authored "from my point of view" with
 *     global belief fluents — each planner's ExecState IS that unit's working memory.
 *   • A shared SquadWorld (ground-truth kinematics + a navgraph of cells) captured by
 *     the registry closures. Executors enact actions on the world; preconditions read
 *     belief.
 *   • Perception copies world → belief every tick (the dirty `state.set` writes that
 *     drive fluent-precise reactive replanning), gated by line-of-sight + memory; it
 *     also quantises my/threat position to cell centres (so the planner replans only
 *     on a cell *crossing*, not every centimetre) and recomputes each cell's exposure
 *     to known hostiles (the cost the route search minimises).
 *   • Every IR effect is `planOnly`: planning simulates over belief, execution mutates
 *     the world, perception reconciles — no double counting.
 *
 * Shared by tests/squad.ts (ground-truth assertions) and the web preview.
 */
import {
  type DomainDoc,
  type ExecutorApi,
  type Formula,
  type GoalSpec,
  type Model,
  type Planner as PlannerT,
  type Rejection,
  type TaskStatus,
  type TraceEvent,
  E,
  F,
  N,
  Planner,
  achieve,
  createModel,
  doTask,
  planSummary,
} from "../src/index";

// ---------------------------------------------------------------- tunables

export const SHOT_DAMAGE = 26; // per hit; hp starts at 100 ⇒ ~4 clean hits
export const AMMO_MAX = 8;
export const MOVE_SPEED = 3.4; // world units / second
export const SHOT_TIME = 0.3; // seconds to take a shot
export const RELOAD_TIME = 1.5;
export const MEMORY_SECONDS = 6; // how long a lost target is hunted (last-known) before giving up
// Break-contact threshold: a unit falls back to a rally once this hurt. Default 22 is
// effectively "press the fight" (a hit takes ~26, so units commit and engagements stay
// decisive); RAISE it (e.g. 45) to make units value their own skin and break contact
// more readily — the headline knob for cautious-vs-aggressive squad temperament.
export const LOW_HP = 22;
export const SIGHT_RANGE = 26;
export const BREACH_WINDOW = 6; // seconds the synchronized breach must complete within

// --- positioning search (the heart of the scenario) ---
export const GRID = 3; // cell spacing — the granularity of the fluid position grid
/** weight on a cell's exposure to enemy fire in the route cost (raise → hug cover more) */
export const EXPOSURE_W = 3.2;
/** weight on distance-to-threat in the route cost (raise → close more aggressively) */
export const RANGE_W = 1.8;
export const NEAR_RANGE = 9; // "advance to contact" target distance when no shot exists yet

// --- probabilistic hit model: range + cover change the odds ---
export const BASE_HIT = 0.94; // point-blank, clear shot
export const COVER_HIT_MULT = 0.32; // a target tucked behind soft cover is much harder to hit

/** Accuracy vs range: ~1 up close, decaying to ~0.32 at the edge of sight — so closing
 *  the distance is a real, earned advantage the route search can choose to pay for. */
function rangeFactor(dist: number): number {
  return Math.max(0.32, Math.min(1, 1.18 - 0.04 * dist));
}

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

/** A tagged position of interest. Plain spots are ignored (every cell is a position
 *  now); only `rally` (fall-back) and `breach` (stack-up) markers matter — they snap
 *  to the nearest grid cell. */
export interface CoverSpec {
  name: string;
  x: number;
  z: number;
  flank?: boolean;
  high?: boolean;
  breach?: boolean;
  rally?: boolean;
}

/** An obstacle. Full-height walls block sight AND movement; half-height cover
 *  blocks movement only (you path around it) and gives DIRECTIONAL soft cover —
 *  it shields you from shooters it sits between you and, not from your flank/back. */
export interface WallSpec {
  x: number;
  z: number;
  w: number;
  d: number;
  /** a breachable door: blocks sight + movement until a breach action breaks it */
  door?: boolean;
  /** half-height cover: blocks movement + gives soft cover, but NOT line of sight */
  half?: boolean;
}

export interface SquadInstance {
  units: UnitSpec[];
  /** rally + breach markers (snapped to cells); plain spots ignored */
  covers: CoverSpec[];
  walls?: WallSpec[];
  /** scripted waypoints the player avatar walks (the NPCs react to it) */
  playerPath?: Vec2[];
  /** seconds the player dwells at each waypoint */
  playerDwell?: number;
  /** open with a synchronized breach-and-clear (E4) instead of a standing fight */
  breach?: boolean;
}

// ---------------------------------------------------------------- geometry

function dist2(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}

/** Segment (a→b) vs axis-aligned box intersection — used for line-of-sight + clearance. */
function segHitsBox(ax: number, az: number, bx: number, bz: number, w: WallSpec): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  let t0 = 0;
  let t1 = 1;
  const minX = w.x;
  const maxX = w.x + w.w;
  const minZ = w.z;
  const maxZ = w.z + w.d;
  for (const [p, q0] of [
    [-dx, ax - minX],
    [dx, maxX - ax],
    [-dz, az - minZ],
    [dz, maxZ - az],
  ] as [number, number][]) {
    if (p === 0) {
      if (q0 < 0) return false;
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

// ---------------------------------------------------------------- navgraph (the fluid grid)

export interface Cell {
  name: string;
  x: number;
  z: number;
  rally: boolean;
  breach: boolean;
}

export interface NavGraph {
  cells: Cell[];
  byName: Map<string, Cell>;
  /** undirected adjacency, as a set of "a|b" keys (a<b) */
  edges: Set<string>;
  /** name → list of adjacent cell names */
  neighbors: Map<string, string[]>;
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Build the position grid for an instance: a lattice of cells over the play area,
 * dropping any that fall inside a movement obstacle, with adjacency between grid
 * neighbours whose connecting segment is movement-clear (so a half-cover crate
 * forces a detour around it — the routes that make flanking emerge). The door is
 * treated as solid for the graph: units engage a breached room *through* the
 * doorway (LOS), they don't path through the closed door.
 */
export function buildNav(inst: SquadInstance): NavGraph {
  const walls = inst.walls ?? [];
  // bounding box over units + walls, padded so there's room to manoeuvre wide
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const note = (x: number, z: number) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  };
  for (const u of inst.units) note(u.x, u.z);
  for (const c of inst.covers) note(c.x, c.z);
  for (const w of walls) {
    note(w.x, w.z);
    note(w.x + w.w, w.z + w.d);
  }
  const pad = GRID + 1;
  minX = Math.floor((minX - pad) / GRID) * GRID;
  maxX = Math.ceil((maxX + pad) / GRID) * GRID;
  minZ = Math.floor((minZ - pad) / GRID) * GRID;
  maxZ = Math.ceil((maxZ + pad) / GRID) * GRID;

  const inWall = (x: number, z: number) =>
    walls.some((w) => x > w.x - 0.5 && x < w.x + w.w + 0.5 && z > w.z - 0.5 && z < w.z + w.d + 0.5);

  const cells: Cell[] = [];
  const grid: (Cell | null)[][] = [];
  let cols = 0;
  for (let x = minX, ci = 0; x <= maxX + 1e-6; x += GRID, ci++) {
    grid[ci] = [];
    let ri = 0;
    for (let z = minZ; z <= maxZ + 1e-6; z += GRID, ri++) {
      if (inWall(x, z)) {
        grid[ci][ri] = null;
        continue;
      }
      const cell: Cell = { name: `k${ci}_${ri}`, x, z, rally: false, breach: false };
      grid[ci][ri] = cell;
      cells.push(cell);
    }
    cols = ci + 1;
  }

  const byName = new Map(cells.map((c) => [c.name, c]));
  const clearMove = (a: Cell, b: Cell) => walls.every((w) => !segHitsBox(a.x, a.z, b.x, b.z, w));
  const edges = new Set<string>();
  const neighbors = new Map<string, string[]>(cells.map((c) => [c.name, []]));
  for (let ci = 0; ci < cols; ci++) {
    for (let ri = 0; ri < grid[ci].length; ri++) {
      const a = grid[ci][ri];
      if (!a) continue;
      // 8-neighbourhood
      for (const [dci, dri] of [[1, 0], [0, 1], [1, 1], [1, -1]] as [number, number][]) {
        const b = grid[ci + dci]?.[ri + dri];
        if (!b || !clearMove(a, b)) continue;
        const k = edgeKey(a.name, b.name);
        if (edges.has(k)) continue;
        edges.add(k);
        neighbors.get(a.name)!.push(b.name);
        neighbors.get(b.name)!.push(a.name);
      }
    }
  }

  // snap rally / breach markers to the nearest cell
  for (const c of inst.covers) {
    if (!c.rally && !c.breach) continue;
    let best: Cell | null = null;
    let bestD = Infinity;
    for (const cell of cells) {
      const d = dist2(c.x, c.z, cell.x, cell.z);
      if (d < bestD) {
        bestD = d;
        best = cell;
      }
    }
    if (best) {
      if (c.rally) best.rally = true;
      if (c.breach) best.breach = true;
    }
  }

  return { cells, byName, edges, neighbors };
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
  cell: string | null;
  elevation: number;
}

export interface TeamState {
  tactic: "hold" | "flank" | "breach";
  flankerReady: boolean;
  breached: boolean;
}

const HOSTILE: Record<Side, Side[]> = {
  enemy: ["player", "ally"],
  ally: ["enemy"],
  player: ["enemy"],
};

/**
 * The shared world: ground-truth actor kinematics + vitals, the static geometry +
 * navgraph, and a per-team blackboard. Belief lives in each planner's ExecState.
 */
export class SquadWorld {
  public clock = 0;
  public readonly actors = new Map<string, Actor>();
  public readonly covers: CoverSpec[];
  public readonly walls: WallSpec[];
  public readonly nav: NavGraph;
  public doorBroken = false;

  private readonly teamState = new Map<Side, TeamState>();
  /** cell name → owning unit name (reservation); keeps two units off one cell */
  public readonly cellOwner = new Map<string, string | null>();
  /** most recent bark per unit, for the view */
  public readonly barks = new Map<string, { text: string; at: number }>();

  team(side: Side): TeamState {
    let t = this.teamState.get(side);
    if (!t) this.teamState.set(side, (t = { tactic: "hold", flankerReady: false, breached: false }));
    return t;
  }

  constructor(inst: SquadInstance) {
    this.covers = inst.covers;
    this.walls = inst.walls ?? [];
    this.nav = buildNav(inst);
    for (const u of inst.units) {
      const cell = this.cellOf(u.x, u.z);
      this.actors.set(u.name, {
        name: u.name,
        side: u.side,
        x: u.x,
        z: u.z,
        hp: u.hp ?? 100,
        ammo: u.ammo ?? AMMO_MAX,
        alive: true,
        cell,
        elevation: 0,
      });
    }
  }

  /** obstacles that block line of sight: full walls + the intact door (NOT half cover) */
  sightWalls(): WallSpec[] {
    return this.walls.filter((w) => !w.half && !(w.door && this.doorBroken));
  }

  losClear(ax: number, az: number, bx: number, bz: number): boolean {
    for (const w of this.sightWalls()) if (segHitsBox(ax, az, bx, bz, w)) return false;
    return true;
  }

  /** Is the position (px,pz) in soft cover from a shooter at (sx,sz)? True when a
   *  half-cover obstacle sits between them, close to the position — directional:
   *  a shooter on the far side is blocked, one on your flank/back is not. */
  coveredFrom(px: number, pz: number, sx: number, sz: number): boolean {
    for (const w of this.walls) {
      if (!w.half) continue;
      if (!segHitsBox(px, pz, sx, sz, w)) continue;
      const cx = w.x + w.w / 2;
      const cz = w.z + w.d / 2;
      if (dist2(px, pz, cx, cz) <= GRID) return true;
    }
    return false;
  }

  /** the grid cell nearest a world position (units quantise to this for planning). */
  cellOf(x: number, z: number): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (const c of this.nav.cells) {
      const d = dist2(x, z, c.x, c.z);
      if (d < bestD) {
        bestD = d;
        best = c.name;
      }
    }
    return best;
  }

  /** the nearest hostile to `self`, optionally requiring line of sight */
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

  /** all living hostiles to `self` within sight range (for the exposure field). */
  hostilesOf(self: string): Actor[] {
    const me = this.actors.get(self);
    if (!me) return [];
    return [...this.actors.values()].filter((o) => o.alive && HOSTILE[me.side].includes(o.side));
  }

  /** how exposed a cell is to a unit's hostiles right now: count of enemies that have
   *  a clear, in-range line to it AND are NOT defeated by soft cover from that angle. */
  cellExposure(self: string, cx: number, cz: number): number {
    let n = 0;
    for (const h of this.hostilesOf(self)) {
      if (dist2(cx, cz, h.x, h.z) > SIGHT_RANGE) continue;
      if (!this.losClear(cx, cz, h.x, h.z)) continue;
      if (this.coveredFrom(cx, cz, h.x, h.z)) continue; // cover beats this shooter
      n += 1;
    }
    return n;
  }

  /** release any cell `self` holds, evict any prior owner, then claim `cell`. */
  occupy(self: string, cell: string): void {
    for (const [c, owner] of this.cellOwner) if (owner === self) this.cellOwner.set(c, null);
    const prev = this.cellOwner.get(cell);
    if (prev && prev !== self) {
      const pa = this.actors.get(prev);
      if (pa) pa.cell = null;
    }
    this.cellOwner.set(cell, self);
    const a = this.actors.get(self);
    if (a) a.cell = cell;
  }

  bark(self: string, text: string): void {
    this.barks.set(self, { text, at: this.clock });
  }
}

// ---------------------------------------------------------------- the domain (one POV)

/**
 * The combat domain, authored from a single unit's point of view. Every AI unit runs
 * this same domain; only its side (perception) and who sets its tactic (the breach
 * opener vs. player commands) differ. Compiled once per unit with a registry closing
 * over the shared world and that unit's identity.
 */
export const squadDomain: DomainDoc = {
  name: "squad-combat",
  types: [{ name: "cell" }],
  fluents: [
    // --- self (belief; perception mirrors truth) ---
    { name: "myPos", kind: "vec2" },
    { name: "myAmmo", kind: "int", initial: AMMO_MAX },
    { name: "myHp", kind: "float", initial: 100 },
    { name: "atCell", kind: "entity", entityType: "cell" },
    { name: "tactic", kind: "enum", values: ["hold", "flank", "breach", "regroup"], initial: "hold" },
    // --- threat (belief; perception gates by line-of-sight + memory) ---
    { name: "threatPos", kind: "vec2" },
    { name: "threatHp", kind: "float", initial: 100 },
    { name: "threatSeen", kind: "boolean", initial: false }, // current line of sight
    { name: "hasThreat", kind: "boolean", initial: false }, // a position fix at all
    // --- navgraph (static topology + per-cell dynamic state) ---
    { name: "cellPos", params: [{ name: "c", type: "cell" }], kind: "vec2", static: true },
    // adjacency is STATIC (set once at init) so the compiler's static-fluent pruning
    // drops every non-adjacent (from,to) grounding of `step` — the grid stays cheap to
    // search (without this, step grounds over every cell PAIR: O(cells²) → unusable)
    { name: "adj", params: [{ name: "a", type: "cell" }, { name: "b", type: "cell" }], kind: "boolean", initial: false, static: true },
    { name: "cellRally", params: [{ name: "c", type: "cell" }], kind: "boolean", initial: false, static: true },
    { name: "cellBreach", params: [{ name: "c", type: "cell" }], kind: "boolean", initial: false, static: true },
    // dynamic, COST-only reads (never in a precondition/goal, so they never trigger a
    // replan on their own — they only shape which route the search prefers)
    { name: "cellExposure", params: [{ name: "c", type: "cell" }], kind: "float", initial: 0 },
    // dynamic precondition read: a cell another unit has claimed (dirties → others reroute)
    { name: "cellTaken", params: [{ name: "c", type: "cell" }], kind: "boolean", initial: false },
  ],
  compounds: [{ name: "Fight" }, { name: "Regroup" }, { name: "Neutralize" }],
  operators: [
    {
      // the workhorse: move to an ADJACENT free cell. Cost trades exposure against
      // closing the distance, so a *sequence* of steps is a searched covered approach.
      name: "step",
      params: [{ name: "from", type: "cell" }, { name: "to", type: "cell" }],
      pre: F.and(F.lit("atCell", [], "?from"), F.lit("adj", ["?from", "?to"]), F.not(F.lit("cellTaken", ["?to"]))),
      eff: [
        E.set("atCell", [], "?to", "planOnly"),
        E.setVec("myPos", [], N.ext("cellX", ["?to"], ["cellPos"]), N.ext("cellZ", ["?to"], ["cellPos"]), undefined, "planOnly"),
      ],
      cost: N.add(
        N.c(1),
        N.add(
          N.mul(N.c(EXPOSURE_W), N.fl("cellExposure", "?to")),
          N.mul(N.c(RANGE_W), N.div(N.dist("cellPos", ["?to"], "threatPos", []), N.c(SIGHT_RANGE))),
        ),
      ),
      duration: N.div(N.dist("myPos", [], "cellPos", ["?to"]), N.c(MOVE_SPEED)),
      executor: "move",
    },
    {
      // fire on the threat. Selection is belief-driven (fireNow needs canSee); the
      // `verify` is lenient (just "still a threat") so a one-beat quantised-LOS blip
      // doesn't hard-abort the burst into churn — the executor decides hit/miss on the
      // *real* line of fire, and losing the threat entirely (dead/out of range) fails.
      name: "takeShot",
      // gated on threatSeen — the REAL current line of sight from perception (not the
      // quantised geometric canSee), so a unit never wastes a magazine on a target it
      // only *believes* it can see; a quantisation mismatch makes it re-route instead.
      pre: F.and(
        F.lit("threatSeen"),
        F.gt(N.fl("myAmmo"), N.c(0)),
        F.gt(N.fl("threatHp"), N.c(0)),
      ),
      verify: F.lit("hasThreat"),
      eff: [E.dec("myAmmo", [], N.c(1), "planOnly"), E.dec("threatHp", [], N.c(SHOT_DAMAGE), "planOnly")],
      cost: 1,
      duration: SHOT_TIME,
      executor: "shoot",
    },
    {
      // breach the door (only as part of a breach assault — not a shoot-through-walls
      // shortcut; a standing fight must still earn its line of sight by manoeuvring)
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
    // 1. hurt → break contact: route (exposure-weighted) to the nearest rally cell
    {
      name: "retreat",
      task: "Fight",
      params: [{ name: "r", type: "cell" }],
      pre: F.and(F.lt(N.fl("myHp"), N.c(LOW_HP)), F.lit("cellRally", ["?r"]), F.not(F.lit("cellTaken", ["?r"]))),
      utility: N.sub(N.c(0), N.dist("myPos", [], "cellPos", ["?r"])), // nearest rally
      subtasks: [achieve(F.lit("atCell", [], "?r"))],
    },
    // 2. synchronized breach (E4): stack on the door AND breach inside one deadline
    //    window (pruned in search via the projected clock), then neutralize.
    {
      name: "breachAssault",
      task: "Fight",
      params: [{ name: "bp", type: "cell" }],
      pre: F.and(F.lit("tactic", [], "breach"), F.lit("cellBreach", ["?bp"]), F.not(F.lit("cellTaken", ["?bp"]))),
      // just route to the stack point + breach inside the window. The post-breach
      // room-clear is NOT planned here (that would force a deep search of the whole
      // ensuing fight, freezing the unit): once `breach` opens the door, coordinate()
      // flips the tactic to hold and the next beat decomposes into a normal engage.
      subtasks: [{ scope: { deadline: BREACH_WINDOW, label: "breach-window" }, subtasks: [achieve(F.lit("atCell", [], "?bp")), doTask("breach")] }],
    },
    // 3. no threat fix at all → stand by in short beats (reactively wakes on contact)
    {
      name: "idle",
      task: "Fight",
      pre: F.not(F.lit("hasThreat")),
      subtasks: [{ hold: 0.5 }],
    },
    // 4. default → neutralize the threat (not during a breach opening)
    {
      name: "engage",
      task: "Fight",
      pre: F.not(F.lit("tactic", [], "breach")),
      subtasks: [doTask("Neutralize")],
    },
    // 5. there's a threat but nothing actionable right now → hold ready a beat
    {
      name: "holdReady",
      task: "Fight",
      pre: F.lit("hasThreat"),
      subtasks: [{ hold: 0.4 }],
    },
    // --- Neutralize: reload if dry; fire if there's a shot; else SEARCH a covered
    //     route to a firing line; else close the distance. Re-entered each beat.
    {
      name: "reloadDry",
      task: "Neutralize",
      pre: F.and(F.lit("hasThreat"), F.lte(N.fl("myAmmo"), N.c(0))),
      subtasks: [doTask("reload"), doTask("Neutralize")],
    },
    {
      // already have a real line of sight → fire (and keep firing until LOS/ammo/target gone)
      name: "fireNow",
      task: "Neutralize",
      pre: F.and(F.lit("threatSeen"), F.gt(N.fl("myAmmo"), N.c(0))),
      subtasks: [doTask("takeShot"), doTask("Neutralize")],
    },
    {
      // no shot from here → the heart of the scenario: achieve(canSee) makes the
      // planner SEARCH a multi-step route (exposure vs. range cost) to a cell that can
      // see the threat. The covered flank emerges; it is not scripted.
      // No takeShot baked in: firing needs threatSeen — the REAL line of sight that
      // perception grants only on arrival — so a shot here would make the plan
      // unplannable while still out of LOS, and the unit would stall "near but blind".
      // The shot follows next beat via fireNow. NO distance relax on purpose: a "get
      // closer" heuristic would greedily miss routes that must first go the LONG way
      // around a blocker — exactly the non-greedy, multi-step positioning this scenario
      // exists to show. Uniform-cost search over the exposure/range step cost finds it.
      name: "reposition",
      task: "Neutralize",
      pre: F.lit("hasThreat"),
      subtasks: [achieve(F.ext("canSee", [], ["myPos", "threatPos"]))],
    },
    {
      // can't reach any firing line (target fully bunkered) → advance to contact, so
      // the fight never stalls into mutual hiding
      name: "advance",
      task: "Neutralize",
      pre: F.lit("hasThreat"),
      subtasks: [achieve(F.ext("nearThreat", [], ["myPos", "threatPos"]))],
    },
    {
      name: "holdN",
      task: "Neutralize",
      pre: F.lit("hasThreat"),
      subtasks: [{ hold: 0.4 }],
    },
    // player order: fall back to a rally cell, then hold + fight from there (E2 `setGoals`)
    {
      name: "regroupTo",
      task: "Regroup",
      params: [{ name: "r", type: "cell" }],
      pre: F.and(F.lit("cellRally", ["?r"]), F.not(F.lit("cellTaken", ["?r"]))),
      utility: N.sub(N.c(0), N.dist("myPos", [], "cellPos", ["?r"])),
      subtasks: [achieve(F.lit("atCell", [], "?r")), doTask("Fight")],
    },
  ],
};

// ---------------------------------------------------------------- registry / model per unit

function buildUnitModel(self: string, world: SquadWorld): Model {
  const nav = world.nav;
  const entities: Record<string, string> = {};
  for (const c of nav.cells) entities[c.name] = "cell";
  return createModel(
    squadDomain,
    {
      entities,
      init: (w) => {
        for (const c of nav.cells) {
          w.set("cellPos", [c.name], [c.x, c.z]);
          if (c.rally) w.set("cellRally", [c.name], true);
          if (c.breach) w.set("cellBreach", [c.name], true);
        }
        for (const key of nav.edges) {
          const [a, b] = key.split("|");
          w.set("adj", [a, b], true);
          w.set("adj", [b, a], true);
        }
        const me = world.actors.get(self);
        if (me) {
          w.set("myPos", [], [me.x, me.z]);
          w.set("myHp", [], me.hp);
          w.set("myAmmo", [], me.ammo);
          if (me.cell) w.set("atCell", [], me.cell);
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
        // within striking distance of the threat (the "advance to contact" goal)
        nearThreat: (q) => {
          const m = q.vec("myPos");
          const t = q.vec("threatPos");
          if (m[0] === t[0] && m[1] === t[1]) return false;
          return dist2(m[0], m[1], t[0], t[1]) <= NEAR_RANGE;
        },
      },
      numerics: {
        cellX: (q) => q.vec("cellPos", q.args[0])[0],
        cellZ: (q) => q.vec("cellPos", q.args[0])[1],
      },
      executors: {
        move: moveExecutor(self, world),
        shoot: shootExecutor(self, world),
        breach: breachExecutor(self, world),
        reload: reloadExecutor(self, world),
      },
    },
  );
}

// ---------------------------------------------------------------- executors (enact on the world)

function moveExecutor(self: string, world: SquadWorld): (api: ExecutorApi) => TaskStatus {
  return (api) => {
    const a = world.actors.get(self);
    if (!a || !a.alive) return "failure";
    const toName = api.model.entityName(api.args[1]); // step(from, to)
    const cell = world.nav.byName.get(toName);
    if (!cell) return "failure";
    const mem = api.remember(() => {
      world.occupy(self, toName); // claim the moment the hop starts → rivals reroute
      return { x0: a.x, z0: a.z, t0: api.clock() };
    }) as { x0: number; z0: number; t0: number };
    const span = dist2(mem.x0, mem.z0, cell.x, cell.z) / MOVE_SPEED || 1e-3;
    const t = (api.clock() - mem.t0) / span;
    if (t >= 1) {
      a.x = cell.x;
      a.z = cell.z;
      return "success";
    }
    a.x = lerp(mem.x0, cell.x, t);
    a.z = lerp(mem.z0, cell.z, t);
    return "continue";
  };
}

function shootExecutor(self: string, world: SquadWorld): (api: ExecutorApi) => TaskStatus {
  return (api) => {
    const a = world.actors.get(self);
    if (!a || !a.alive) return "failure";
    if (api.elapsedInStep() < SHOT_TIME) return "continue"; // aiming
    // tolerant: a shot always *completes* (no LOS-flicker churn). It HITS only on a
    // real, current line of fire — closer is deadlier, soft cover spoils the shot — so
    // the position the route search chose is a real, mechanical advantage. With no
    // hostile in range at all, there's nothing to shoot → fail (replan).
    const anyHostile = world.nearestHostile(self, false);
    if (!anyHostile) return "failure";
    a.ammo = Math.max(0, a.ammo - 1);
    const losTarget = world.nearestHostile(self, true);
    if (losTarget) {
      const d = dist2(a.x, a.z, losTarget.x, losTarget.z);
      const covered = world.coveredFrom(losTarget.x, losTarget.z, a.x, a.z);
      const pHit = BASE_HIT * rangeFactor(d) * (covered ? COVER_HIT_MULT : 1);
      if (api.rng.next() < pHit) {
        losTarget.hp = Math.max(0, losTarget.hp - SHOT_DAMAGE);
        if (losTarget.hp <= 0) losTarget.alive = false;
      }
    }
    return "success";
  };
}

function breachExecutor(self: string, world: SquadWorld): (api: ExecutorApi) => TaskStatus {
  return (api) => {
    const a = world.actors.get(self);
    if (!a || !a.alive) return "failure";
    // emergent sync: the first to the door HOLDS until the whole team has stacked, so
    // they breach together; a short cap means a lone survivor still breaches.
    const team = [...world.actors.values()].filter((x) => x.alive && x.side === a.side);
    const atDoor = (x: Actor) => {
      const c = x.cell ? world.nav.byName.get(x.cell) : undefined;
      return !!(c && c.breach);
    };
    if (!world.doorBroken && !team.every(atDoor) && api.elapsedInStep() < 2.5) return "continue";
    world.doorBroken = true; // sight + movement open into the room
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

// ---------------------------------------------------------------- unit planner wrapper

export interface UnitPlanner {
  name: string;
  side: Side;
  role: Role;
  model: Model;
  planner: PlannerT;
  lastSeen: number;
  trace: TraceEvent[];
  why: string[];
  goalText: string;
  goalExpr: string;
}

const DEFAULT_GOAL = { text: "Win the firefight — neutralize the enemy squad", expr: 'task("Fight")' };

// ---------------------------------------------------------------- frames

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
  cover: string | null; // current cell name
  step: string;
  action: string;
  bark: string;
  firingAt: string | null;
  firingKind: "shot" | "breach" | null;
  sees: string | null;
  /** the planned route ahead (cell centres) — the searched covered approach */
  route: Vec2[];
  tactic: string;
  status: string;
  goalText: string;
  goalExpr: string;
  replanning: boolean;
  plan: string[];
  events: string[];
  why: string[];
}

export interface TeamFrame {
  side: Side;
  tactic: string;
  flankerReady: boolean;
  alive: number;
  total: number;
}

export interface CellFrame {
  name: string;
  x: number;
  z: number;
  rally: boolean;
  breach: boolean;
}

export interface SquadFrame {
  clock: number;
  units: UnitFrame[];
  teams: TeamFrame[];
  /** cell name → owner unit (occupied cells, for the view) */
  reservations: Record<string, string | null>;
  /** the static grid (sent once-ish; the view caches it) */
  cells: CellFrame[];
  doorBroken: boolean;
}

export interface SquadSimOptions {
  seed?: number;
  dt?: number;
  nodes?: number;
  bark?: BarkAuthor;
}

/**
 * Headless, deterministic squad-combat simulation. Drives one real reactive Planner
 * per AI unit over a shared world, with a perception step between ticks. Used
 * verbatim by tests and the web preview.
 */
export class SquadSim {
  public readonly world: SquadWorld;
  public readonly units: UnitPlanner[] = [];
  public readonly trace: { unit: string; e: TraceEvent }[] = [];
  private readonly inst: SquadInstance;
  private readonly dt: number;
  private readonly nodes: number;
  private readonly barkAuthor: BarkAuthor;
  private playerLeg = 0;
  private playerLegT = 0;

  constructor(inst: SquadInstance, opts: SquadSimOptions = {}) {
    this.inst = inst;
    this.dt = opts.dt ?? 0.1;
    this.nodes = opts.nodes ?? 1_800;
    this.barkAuthor = opts.bark ?? barkFor;
    this.world = new SquadWorld(inst);
    if (inst.breach) this.world.team("enemy").tactic = "breach";
    let seedBump = 0;
    for (const u of inst.units) {
      if (u.side === "player") continue;
      const model = buildUnitModel(u.name, this.world);
      const trace: TraceEvent[] = [];
      const entry: UnitPlanner = {
        name: u.name,
        side: u.side,
        role: u.role ?? "assault",
        model,
        planner: undefined as unknown as PlannerT,
        lastSeen: -Infinity,
        trace,
        why: [],
        goalText: DEFAULT_GOAL.text,
        goalExpr: DEFAULT_GOAL.expr,
      };
      entry.planner = new Planner(model, {
        goals: [{ kind: "task", name: "Fight" }],
        now: () => this.world.clock,
        seed: (opts.seed ?? 1) + seedBump++,
        weight: 1.4,
        collectRejections: true,
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
    // quantise my position to my current cell centre — the planner then replans on a
    // cell *crossing*, not every frame of motion
    const myCellName = this.world.cellOf(a.x, a.z);
    const myCell = myCellName ? this.world.nav.byName.get(myCellName) : undefined;
    if (a.cell !== myCellName && myCellName) this.world.occupy(p.name, myCellName);
    setBeliefVec(p, "myPos", myCell ? myCell.x : a.x, myCell ? myCell.z : a.z);
    if (myCellName) setBelief(p, "atCell", [], myCellName);
    setBelief(p, "myAmmo", [], a.ammo);
    setBelief(p, "myHp", [], a.hp);
    // sight: a clear, current line of fire — gates firing. hearing: a position fix
    // even without LOS (so the flank can aim its route at the right place).
    const seen = this.world.nearestHostile(p.name, true);
    const heard = seen ?? this.world.nearestHostile(p.name, false);
    setBelief(p, "threatSeen", [], !!seen); // CURRENT real LOS — accurate firing gate
    if (heard) {
      p.lastSeen = this.world.clock;
      // quantise the threat to a cell centre too → bounded re-aim replans
      const tc = this.world.cellOf(heard.x, heard.z);
      const tcell = tc ? this.world.nav.byName.get(tc) : undefined;
      setBeliefVec(p, "threatPos", tcell ? tcell.x : heard.x, tcell ? tcell.z : heard.z);
      setBelief(p, "threatHp", [], heard.hp);
      setBelief(p, "hasThreat", [], true);
    } else if (this.world.clock - p.lastSeen <= MEMORY_SECONDS) {
      // recently lost — keep HUNTING the last-known position (threatPos unchanged, so
      // belief goes stale → getting flanked emerges); don't idle.
      setBelief(p, "hasThreat", [], true);
    } else {
      // long out of contact — re-establish a coarse search vector toward the nearest
      // living enemy so the squad CONVERGES instead of stalling (squad comms / command
      // vectoring). Firing stays strictly LOS-gated, so the real fight is still earned.
      const enemies = this.world.hostilesOf(p.name);
      let near: Actor | null = null;
      let nd = Infinity;
      for (const e of enemies) {
        const d = dist2(a.x, a.z, e.x, e.z);
        if (d < nd) {
          nd = d;
          near = e;
        }
      }
      if (near) {
        const tc = this.world.cellOf(near.x, near.z);
        const tcell = tc ? this.world.nav.byName.get(tc) : undefined;
        setBeliefVec(p, "threatPos", tcell ? tcell.x : near.x, tcell ? tcell.z : near.z);
        setBelief(p, "threatHp", [], near.hp);
      }
      setBelief(p, "hasThreat", [], !!near);
    }
    // per-cell exposure (cost-only) + reservations (precondition)
    for (const c of this.world.nav.cells) {
      setBelief(p, "cellExposure", [c.name], this.world.cellExposure(p.name, c.x, c.z));
      const owner = this.world.cellOwner.get(c.name) ?? null;
      setBelief(p, "cellTaken", [c.name], owner !== null && owner !== p.name);
    }
  }

  private reapDead(): void {
    for (const a of this.world.actors.values()) {
      if (a.alive) continue;
      for (const [c, owner] of this.world.cellOwner) if (owner === a.name) this.world.cellOwner.set(c, null);
      a.cell = null;
    }
  }

  /** Issue a player order to a unit — the `setGoals` seam (stand-in for an LLM). */
  command(unit: string, order: "engage" | "regroup" | "holdFire"): void {
    const p = this.units.find((u) => u.name === unit);
    if (!p) return;
    if (order === "regroup") {
      p.planner.setGoals([{ kind: "task", name: "Regroup" }]);
      p.goalText = "Regroup — fall back to the nearest rally";
      p.goalExpr = 'task("Regroup")';
    } else if (order === "holdFire") {
      p.planner.setGoals([]);
      p.goalText = "Hold fire — stand down";
      p.goalExpr = "goals: [] (idle)";
    } else {
      p.planner.setGoals([{ kind: "task", name: "Fight" }]);
      p.goalText = DEFAULT_GOAL.text;
      p.goalExpr = DEFAULT_GOAL.expr;
    }
  }

  // ---- minimal coordination: emergent only. The only shared decision is the breach
  //      opening (set once); roles/flanks emerge from each unit's own route search. ----
  private coordinate(): void {
    const sides = [...new Set(this.units.map((u) => u.side))];
    for (const side of sides) {
      const tb = this.world.team(side);
      if (tb.tactic === "breach" && tb.breached) tb.tactic = "hold";
      for (const u of this.units) {
        if (u.side !== side) continue;
        setBelief(u, "tactic", [], tb.tactic === "breach" ? "breach" : "hold");
      }
    }
  }

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

  step(): SquadFrame {
    this.world.clock += this.dt;
    this.movePlayer();
    this.coordinate();
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

  /** the cell-centre route ahead in a unit's current plan (for the view). */
  private routeOf(p: UnitPlanner): Vec2[] {
    const plan = p.planner.getPlan();
    if (!plan) return [];
    const out: Vec2[] = [];
    for (const label of planSummary(p.model, plan)) {
      const m = /step\([^,]+,\s*([A-Za-z0-9_]+)\)/.exec(label);
      if (!m) continue;
      const cell = this.world.nav.byName.get(m[1]);
      if (cell) out.push({ x: cell.x, z: cell.z });
    }
    return out;
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
      reservations: Object.fromEntries(this.world.cellOwner),
      cells: this.world.nav.cells.map((c) => ({ name: c.name, x: c.x, z: c.z, rally: c.rally, breach: c.breach })),
      units: [...this.world.actors.values()].map((a) => {
        const up = this.units.find((u) => u.name === a.name);
        const step = up?.planner.currentStep();
        const stepLabel = step && step.k === "op" ? up!.model.describeGroundOp(step.g) : step ? step.k : "—";
        const plan = up?.planner.getPlan();
        const status = up?.planner.getStatus() ?? "—";
        let firingAt: string | null = null;
        let firingKind: UnitFrame["firingKind"] = null;
        let sees: string | null = null;
        if (up && a.alive) {
          sees = this.world.nearestHostile(a.name, true)?.name ?? null;
          if (stepLabel.startsWith("takeShot")) {
            firingKind = "shot";
            firingAt = sees;
          } else if (stepLabel.startsWith("breach")) {
            firingKind = "breach";
            firingAt = this.world.nearestHostile(a.name, false)?.name ?? null;
          }
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
          cover: a.cell,
          step: stepLabel,
          action: up ? describeAction(stepLabel, status, a.alive, firingAt) : a.alive ? "target" : "down",
          bark: this.world.barks.get(a.name)?.text ?? "",
          firingAt,
          firingKind,
          sees,
          route: up && a.alive ? this.routeOf(up) : [],
          tactic: up ? this.world.team(a.side).tactic : "—",
          status,
          goalText: up ? up.goalText : "—",
          goalExpr: up ? up.goalExpr : "",
          replanning: up ? up.trace.slice(-3).some((e) => e.t === "replan.dirty" || e.t === "repair.attempt") || status === "planning" : false,
          plan: up && plan ? planSummary(up.model, plan) : [],
          events: up ? up.trace.slice(-6).map((e) => e.t) : [],
          why: up ? up.why : [],
        };
      }),
    };
  }

  run(maxSteps = 600): SquadFrame[] {
    const frames: SquadFrame[] = [this.snapshot()];
    for (let i = 0; i < maxSteps; i++) {
      frames.push(this.step());
      if (this.engagementOver()) break;
    }
    return frames;
  }

  engagementOver(): boolean {
    const alive = [...this.world.actors.values()].filter((a) => a.alive);
    return !alive.some((a) => alive.some((b) => (HOSTILE[a.side] ?? []).includes(b.side)));
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------- LLM-ready seams (Phase D)

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

function summarizeRejections(rejections: Rejection[]): string[] {
  const counts = new Map<string, number>();
  for (const r of rejections) {
    const key = `${r.at}: ${r.reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => (n > 1 ? `${k} (×${n})` : k));
}

function describeAction(step: string, status: string, alive: boolean, firingAt: string | null): string {
  if (!alive) return "down";
  if (step.startsWith("takeShot")) return firingAt ? `firing on ${firingAt}` : "firing";
  if (step.startsWith("step")) return "moving up under cover";
  if (step.startsWith("breach")) return "breaching";
  if (step.startsWith("reload")) return "reloading";
  if (step === "wait" || step === "hold") return "holding";
  if (status === "planning") return "reading the room…";
  if (status === "failed") return "looking for an angle";
  return "holding";
}

// ---------------------------------------------------------------- barks (trace → utterance)

export function barkFor(e: TraceEvent): string | null {
  if (e.t === "step.start") {
    if (e.label.startsWith("step")) return "Moving up!";
    if (e.label.startsWith("breach")) return "Breaching — go go go!";
    if (e.label.startsWith("takeShot")) return "Engaging!";
    if (e.label.startsWith("reload")) return "Reloading — cover me!";
  }
  if (e.t === "scope.violated" && e.label.includes("breach")) return "Breach window blown — regroup!";
  if (e.t === "step.fail") return "Lost him — repositioning!";
  return null;
}

// ---------------------------------------------------------------- instances

/** Skirmish: two autonomous squads (Red vs Blue) meet on broken ground. There are NO
 *  waypoints — each unit SEARCHES a covered route to a firing line over the grid, so
 *  flanks, covered approaches and break-contact all emerge. A central sight-blocker
 *  forces manoeuvre; scattered half-cover crates make directional cover matter. */
export function skirmishInstance(): SquadInstance {
  return {
    units: [
      { name: "R1", side: "enemy", x: -10, z: -2 },
      { name: "R2", side: "enemy", x: -10, z: 2 },
      { name: "B1", side: "ally", x: 10, z: 2 },
      { name: "B2", side: "ally", x: 10, z: -2 },
    ],
    covers: [
      { name: "rRally", x: -8, z: 0, rally: true },
      { name: "bRally", x: 8, z: 0, rally: true },
    ],
    // a solid central building breaks every direct spawn sightline, so neither squad
    // can just trade fire — both must SEARCH a covered route around it (north or
    // south) to a half-cover firing position. With cover reservation, the two
    // squad-mates take opposite lanes → an emergent pincer, unscripted.
    walls: [
      { x: -3, z: -3, w: 6, d: 6 }, // central building (full height)
      { x: -7.5, z: -8.5, w: 2.5, d: 2.5, half: true }, // flanking half-cover: directional
      { x: 5, z: -8.5, w: 2.5, d: 2.5, half: true }, //     firing positions the route
      { x: -7.5, z: 6, w: 2.5, d: 2.5, half: true }, //      search converges on
      { x: 5, z: 6, w: 2.5, d: 2.5, half: true },
      { x: -1.25, z: -10.5, w: 2.5, d: 2, half: true }, // north + south lane cover
      { x: -1.25, z: 8.5, w: 2.5, d: 2, half: true },
    ],
  };
}

/** Breach-and-clear (E4): a Red fire-team breaches a room a Blue team holds. Red
 *  stacks + breaches in sync inside a deadline window; Blue defends. */
export function breachInstance(): SquadInstance {
  return {
    breach: true,
    units: [
      { name: "R1", side: "enemy", x: -3, z: -2 },
      { name: "R2", side: "enemy", x: 3, z: -2 },
      { name: "B1", side: "ally", x: -3, z: 10 },
      { name: "B2", side: "ally", x: 3, z: 10 },
    ],
    covers: [
      { name: "stackL", x: -1.5, z: 3, breach: true },
      { name: "stackR", x: 1.5, z: 3, breach: true },
    ],
    walls: [
      { x: -8, z: 5, w: 6.5, d: 1 }, // front wall (left of door)
      { x: 1.5, z: 5, w: 6.5, d: 1 }, // front wall (right of door)
      { x: -1.5, z: 5, w: 3, d: 1, door: true }, // breachable door
      { x: -8, z: 5, w: 1, d: 9 }, // west wall
      { x: 7, z: 5, w: 1, d: 9 }, // east wall
      { x: -8, z: 13, w: 16, d: 1 }, // back wall
    ],
  };
}

/** A central full-height barricade blocks every direct shot — both squads must
 *  search a route around it (the emergent flank, on a different map). */
export function blockedFlankInstance(): SquadInstance {
  return {
    units: [
      { name: "R1", side: "enemy", x: -12, z: 0 },
      { name: "R2", side: "enemy", x: -12, z: 4 },
      { name: "B1", side: "ally", x: 12, z: 0 },
      { name: "B2", side: "ally", x: 12, z: -4 },
    ],
    covers: [
      { name: "rRally", x: -9, z: 0, rally: true },
      { name: "bRally", x: 9, z: 0, rally: true },
    ],
    walls: [
      { x: -2, z: -3.5, w: 4, d: 7 }, // a central barricade — the only shots are around the ends
      { x: -6, z: -7, w: 2, d: 2, half: true },
      { x: 4, z: -7, w: 2, d: 2, half: true },
      { x: -6, z: 5, w: 2, d: 2, half: true },
      { x: 4, z: 5, w: 2, d: 2, half: true },
    ],
  };
}

/** Your Blue squad (autonomous) vs a Red squad — you command a Blue unit (E2). Blue
 *  outnumbers Red 3:2, so an order is a tactical choice, not an instant loss. */
export function companionInstance(): SquadInstance {
  return {
    units: [
      { name: "B1", side: "ally", x: 11, z: -2 },
      { name: "B2", side: "ally", x: 11, z: 2 },
      { name: "B3", side: "ally", x: 13, z: 0 },
      { name: "R1", side: "enemy", x: -11, z: -1 },
      { name: "R2", side: "enemy", x: -11, z: 3 },
    ],
    covers: [
      { name: "bRally", x: 13, z: 0, rally: true },
      { name: "rRally", x: -13, z: 0, rally: true },
    ],
    walls: [
      { x: -3, z: -2.5, w: 6, d: 5 }, // central building
      { x: 5, z: -8, w: 2.5, d: 2.5, half: true },
      { x: -7, z: 6, w: 2.5, d: 2.5, half: true },
      { x: 5, z: 6, w: 2.5, d: 2.5, half: true },
      { x: -7, z: -8, w: 2.5, d: 2.5, half: true },
    ],
  };
}

export function squadModel(inst: SquadInstance, self: string): Model {
  // exposed for focused unit tests that build a single planner directly
  const world = new SquadWorld(inst);
  return buildUnitModel(self, world);
}

/** Convenience goal: neutralize the threat (the inner GOAP goal of `Fight`). */
export function neutralizeGoal(): Formula {
  return F.lte(N.fl("threatHp"), N.c(0));
}
