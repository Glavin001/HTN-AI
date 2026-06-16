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
  type Formula,
  type Model,
  type Planner as PlannerT,
  type TaskStatus,
  type TraceEvent,
  E,
  F,
  N,
  Planner,
  createModel,
} from "../src/index";

// ---------------------------------------------------------------- tunables

export const SHOT_DAMAGE = 24; // per hit; threat starts at 100 ⇒ ~5 shots
export const SUPPRESS_DAMAGE = 4; // suppression chips but mainly pins
export const AMMO_MAX = 8;
export const MOVE_SPEED = 3.2; // world units / second
export const SHOT_TIME = 0.32; // seconds to take a shot
export const RELOAD_TIME = 1.6;
export const MEMORY_SECONDS = 4; // how long a lost target is remembered before "search"
export const LOW_HP = 34; // retreat threshold
export const SIGHT_RANGE = 22;
export const BREACH_WINDOW = 6; // seconds the synchronized breach must complete within

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
}

/** Axis-aligned obstacle that blocks line of sight (and is rendered as a wall). */
export interface WallSpec {
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface SquadInstance {
  units: UnitSpec[];
  covers: CoverSpec[];
  walls?: WallSpec[];
  /** scripted waypoints the player avatar walks (the NPCs react to it) */
  playerPath?: Vec2[];
  /** seconds the player dwells at each waypoint */
  playerDwell?: number;
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

  // ---- blackboard (read by predicates, written by the coordinator/executors) ----
  public squadTactic: "hold" | "flank" | "breach" = "hold";
  /** cover name → owning unit name (reservation); prevents two units per slot */
  public readonly coverOwner = new Map<string, string | null>();
  /** a flanker has reached its flanking cover — suppressors stop suppressing & push */
  public flankerReady = false;
  /** number of breachers stacked at the door (E4) */
  public stacked = 0;
  /** absolute clock the synchronized breach must complete by (E4) */
  public breachDeadline = Infinity;
  /** most recent bark per unit, for the view */
  public readonly barks = new Map<string, { text: string; at: number }>();

  constructor(inst: SquadInstance) {
    this.covers = inst.covers;
    this.walls = inst.walls ?? [];
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

  losClear(ax: number, az: number, bx: number, bz: number): boolean {
    for (const w of this.walls) if (segHitsBox(ax, az, bx, bz, w)) return false;
    return true;
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

  /** release any cover `self` holds, then claim `cover` (single-owner). */
  claimCover(self: string, cover: string): void {
    for (const [c, owner] of this.coverOwner) if (owner === self) this.coverOwner.set(c, null);
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
  types: [{ name: "cover" }],
  fluents: [
    // --- self (belief; perception mirrors truth, ungated) ---
    { name: "myPos", kind: "vec2" },
    { name: "myAmmo", kind: "int", initial: AMMO_MAX },
    { name: "myHp", kind: "float", initial: 100 },
    { name: "role", kind: "enum", values: ["assault", "flanker", "suppressor", "leader"], initial: "assault" },
    { name: "tactic", kind: "enum", values: ["hold", "flank", "breach", "regroup"], initial: "hold" },
    { name: "myCover", kind: "entity", entityType: "cover" },
    // --- threat (belief; perception gates by line-of-sight + memory) ---
    { name: "threatPos", kind: "vec2" },
    { name: "threatHp", kind: "float", initial: 100 },
    { name: "threatSeen", kind: "boolean", initial: false },
    // --- squad blackboard (belief; written by the coordinator) ---
    { name: "flankerReady", kind: "boolean", initial: false },
    { name: "stackedReady", kind: "boolean", initial: false },
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
  compounds: [{ name: "Fight" }],
  operators: [
    {
      // seek a free cover (the workhorse move; GOAP picks WHICH cover gives LOS)
      name: "advanceTo",
      params: [{ name: "c", type: "cover" }],
      pre: F.not(F.lit("coverTaken", ["?c"])),
      eff: [
        E.setVec("myPos", [], N.ext("coverX", ["?c"], ["coverPos"]), N.ext("coverZ", ["?c"], ["coverPos"]), undefined, "planOnly"),
        E.set("myCover", [], "?c", "planOnly"),
      ],
      cost: N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.1)),
      duration: N.div(N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.1)), N.c(MOVE_SPEED)),
      executor: "move",
    },
    {
      // move to a flanking cover (coordinated flank tactic); same motion, tagged
      name: "flankTo",
      params: [{ name: "c", type: "cover" }],
      pre: F.and(F.lit("coverFlank", ["?c"]), F.not(F.lit("coverTaken", ["?c"]))),
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
      eff: [
        E.setVec("myPos", [], N.ext("coverX", ["?c"], ["coverPos"]), N.ext("coverZ", ["?c"], ["coverPos"]), undefined, "planOnly"),
        E.set("myCover", [], "?c", "planOnly"),
      ],
      cost: N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.6)),
      duration: N.div(N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.6)), N.c(MOVE_SPEED)),
      executor: "move",
    },
    {
      // stack up at the breach point (E4 synchronized assault)
      name: "moveToBreach",
      params: [{ name: "c", type: "cover" }],
      pre: F.lit("coverBreach", ["?c"]),
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
      eff: [
        E.setVec("myPos", [], N.ext("coverX", ["?c"], ["coverPos"]), N.ext("coverZ", ["?c"], ["coverPos"]), undefined, "planOnly"),
        E.set("myCover", [], "?c", "planOnly"),
      ],
      cost: N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.1)),
      duration: N.div(N.add(N.dist("myPos", [], "coverPos", ["?c"]), N.c(0.1)), N.c(MOVE_SPEED)),
      executor: "move",
    },
    {
      // fire on the threat; reactively aborts the instant line-of-sight is lost
      name: "takeShot",
      pre: F.and(
        F.ext("canSee", [], ["myPos", "threatPos"]),
        F.gt(N.fl("myAmmo"), N.c(0)),
        F.gt(N.fl("threatHp"), N.c(0)),
      ),
      verify: F.ext("canSee", [], ["myPos", "threatPos"]),
      eff: [E.dec("myAmmo", [], N.c(1), "planOnly"), E.dec("threatHp", [], N.c(SHOT_DAMAGE), "planOnly")],
      cost: 1,
      duration: SHOT_TIME,
      executor: "shoot",
    },
    {
      // suppressing fire: pins the target so a flanker can move (chips little HP)
      name: "suppress",
      pre: F.and(F.ext("canSee", [], ["myPos", "threatPos"]), F.gt(N.fl("myAmmo"), N.c(0))),
      verify: F.ext("canSee", [], ["myPos", "threatPos"]),
      eff: [E.dec("myAmmo", [], N.c(1), "planOnly"), E.dec("threatHp", [], N.c(SUPPRESS_DAMAGE), "planOnly")],
      cost: 1,
      duration: 1.2,
      executor: "suppress",
    },
    {
      name: "breach",
      pre: F.lit("stackedReady"),
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
    // 1. hurt → fall back to a rally point
    {
      name: "retreat",
      task: "Fight",
      params: [{ name: "r", type: "cover" }],
      pre: F.and(F.lt(N.fl("myHp"), N.c(LOW_HP)), F.lit("coverRally", ["?r"]), F.not(F.lit("coverTaken", ["?r"]))),
      subtasks: [{ do: "retreatTo", args: ["?r"] }],
    },
    // 2. synchronized breach (E4) — stack up then breach within the deadline window
    {
      name: "breachAssault",
      task: "Fight",
      params: [{ name: "bp", type: "cover" }],
      pre: F.and(F.lit("tactic", [], "breach"), F.lit("coverBreach", ["?bp"])),
      subtasks: [
        { scope: { deadline: BREACH_WINDOW, label: "breach-window" }, subtasks: [{ do: "moveToBreach", args: ["?bp"] }] },
        { do: "breach" },
        { achieve: F.lte(N.fl("threatHp"), N.c(0)) },
      ],
    },
    // 3. assigned flanker → take a flank cover, then neutralize from there
    {
      name: "flankAttack",
      task: "Fight",
      params: [{ name: "fc", type: "cover" }],
      pre: F.and(F.lit("role", [], "flanker"), F.lit("coverFlank", ["?fc"]), F.not(F.lit("coverTaken", ["?fc"]))),
      subtasks: [{ do: "flankTo", args: ["?fc"] }, { achieve: F.lte(N.fl("threatHp"), N.c(0)) }],
    },
    // 4. assigned suppressor → suppress UNTIL the flanker is in position, then push
    {
      name: "suppressCover",
      task: "Fight",
      pre: F.lit("role", [], "suppressor"),
      subtasks: [
        { scope: { maintain: F.not(F.lit("flankerReady")), label: "suppress-cover" }, subtasks: [{ do: "suppress" }] },
        { achieve: F.lte(N.fl("threatHp"), N.c(0)) },
      ],
    },
    // 5. default → neutralize the threat (GOAP discovers seek-LOS-cover + fire)
    {
      name: "assault",
      task: "Fight",
      subtasks: [{ achieve: F.lte(N.fl("threatHp"), N.c(0)) }],
    },
  ],
};

// ---------------------------------------------------------------- registry / model per unit

function buildUnitModel(self: string, world: SquadWorld, inst: SquadInstance): Model {
  const entities: Record<string, string> = {};
  for (const c of inst.covers) entities[c.name] = "cover";
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
      },
      numerics: {
        coverX: (q) => q.vec("coverPos", q.args[0])[0],
        coverZ: (q) => q.vec("coverPos", q.args[0])[1],
      },
      executors: {
        move: moveExecutor(self, world),
        shoot: shootExecutor(self, world),
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
      return { sx: a.x, sz: a.z, t0: api.clock() };
    }) as { sx: number; sz: number; t0: number };
    const d = dist2(mem.sx, mem.sz, cover.x, cover.z);
    const dur = Math.max(0.001, (d + 0.1) / MOVE_SPEED);
    const f = (api.clock() - mem.t0) / dur;
    a.x = lerp(mem.sx, cover.x, f);
    a.z = lerp(mem.sz, cover.z, f);
    a.elevation = cover.high ? 1 : 0;
    if (f >= 1) {
      a.x = cover.x;
      a.z = cover.z;
      if (cover.flank) world.flankerReady = true;
      if (cover.breach) world.stacked += 1;
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
    const dmg = SHOT_DAMAGE * (0.85 + 0.3 * api.rng.next());
    target.hp = Math.max(0, target.hp - dmg);
    if (target.hp <= 0) target.alive = false;
    return "success";
  };
}

function suppressExecutor(self: string, world: SquadWorld): (api: ExecutorApi) => TaskStatus {
  return (api) => {
    const a = world.actors.get(self);
    if (!a || !a.alive) return "failure";
    const target = world.nearestHostile(self, true);
    if (!target) return "failure";
    a.ammo = Math.max(0, a.ammo - 1);
    target.suppressedFor = 1.0; // pinned this beat
    target.hp = Math.max(0, target.hp - SUPPRESS_DAMAGE * api.rng.next());
    // a short burst, then the step completes (the scope keeps us re-suppressing)
    if (api.elapsedInStep() < 1.0) return "continue";
    return "success";
  };
}

function breachExecutor(self: string, world: SquadWorld): (api: ExecutorApi) => TaskStatus {
  return (_api) => {
    const a = world.actors.get(self);
    if (!a || !a.alive) return "failure";
    const target = world.nearestHostile(self, false);
    if (target) {
      target.hp = Math.max(0, target.hp - SHOT_DAMAGE);
      if (target.hp <= 0) target.alive = false;
    }
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
}

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
  bark: string;
  tactic: string;
  status: string;
}

export interface SquadFrame {
  clock: number;
  units: UnitFrame[];
  squadTactic: string;
  flankerReady: boolean;
  /** cover name → owner unit (for the view) */
  reservations: Record<string, string | null>;
}

export interface SquadSimOptions {
  seed?: number;
  /** fixed sim timestep in seconds (deterministic offline rollout) */
  dt?: number;
  /** per-unit planning node budget per tick */
  nodes?: number;
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
  private playerLeg = 0;
  private playerLegT = 0;

  constructor(inst: SquadInstance, opts: SquadSimOptions = {}) {
    this.inst = inst;
    this.dt = opts.dt ?? 0.1;
    this.nodes = opts.nodes ?? 60_000;
    this.world = new SquadWorld(inst);
    let seedBump = 0;
    for (const u of inst.units) {
      if (u.side === "player") continue;
      const model = buildUnitModel(u.name, this.world, inst);
      const trace: TraceEvent[] = [];
      const name = u.name;
      const planner = new Planner(model, {
        goals: [{ kind: "task", name: "Fight" }],
        now: () => this.world.clock,
        seed: (opts.seed ?? 1) + seedBump++,
        weight: 1.6,
        collectRejections: true,
        trace: (e) => {
          trace.push(e);
          this.trace.push({ unit: name, e });
        },
      });
      this.units.push({ name: u.name, side: u.side, role: u.role ?? "assault", model, planner, lastSeen: -Infinity, trace });
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
    for (const c of this.world.covers) {
      const owner = this.world.coverOwner.get(c.name) ?? null;
      setBelief(p, "coverTaken", [c.name], owner !== null && owner !== p.name);
    }
    setBelief(p, "flankerReady", [], this.world.flankerReady);
    setBelief(p, "stackedReady", [], this.world.stacked >= this.countBreachers());
  }

  private countBreachers(): number {
    return Math.max(1, this.units.filter((u) => u.side === "enemy").length);
  }

  // ---- the squad coordinator: assigns roles/tactic into each unit's belief ----
  private coordinate(): void {
    const enemies = this.units.filter((u) => u.side === "enemy" && (this.world.actors.get(u.name)?.alive ?? false));
    const seeing = enemies.filter((u) => this.world.nearestHostile(u.name, true));
    // two-or-more in contact → coordinated flank: one suppresses while one flanks
    if (this.world.squadTactic !== "breach" && seeing.length >= 2) {
      this.world.squadTactic = "flank";
      enemies.forEach((u, i) => {
        u.role = i === 0 ? "suppressor" : i === 1 ? "flanker" : "assault";
      });
    }
    for (const u of enemies) {
      setBelief(u, "role", [], u.role);
      setBelief(u, "tactic", [], this.world.squadTactic === "breach" ? "breach" : this.world.squadTactic === "flank" ? "flank" : "hold");
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
    for (const p of this.units) this.perceive(p);
    this.coordinate();
    // drive each planner (deterministic node budget; round-robin)
    for (const p of this.units) {
      if (!(this.world.actors.get(p.name)?.alive ?? false)) continue;
      p.planner.tick({ nodes: this.nodes });
    }
    this.emitBarks();
    return this.snapshot();
  }

  private emitBarks(): void {
    for (const p of this.units) {
      const recent = p.trace.slice(-6);
      for (const e of recent) {
        const text = barkFor(e);
        if (text) this.world.bark(p.name, text);
      }
    }
  }

  snapshot(): SquadFrame {
    return {
      clock: round(this.world.clock),
      squadTactic: this.world.squadTactic,
      flankerReady: this.world.flankerReady,
      reservations: Object.fromEntries(this.world.coverOwner),
      units: [...this.world.actors.values()].map((a) => {
        const up = this.units.find((u) => u.name === a.name);
        const step = up?.planner.currentStep();
        const stepLabel = step && step.k === "op" ? up!.model.describeGroundOp(step.g) : step ? step.k : "—";
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
          bark: this.world.barks.get(a.name)?.text ?? "",
          tactic: up ? (this.world.squadTactic === "breach" ? "breach" : this.world.squadTactic) : "—",
          status: up?.planner.getStatus() ?? "—",
        };
      }),
    };
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

  engagementOver(): boolean {
    const anyEnemyAlive = this.units.some((u) => u.side === "enemy" && (this.world.actors.get(u.name)?.alive ?? false));
    const anyTargetAlive = [...this.world.actors.values()].some((a) => a.alive && a.side !== "enemy");
    return !anyEnemyAlive || !anyTargetAlive;
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------- barks (trace → utterance)

/** Map a trace event to a combat bark — the seam an LLM later rewrites. */
export function barkFor(e: TraceEvent): string | null {
  if (e.t === "step.start") {
    if (e.label.startsWith("flankTo")) return "Flanking — moving!";
    if (e.label.startsWith("advanceTo")) return "Moving up!";
    if (e.label.startsWith("climbTo")) return "Taking the high ground!";
    if (e.label.startsWith("moveToBreach")) return "Stacking up!";
    if (e.label.startsWith("breach")) return "Breaching — go go go!";
    if (e.label.startsWith("takeShot")) return "Engaging!";
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

/** Baseline skirmish: two NPCs flush a player crossing open ground (matches F.E.A.R.). */
export function skirmishInstance(): SquadInstance {
  return {
    units: [
      { name: "E1", side: "enemy", x: -6, z: -5, role: "suppressor" },
      { name: "E2", side: "enemy", x: -6, z: 5, role: "flanker" },
      { name: "player", side: "player", x: 8, z: 0, hp: 100 },
    ],
    covers: [
      { name: "cN", x: -2, z: -4 },
      { name: "cS", x: -2, z: 4 },
      { name: "cMid", x: 0, z: 0 },
      { name: "fNorth", x: 4, z: -6, flank: true },
      { name: "fSouth", x: 4, z: 6, flank: true },
      { name: "rally", x: -8, z: 0, rally: true },
    ],
    walls: [{ x: 1, z: -2, w: 1.5, d: 4 }],
    playerPath: [
      { x: 8, z: 0 },
      { x: 2, z: 0 },
    ],
    playerDwell: 1,
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
