/**
 * Dive — a real-time deathmatch-shooter AI, modelled on Mugen87's "Dive" demo
 * (built on the Yuka game-AI library) but driven entirely by **htn-ai**.
 *
 * Where Dive wires together Yuka's `Think` goal-evaluators, `CompositeGoal`
 * trees, steering, navmesh and perception, this scenario keeps the SAME bot brain
 * — attack / get-health / get-weapon / explore arbitration, hunt-the-last-seen,
 * fight-from-sight, item pickups, weapon selection, death + respawn — but the
 * *decision layer is our planner*:
 *
 *   • One Model + reactive Planner per AI combatant (free-for-all). Each planner's
 *     ExecState IS that bot's belief / working memory (perception mirrors truth
 *     into it, gated by line-of-sight + memory decay).
 *   • Dive's GoalEvaluator desirabilities (attack/health/weapon/explore) become
 *     the *utilities* on the root `Compete` task's methods — the planner's
 *     utility-ordered method selection IS the arbitration. The HTN decomposition
 *     (Attack → engage-from-sight | hunt-last-seen) mirrors Dive's CompositeGoals.
 *   • Executors are the thin bridge down to the continuous world (a stand-in for
 *     Dive's steering + weapon controller): they command motion/fire and report
 *     running / success / failure; the world integrates kinematics and resolves
 *     pickups, hits, deaths and respawns. Steering, navmesh and physics stay OUT
 *     of the planner — exactly the planner/controller/world split Dive blurs.
 *
 * Shared by tests/dive.ts (ground-truth assertions) and the web preview.
 */
import {
  type DomainDoc,
  type ExecutorApi,
  type Model,
  type Planner as PlannerT,
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

export const MAX_HEALTH = 100;
export const MOVE_SPEED = 4.0; // world units / second
export const SIGHT_RANGE = 24;
export const MEMORY_SECONDS = 4; // how long a lost target is hunted before it's forgotten
export const PICKUP_RADIUS = 1.1; // touch an item to collect it
export const ITEM_RESPAWN = 8; // seconds an item takes to come back after pickup
export const RESPAWN_DELAY = 3; // seconds a dead bot waits before respawning
export const HEALTH_PACK_AMOUNT = 40;
export const WANT_HEALTH_BELOW = 0.9; // seek health once below this fraction
export const UNIT_RADIUS = 0.5;

/** Weapon stats. The blaster is the always-available fallback (infinite ammo). */
export type WeaponType = "blaster" | "shotgun" | "rifle";
export interface WeaponStats {
  damage: number;
  fireTime: number; // seconds between shots
  maxAmmo: number; // Infinity for the blaster
  idealRange: number; // distance of peak effectiveness (drives weapon selection)
  accuracyClose: number;
  accuracyFar: number;
}
export const WEAPONS: Record<WeaponType, WeaponStats> = {
  blaster: { damage: 12, fireTime: 0.5, maxAmmo: Infinity, idealRange: 10, accuracyClose: 0.9, accuracyFar: 0.4 },
  shotgun: { damage: 34, fireTime: 0.8, maxAmmo: 12, idealRange: 4, accuracyClose: 0.95, accuracyFar: 0.12 },
  rifle: { damage: 20, fireTime: 0.25, maxAmmo: 30, idealRange: 16, accuracyClose: 0.8, accuracyFar: 0.7 },
};
export const ALL_WEAPONS: WeaponType[] = ["blaster", "shotgun", "rifle"];

// ---------------------------------------------------------------- instance shapes

export interface Vec2 {
  x: number;
  z: number;
}

/** Axis-aligned obstacle that blocks line-of-sight AND movement. */
export interface BoxSpec {
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface ItemSpec {
  name: string;
  x: number;
  z: number;
  kind: "health" | "weapon";
  /** the weapon a "weapon" item grants (and refills ammo for) */
  weapon?: WeaponType;
}

export interface BotSpec {
  name: string;
  x: number;
  z: number;
  /** display colour for the view */
  color?: string;
}

export interface DiveInstance {
  /** the arena bounds: play area is [-halfW, halfW] × [-halfD, halfD] */
  halfWidth: number;
  halfDepth: number;
  bots: BotSpec[];
  items: ItemSpec[];
  obstacles: BoxSpec[];
  /** explicit spawn points; bots respawn at the one furthest from danger */
  spawns: Vec2[];
}

// ---------------------------------------------------------------- ground-truth world

interface Combatant {
  name: string;
  color: string;
  x: number;
  z: number;
  /** facing (for the view + human aim) */
  heading: number;
  hp: number;
  alive: boolean;
  respawnAt: number;
  /** ammo per weapon; blaster is Infinity */
  ammo: Map<WeaponType, number>;
  weapon: WeaponType;
  frags: number;
  deaths: number;
  control: "ai" | "human";
  /** the believed last-seen position of this bot's current quarry (set by perception);
   *  the hunt executor walks to it (kept on the actor so the executor needn't read a vec belief) */
  huntTarget: Vec2 | null;
  /** human input intent (when control === "human") */
  input: { moveX: number; moveZ: number; aim: number; shoot: boolean };
}

interface ItemState extends ItemSpec {
  active: boolean;
  respawnAt: number;
}

/** A fired shot this tick — for tracer rendering. */
export interface Shot {
  from: Vec2;
  to: Vec2;
  by: string;
  hit: boolean;
  kind: WeaponType;
}

function dist2(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

/** Segment (a→b) vs axis-aligned box intersection — line-of-sight test (slab method). */
function segHitsBox(ax: number, az: number, bx: number, bz: number, b: BoxSpec): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, ax - b.x],
    [dx, b.x + b.w - ax],
    [-dz, az - b.z],
    [dz, b.z + b.d - az],
  ] as [number, number][]) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
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

/** The four padded corners of a box, as candidate path waypoints. */
function boxCorners(b: BoxSpec, pad: number): Vec2[] {
  return [
    { x: b.x - pad, z: b.z - pad },
    { x: b.x + b.w + pad, z: b.z - pad },
    { x: b.x - pad, z: b.z + b.d + pad },
    { x: b.x + b.w + pad, z: b.z + b.d + pad },
  ];
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

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}

/**
 * The shared deathmatch world: ground-truth combatant kinematics + vitals, item
 * states, the static arena geometry, and this tick's fired shots. Belief lives in
 * each planner's ExecState; this is truth. A stand-in for Dive's three.js world +
 * Yuka EntityManager (steering, navmesh, weapon system, spawning).
 */
export class DiveWorld {
  public clock = 0;
  public readonly actors = new Map<string, Combatant>();
  public readonly items: ItemState[];
  public readonly obstacles: BoxSpec[];
  public readonly spawns: Vec2[];
  public readonly halfWidth: number;
  public readonly halfDepth: number;
  /** shots fired during the most recent step (rendered as tracers) */
  public shots: Shot[] = [];

  constructor(inst: DiveInstance) {
    this.halfWidth = inst.halfWidth;
    this.halfDepth = inst.halfDepth;
    this.obstacles = inst.obstacles;
    this.spawns = inst.spawns;
    this.items = inst.items.map((it) => ({ ...it, active: true, respawnAt: 0 }));
    for (const b of inst.bots) {
      this.actors.set(b.name, this.freshActor(b.name, b.color ?? "#38bdf8", b.x, b.z));
    }
  }

  private freshActor(name: string, color: string, x: number, z: number): Combatant {
    const ammo = new Map<WeaponType, number>();
    for (const w of ALL_WEAPONS) ammo.set(w, w === "blaster" ? Infinity : 0);
    return {
      name,
      color,
      x,
      z,
      heading: 0,
      hp: MAX_HEALTH,
      alive: true,
      respawnAt: 0,
      ammo,
      weapon: "blaster",
      frags: 0,
      deaths: 0,
      control: "ai",
      huntTarget: null,
      input: { moveX: 0, moveZ: 0, aim: 0, shoot: false },
    };
  }

  /** clamp a point to the arena and out of any obstacle (cheap push-out). */
  clampToArena(x: number, z: number): Vec2 {
    let cx = Math.max(-this.halfWidth, Math.min(this.halfWidth, x));
    let cz = Math.max(-this.halfDepth, Math.min(this.halfDepth, z));
    for (const o of this.obstacles) {
      if (cx > o.x - UNIT_RADIUS && cx < o.x + o.w + UNIT_RADIUS && cz > o.z - UNIT_RADIUS && cz < o.z + o.d + UNIT_RADIUS) {
        // push to the nearest edge
        const toLeft = cx - (o.x - UNIT_RADIUS);
        const toRight = o.x + o.w + UNIT_RADIUS - cx;
        const toTop = cz - (o.z - UNIT_RADIUS);
        const toBottom = o.z + o.d + UNIT_RADIUS - cz;
        const m = Math.min(toLeft, toRight, toTop, toBottom);
        if (m === toLeft) cx = o.x - UNIT_RADIUS;
        else if (m === toRight) cx = o.x + o.w + UNIT_RADIUS;
        else if (m === toTop) cz = o.z - UNIT_RADIUS;
        else cz = o.z + o.d + UNIT_RADIUS;
      }
    }
    return { x: cx, z: cz };
  }

  losClear(ax: number, az: number, bx: number, bz: number): boolean {
    for (const o of this.obstacles) if (segHitsBox(ax, az, bx, bz, o)) return false;
    return true;
  }

  /** every other living combatant (free-for-all — everyone is hostile to everyone). */
  enemiesOf(self: string): Combatant[] {
    return [...this.actors.values()].filter((a) => a.alive && a.name !== self);
  }

  /** nearest living enemy, optionally requiring an unobstructed line of sight in range. */
  nearestEnemy(self: string, requireLos: boolean): Combatant | null {
    const me = this.actors.get(self);
    if (!me) return null;
    let best: Combatant | null = null;
    let bestD = Infinity;
    for (const other of this.enemiesOf(self)) {
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

  /** Probability a shot from `shooter` (using its current weapon) lands on `target`. */
  hitChance(shooter: Combatant, target: Combatant): number {
    const w = WEAPONS[shooter.weapon];
    const d = dist2(shooter.x, shooter.z, target.x, target.z);
    const t = Math.min(1, d / SIGHT_RANGE);
    return Math.max(0.02, w.accuracyClose + (w.accuracyFar - w.accuracyClose) * t);
  }

  /** ammo fraction the bot holds for a weapon (1 for the blaster — always topped up). */
  ammoFraction(a: Combatant, w: WeaponType): number {
    const max = WEAPONS[w].maxAmmo;
    if (!isFinite(max)) return 1;
    return Math.min(1, (a.ammo.get(w) ?? 0) / max);
  }

  /** average weapon strength across the arsenal — drives the attack desirability. */
  weaponStrength(a: Combatant): number {
    let s = 0;
    for (const w of ALL_WEAPONS) s += this.ammoFraction(a, w);
    return s / ALL_WEAPONS.length;
  }

  /** Shortest walkable path from (ax,az) to (bx,bz) around obstacles (visibility
   *  graph over padded box corners + Dijkstra). Returns waypoints incl. the goal. */
  findPath(ax: number, az: number, bx: number, bz: number): Vec2[] {
    if (this.losClear(ax, az, bx, bz)) return [{ x: bx, z: bz }];
    const pad = UNIT_RADIUS + 0.4;
    const inside = (p: Vec2) => this.obstacles.some((o) => p.x > o.x - 0.01 && p.x < o.x + o.w + 0.01 && p.z > o.z - 0.01 && p.z < o.z + o.d + 0.01);
    const nodes: Vec2[] = [{ x: ax, z: az }, ...this.obstacles.flatMap((o) => boxCorners(o, pad)).filter((c) => !inside(c)), { x: bx, z: bz }];
    const n = nodes.length;
    const clear = (i: number, j: number) => this.losClear(nodes[i].x, nodes[i].z, nodes[j].x, nodes[j].z);
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
    if (dist[n - 1] === Infinity) return [{ x: bx, z: bz }];
    const path: Vec2[] = [];
    for (let cur = n - 1; cur > 0; cur = prev[cur]) path.unshift({ x: nodes[cur].x, z: nodes[cur].z });
    return path;
  }

  /** fire `shooter`'s current weapon at `target`; rolls the seeded RNG, applies damage,
   *  records a tracer, and handles the kill (frags / death / respawn timer). */
  fire(shooter: Combatant, target: Combatant, rng: () => number): boolean {
    const w = WEAPONS[shooter.weapon];
    if (isFinite(w.maxAmmo)) shooter.ammo.set(shooter.weapon, Math.max(0, (shooter.ammo.get(shooter.weapon) ?? 0) - 1));
    const hit = rng() < this.hitChance(shooter, target);
    this.shots.push({ from: { x: shooter.x, z: shooter.z }, to: { x: target.x, z: target.z }, by: shooter.name, hit, kind: shooter.weapon });
    if (hit) {
      target.hp = Math.max(0, target.hp - w.damage);
      if (target.hp <= 0 && target.alive) this.kill(shooter, target);
    }
    return hit;
  }

  private kill(killer: Combatant, victim: Combatant): void {
    victim.alive = false;
    victim.respawnAt = this.clock + RESPAWN_DELAY;
    victim.deaths += 1;
    if (killer.name !== victim.name) killer.frags += 1;
  }

  /** the spawn point furthest from the nearest living enemy (avoid spawning into a fight). */
  bestSpawn(self: string): Vec2 {
    let best = this.spawns[0];
    let bestScore = -Infinity;
    for (const s of this.spawns) {
      let nearestFoe = Infinity;
      for (const a of this.actors.values()) if (a.alive && a.name !== self) nearestFoe = Math.min(nearestFoe, dist2(s.x, s.z, a.x, a.z));
      if (nearestFoe > bestScore) {
        bestScore = nearestFoe;
        best = s;
      }
    }
    return best;
  }

  /** respawn a fallen combatant at a safe point with a fresh blaster loadout. */
  respawn(a: Combatant): void {
    const s = this.bestSpawn(a.name);
    a.x = s.x;
    a.z = s.z;
    a.hp = MAX_HEALTH;
    a.alive = true;
    a.respawnAt = 0;
    a.weapon = "blaster";
    a.huntTarget = null;
    for (const w of ALL_WEAPONS) a.ammo.set(w, w === "blaster" ? Infinity : 0);
  }
}

// ---------------------------------------------------------------- the domain (one POV)

/**
 * The deathmatch bot brain, authored from one combatant's point of view. Every AI
 * bot runs this same domain; only its identity (perception, executors) differs.
 *
 * The root task `Compete` is the goal arbitration: its four methods are Dive's
 * four GoalEvaluators, and their `utility` expressions are the desirabilities
 * (computed by perception, the "Feature" layer). Utility-ordered method selection
 * picks the most desirable goal each beat — exactly `Think.arbitrate()`.
 */
export const diveDomain: DomainDoc = {
  name: "dive",
  types: [{ name: "item" }, { name: "spot" }],
  fluents: [
    // --- self (belief; perception mirrors truth) ---
    { name: "myPos", kind: "vec2" },
    { name: "myHp", kind: "float", initial: MAX_HEALTH },
    { name: "weaponStrength", kind: "float", initial: 1 },
    // --- threat (belief; gated by line-of-sight + memory decay) ---
    { name: "hasTarget", kind: "boolean", initial: false }, // a position fix (sight or recent memory)
    { name: "targetVisible", kind: "boolean", initial: false }, // a current line of sight
    { name: "targetPos", kind: "vec2" },
    { name: "targetHp", kind: "float", initial: MAX_HEALTH },
    // desirability of attacking right now (weaponStrength × health) — Dive's AttackEvaluator
    { name: "attackDesire", kind: "float", initial: 0 },
    // the explore waypoint chosen for this beat (perception picks one; isExplore binds it)
    { name: "exploreSpot", kind: "entity", entityType: "spot" },
    // --- items (static descriptors + dynamic desirability, set by perception) ---
    { name: "itemPos", params: [{ name: "i", type: "item" }], kind: "vec2" },
    { name: "itemActive", params: [{ name: "i", type: "item" }], kind: "boolean", initial: false },
    { name: "itemWanted", params: [{ name: "i", type: "item" }], kind: "boolean", initial: false },
    // desirability of fetching this item — Dive's GetHealth/GetWeapon evaluators
    { name: "itemDesire", params: [{ name: "i", type: "item" }], kind: "float", initial: 0 },
    // --- spots (static walkable waypoints) ---
    { name: "spotPos", params: [{ name: "s", type: "spot" }], kind: "vec2" },
  ],
  compounds: [{ name: "Compete" }, { name: "Attack" }, { name: "Explore" }],
  operators: [
    {
      // walk to an item and collect it (the world grants it on contact). Reactively
      // aborts if someone else grabs it first (itemActive drops → repair).
      name: "pickup",
      params: [{ name: "i", type: "item" }],
      pre: F.lit("itemActive", ["?i"]),
      verify: F.lit("itemActive", ["?i"]),
      eff: [E.setVec("myPos", [], N.ext("itemX", ["?i"], ["itemPos"]), N.ext("itemZ", ["?i"], ["itemPos"]), undefined, "planOnly")],
      cost: N.add(N.dist("myPos", [], "itemPos", ["?i"]), N.c(0.1)),
      duration: N.div(N.add(N.dist("myPos", [], "itemPos", ["?i"]), N.c(0.1)), N.c(MOVE_SPEED)),
      executor: "pickup",
    },
    {
      // fire on the visible target; chips its (believed) HP. Reactively aborts the
      // instant line-of-sight is lost (verify targetVisible) → Attack falls to hunt.
      name: "fight",
      pre: F.and(F.lit("hasTarget"), F.lit("targetVisible"), F.gt(N.fl("targetHp"), N.c(0))),
      verify: F.lit("targetVisible"),
      eff: [E.dec("targetHp", [], N.ext("shotDamage", [], ["myPos", "targetPos"]), "planOnly")],
      cost: 1,
      duration: N.c(0.3),
      executor: "fight",
    },
    {
      // hunt the last-seen position when the target is no longer visible (in memory
      // but out of sight) — the F.E.A.R./Dive "search the last-known position" beat
      name: "huntTo",
      pre: F.and(F.lit("hasTarget"), F.not(F.lit("targetVisible"))),
      eff: [E.setVec("myPos", [], N.ext("targetX", [], ["targetPos"]), N.ext("targetZ", [], ["targetPos"]), undefined, "planOnly")],
      cost: N.add(N.dist("myPos", [], "targetPos", []), N.c(0.1)),
      duration: N.div(N.add(N.dist("myPos", [], "targetPos", []), N.c(0.1)), N.c(MOVE_SPEED)),
      executor: "hunt",
    },
    {
      // roam to a tactical waypoint to look for opponents and items
      name: "roamTo",
      params: [{ name: "s", type: "spot" }],
      pre: F.ext("isExplore", ["?s"], ["exploreSpot"]),
      verify: F.ext("isExplore", ["?s"], ["exploreSpot"]),
      eff: [E.setVec("myPos", [], N.ext("spotX", ["?s"], ["spotPos"]), N.ext("spotZ", ["?s"], ["spotPos"]), undefined, "planOnly")],
      cost: N.add(N.dist("myPos", [], "spotPos", ["?s"]), N.c(0.1)),
      duration: N.div(N.add(N.dist("myPos", [], "spotPos", ["?s"]), N.c(0.1)), N.c(MOVE_SPEED)),
      executor: "roam",
    },
  ],
  methods: [
    // ---- root arbitration: Dive's four GoalEvaluators, ordered by desirability ----
    {
      // GET ITEM (health or weapon) — fires when an item is wanted; desirability is
      // (need × nearness), computed by perception. Covers GetHealth + GetWeapon.
      name: "getItem",
      task: "Compete",
      params: [{ name: "i", type: "item" }],
      pre: F.and(F.lit("itemActive", ["?i"]), F.lit("itemWanted", ["?i"])),
      utility: N.fl("itemDesire", "?i"),
      subtasks: [{ do: "pickup", args: ["?i"] }],
    },
    {
      // ATTACK — fight the current target; desirability is weaponStrength × health
      name: "attack",
      task: "Compete",
      pre: F.lit("hasTarget"),
      utility: N.fl("attackDesire"),
      subtasks: [{ do: "Attack" }],
    },
    {
      // EXPLORE — the low, constant-desirability default (always applicable)
      name: "explore",
      task: "Compete",
      utility: N.c(0.1),
      subtasks: [{ do: "Explore" }],
    },
    // ---- Attack: engage from sight, else hunt the last-seen position ----
    {
      name: "engage",
      task: "Attack",
      pre: F.and(F.lit("hasTarget"), F.lit("targetVisible")),
      // keep firing WHILE we have a line of sight; losing it violates the scope and
      // the planner re-decides (→ hunt) on the next beat
      subtasks: [{ scope: { maintain: F.lit("targetVisible"), label: "in-sight" }, subtasks: [{ do: "fight" }] }],
    },
    {
      name: "hunt",
      task: "Attack",
      pre: F.lit("hasTarget"),
      subtasks: [{ do: "huntTo" }],
    },
    {
      // there's a target fix but no actionable move right now → hold a short beat
      name: "holdAttack",
      task: "Attack",
      pre: F.lit("hasTarget"),
      subtasks: [{ hold: 0.3 }],
    },
    // ---- Explore: roam to the chosen waypoint, else idle briefly ----
    {
      name: "roam",
      task: "Explore",
      params: [{ name: "s", type: "spot" }],
      pre: F.ext("isExplore", ["?s"], ["exploreSpot"]),
      subtasks: [{ do: "roamTo", args: ["?s"] }],
    },
    {
      name: "idle",
      task: "Explore",
      subtasks: [{ hold: 0.4 }],
    },
  ],
};

// ---------------------------------------------------------------- registry / model per unit

function buildBotModel(self: string, world: DiveWorld, items: ItemSpec[], spots: Vec2[]): Model {
  const entities: Record<string, string> = {};
  for (const it of items) entities[it.name] = "item";
  const spotNames = spots.map((_, i) => `spot${i}`);
  for (const s of spotNames) entities[s] = "spot";
  return createModel(
    diveDomain,
    {
      entities,
      init: (w) => {
        for (const it of items) {
          w.set("itemPos", [it.name], [it.x, it.z]);
          w.set("itemActive", [it.name], true);
        }
        for (let i = 0; i < spots.length; i++) w.set("spotPos", [spotNames[i]], [spots[i].x, spots[i].z]);
        const me = world.actors.get(self);
        if (me) {
          w.set("myPos", [], [me.x, me.z]);
          w.set("myHp", [], me.hp);
        }
      },
    },
    {
      predicates: {
        // is `s` the explore waypoint perception chose this beat? (entities encode gid+1)
        isExplore: (q) => Math.round(q.get("exploreSpot")) === q.args[0] + 1,
      },
      numerics: {
        itemX: (q) => q.vec("itemPos", q.args[0])[0],
        itemZ: (q) => q.vec("itemPos", q.args[0])[1],
        spotX: (q) => q.vec("spotPos", q.args[0])[0],
        spotZ: (q) => q.vec("spotPos", q.args[0])[1],
        targetX: (q) => q.vec("targetPos")[0],
        targetZ: (q) => q.vec("targetPos")[1],
        // expected damage of a shot at the target from my position (range falloff ×
        // current weapon) — drives the planner toward closing for accuracy
        shotDamage: (q) => {
          const me = world.actors.get(self);
          if (!me) return WEAPONS.blaster.damage;
          const m = q.vec("myPos");
          const t = q.vec("targetPos");
          const w = WEAPONS[me.weapon];
          const tf = Math.min(1, dist2(m[0], m[1], t[0], t[1]) / SIGHT_RANGE);
          return w.damage * Math.max(0.12, w.accuracyClose + (w.accuracyFar - w.accuracyClose) * tf);
        },
      },
      executors: {
        pickup: moveExecutor(self, world, (api) => {
          const it = world.items.find((x) => x.name === api.model.entityName(api.args[0]));
          return it && it.active ? { x: it.x, z: it.z } : null;
        }),
        hunt: moveExecutor(self, world, () => world.actors.get(self)?.huntTarget ?? null),
        roam: moveExecutor(self, world, (api) => {
          const name = api.model.entityName(api.args[0]);
          const i = Number(name.replace("spot", ""));
          return spots[i] ?? null;
        }),
        fight: fightExecutor(self, world),
      },
    },
  );
}

// ---------------------------------------------------------------- executors (enact on the world)

/** A generic "walk to a point" executor. `resolve` yields the live destination (or
 *  null → failure/repair). Motion is clock-based and pathfinds around obstacles. */
function moveExecutor(self: string, world: DiveWorld, resolve: (api: ExecutorApi) => Vec2 | null): (api: ExecutorApi) => TaskStatus {
  return (api) => {
    const a = world.actors.get(self);
    if (!a || !a.alive) return "failure";
    const dst = resolve(api);
    if (!dst) return "failure";
    const mem = api.remember(() => ({ path: [{ x: a.x, z: a.z }, ...world.findPath(a.x, a.z, dst.x, dst.z)], t0: api.clock() })) as { path: Vec2[]; t0: number };
    const traveled = (api.clock() - mem.t0) * MOVE_SPEED;
    const at = walkPolyline(mem.path, traveled);
    if (at.x !== a.x || at.z !== a.z) a.heading = Math.atan2(at.x - a.x, at.z - a.z);
    a.x = at.x;
    a.z = at.z;
    if (at.done || dist2(a.x, a.z, dst.x, dst.z) <= PICKUP_RADIUS) return "success";
    return "continue";
  };
}

/** Fire the current weapon at the nearest visible enemy at the weapon's fire rate;
 *  success on a kill, failure when the line of sight is lost (→ hunt). Mirrors Dive's
 *  weapon-system "shoot" loop; weapon SELECTION happens in perception. */
function fightExecutor(self: string, world: DiveWorld): (api: ExecutorApi) => TaskStatus {
  return (api) => {
    const a = world.actors.get(self);
    if (!a || !a.alive) return "failure";
    const target = world.nearestEnemy(self, true);
    if (!target) return "failure"; // lost the shot → repair / hunt
    a.heading = Math.atan2(target.x - a.x, target.z - a.z);
    const mem = api.remember(() => ({ next: 0 })) as { next: number };
    const el = api.elapsedInStep();
    const fireTime = WEAPONS[a.weapon].fireTime;
    // out of ammo on the selected weapon → drop to the blaster (always loaded)
    if (a.weapon !== "blaster" && (a.ammo.get(a.weapon) ?? 0) <= 0) a.weapon = "blaster";
    if (el >= mem.next) {
      mem.next = el + fireTime;
      world.fire(a, target, () => api.rng.next());
      if (!target.alive) return "success"; // target down
    }
    return "continue";
  };
}

// ---------------------------------------------------------------- belief write helpers

function setBelief(p: BotPlanner, fluent: string, args: (string | number)[], value: number | string | boolean): void {
  const gids = args.map((x) => (typeof x === "string" ? p.model.entityId(x) : x));
  p.planner.state.set(p.model.slotOf(fluent, ...gids), p.model.encodeValue(fluent, value));
}

function setBeliefVec(p: BotPlanner, fluent: string, args: (string | number)[], x: number, z: number): void {
  const gids = args.map((a) => (typeof a === "string" ? p.model.entityId(a) : a));
  const slot = p.model.slotOf(fluent, ...gids);
  p.planner.state.set(slot, x);
  p.planner.state.set(slot + 1, z);
}

// ---------------------------------------------------------------- per-bot planner wrapper

export interface BotPlanner {
  name: string;
  model: Model;
  planner: PlannerT;
  /** per-enemy memory: last-seen position / time / current visibility */
  memory: Map<string, { x: number; z: number; lastSeen: number; visible: boolean; hp: number }>;
  /** the explore waypoint currently being walked to (held stable until reached) */
  exploreIdx: number | null;
  trace: TraceEvent[];
}

// ---------------------------------------------------------------- frames (snapshot for the view)

export interface BotFrame {
  name: string;
  color: string;
  x: number;
  z: number;
  heading: number;
  hp: number;
  alive: boolean;
  weapon: WeaponType;
  ammo: number; // ammo of the current weapon (Infinity → -1)
  frags: number;
  deaths: number;
  control: "ai" | "human";
  /** label of the step currently executing */
  step: string;
  /** human-readable verb for what the bot is doing */
  action: string;
  /** the enemy it currently sees / is firing on */
  sees: string | null;
  goalText: string;
  plan: string[];
  events: string[];
  replanning: boolean;
}

export interface ItemFrame {
  name: string;
  x: number;
  z: number;
  kind: "health" | "weapon";
  weapon?: WeaponType;
  active: boolean;
}

export interface DiveFrame {
  clock: number;
  halfWidth: number;
  halfDepth: number;
  bots: BotFrame[];
  items: ItemFrame[];
  obstacles: BoxSpec[];
  spots: Vec2[];
  shots: Shot[];
  scoreboard: { name: string; color: string; frags: number; deaths: number }[];
}

export interface DiveSimOptions {
  seed?: number;
  /** fixed sim timestep in seconds */
  dt?: number;
  /** per-bot planning node budget per tick */
  nodes?: number;
  /** frag count that ends the match (offline rollout) */
  fragLimit?: number;
}

/**
 * Headless, deterministic deathmatch simulation: one reactive Planner per AI bot
 * over a shared world, with a perception step between ticks. One bot can be handed
 * to a human (control = "human") — its planner is dropped and its motion/fire come
 * from `setInput`. Used verbatim by tests and the web preview.
 */
export class DiveSim {
  public readonly world: DiveWorld;
  public readonly bots = new Map<string, BotPlanner>();
  public readonly trace: { unit: string; e: TraceEvent }[] = [];
  public readonly spots: Vec2[];
  private readonly items: ItemSpec[];
  private readonly dt: number;
  private readonly nodes: number;
  private readonly fragLimit: number;
  private readonly seed: number;
  private seedBump = 0;
  /** seeded RNG for explore-waypoint choice (kept separate from planner RNGs) */
  private exploreRng: () => number;

  constructor(inst: DiveInstance, opts: DiveSimOptions = {}) {
    this.dt = opts.dt ?? 0.1;
    this.nodes = opts.nodes ?? 20_000;
    this.fragLimit = opts.fragLimit ?? Infinity;
    this.seed = opts.seed ?? 1;
    this.items = inst.items;
    this.world = new DiveWorld(inst);
    this.spots = generateSpots(inst);
    this.exploreRng = mulberry32(this.seed * 7919 + 17);
    for (const b of inst.bots) this.bots.set(b.name, this.buildPlanner(b.name));
  }

  private buildPlanner(name: string): BotPlanner {
    const model = buildBotModel(name, this.world, this.items, this.spots);
    const trace: TraceEvent[] = [];
    const entry: BotPlanner = { name, model, planner: undefined as unknown as PlannerT, memory: new Map(), exploreIdx: null, trace };
    entry.planner = new Planner(model, {
      goals: [{ kind: "task", name: "Compete" }],
      now: () => this.world.clock,
      seed: this.seed + this.seedBump++,
      weight: 1.4,
      collectRejections: true,
      trace: (e) => {
        trace.push(e);
        this.trace.push({ unit: name, e });
      },
    });
    return entry;
  }

  /** hand a bot to a human (drops its planner) or back to the AI (rebuilds it). */
  setControl(name: string, control: "ai" | "human"): void {
    const a = this.world.actors.get(name);
    if (!a || a.control === control) return;
    a.control = control;
    a.input = { moveX: 0, moveZ: 0, aim: a.heading, shoot: false };
    if (control === "ai") {
      this.bots.set(name, this.buildPlanner(name));
    } else {
      this.bots.delete(name);
    }
  }

  /** set a human-controlled bot's input intent for the coming ticks. */
  setInput(name: string, input: Partial<Combatant["input"]>): void {
    const a = this.world.actors.get(name);
    if (!a || a.control !== "human") return;
    a.input = { ...a.input, ...input };
  }

  /** select the best weapon for the current target distance (Dive's fuzzy weapon
   *  selection, here a simple rule table over ideal ranges among weapons with ammo). */
  private selectWeapon(a: Combatant): void {
    const target = this.world.nearestEnemy(a.name, true);
    const d = target ? dist2(a.x, a.z, target.x, target.z) : Infinity;
    let best: WeaponType = "blaster";
    let bestScore = -Infinity;
    for (const w of ALL_WEAPONS) {
      if (w !== "blaster" && (a.ammo.get(w) ?? 0) <= 0) continue;
      // prefer the weapon whose ideal range is closest to the engagement distance;
      // a stronger weapon wins ties (more damage potential)
      const score = -Math.abs(WEAPONS[w].idealRange - (isFinite(d) ? d : WEAPONS[w].idealRange)) + WEAPONS[w].damage * 0.1;
      if (score > bestScore) {
        bestScore = score;
        best = w;
      }
    }
    a.weapon = best;
  }

  // ---- perception: world (truth) → each bot's ExecState (belief) ----
  private perceive(p: BotPlanner): void {
    const a = this.world.actors.get(p.name);
    if (!a) return;
    setBeliefVec(p, "myPos", [], a.x, a.z);
    setBelief(p, "myHp", [], a.hp);
    setBelief(p, "weaponStrength", [], this.world.weaponStrength(a));

    // weapon selection (the controller's job — runs before we reason about attacking)
    this.selectWeapon(a);

    // sight + memory: update the per-enemy record, then pick the target like Dive's
    // TargetSystem — the closest visible foe, else the most-recently-seen within memory.
    for (const e of this.world.enemiesOf(p.name)) {
      const los = dist2(a.x, a.z, e.x, e.z) <= SIGHT_RANGE && this.world.losClear(a.x, a.z, e.x, e.z);
      const rec = p.memory.get(e.name) ?? { x: e.x, z: e.z, lastSeen: -Infinity, visible: false, hp: MAX_HEALTH };
      if (los) {
        rec.x = e.x;
        rec.z = e.z;
        rec.lastSeen = this.world.clock;
        rec.visible = true;
        rec.hp = e.hp;
      } else {
        rec.visible = false;
      }
      p.memory.set(e.name, rec);
    }
    // drop stale / dead memories
    for (const [name, rec] of p.memory) {
      const e = this.world.actors.get(name);
      if (!e || !e.alive || this.world.clock - rec.lastSeen > MEMORY_SECONDS) p.memory.delete(name);
    }
    // pick the target
    let target: { name: string; rec: { x: number; z: number; visible: boolean; lastSeen: number; hp: number } } | null = null;
    for (const [name, rec] of p.memory) {
      if (rec.visible) {
        if (!target || !target.rec.visible || dist2(a.x, a.z, rec.x, rec.z) < dist2(a.x, a.z, target.rec.x, target.rec.z)) target = { name, rec };
      } else if (!target || (!target.rec.visible && rec.lastSeen > target.rec.lastSeen)) {
        if (!target) target = { name, rec };
      }
    }
    if (target) {
      setBelief(p, "hasTarget", [], true);
      setBelief(p, "targetVisible", [], target.rec.visible);
      setBeliefVec(p, "targetPos", [], target.rec.x, target.rec.z);
      setBelief(p, "targetHp", [], target.rec.hp);
      a.huntTarget = { x: target.rec.x, z: target.rec.z };
    } else {
      setBelief(p, "hasTarget", [], false);
      setBelief(p, "targetVisible", [], false);
      a.huntTarget = null;
    }

    // attack desirability — Dive's AttackEvaluator: weaponStrength × health fraction
    setBelief(p, "attackDesire", [], target ? this.world.weaponStrength(a) * (a.hp / MAX_HEALTH) : 0);

    // items: desirability + "wanted" gate (GetHealth / GetWeapon evaluators)
    const diag = Math.hypot(this.world.halfWidth * 2, this.world.halfDepth * 2);
    for (const it of this.world.items) {
      setBelief(p, "itemActive", [it.name], it.active);
      const nearness = 1 - Math.min(1, dist2(a.x, a.z, it.x, it.z) / diag);
      let wanted = false;
      let desire = 0;
      if (it.kind === "health") {
        const deficit = 1 - a.hp / MAX_HEALTH;
        wanted = it.active && a.hp < MAX_HEALTH * WANT_HEALTH_BELOW;
        desire = deficit * nearness * 1.2;
      } else if (it.weapon) {
        const haveFrac = this.world.ammoFraction(a, it.weapon);
        wanted = it.active && haveFrac < 0.999;
        desire = (1 - haveFrac) * nearness * 0.8;
      }
      setBelief(p, "itemWanted", [it.name], wanted);
      setBelief(p, "itemDesire", [it.name], desire);
    }

    // explore waypoint: keep the current one until reached, then pick a fresh random one
    if (p.exploreIdx === null || dist2(a.x, a.z, this.spots[p.exploreIdx].x, this.spots[p.exploreIdx].z) <= PICKUP_RADIUS * 2) {
      p.exploreIdx = Math.floor(this.exploreRng() * this.spots.length) % this.spots.length;
    }
    setBelief(p, "exploreSpot", [], `spot${p.exploreIdx}`);
  }

  /** drive a human-controlled bot from its input intent (no planner). */
  private driveHuman(a: Combatant): void {
    const inp = a.input;
    const len = Math.hypot(inp.moveX, inp.moveZ);
    if (len > 0.001) {
      const nx = a.x + (inp.moveX / len) * MOVE_SPEED * this.dt;
      const nz = a.z + (inp.moveZ / len) * MOVE_SPEED * this.dt;
      const c = this.world.clampToArena(nx, nz);
      a.x = c.x;
      a.z = c.z;
      a.heading = Math.atan2(inp.moveX, inp.moveZ);
    }
    this.selectWeapon(a);
    if (inp.shoot) {
      const target = this.world.nearestEnemy(a.name, true);
      if (target) {
        // gate fire rate via a lightweight per-actor clock stored on heading-free state
        const w = WEAPONS[a.weapon];
        const last = (a as unknown as { _lastShot?: number })._lastShot ?? -Infinity;
        if (this.world.clock - last >= w.fireTime) {
          (a as unknown as { _lastShot?: number })._lastShot = this.world.clock;
          a.heading = Math.atan2(target.x - a.x, target.z - a.z);
          this.world.fire(a, target, this.playerRng);
        }
      }
    }
  }
  private playerRng = mulberry32(0xc0ffee);

  /** advance the world one fixed step and return a snapshot. */
  step(): DiveFrame {
    this.world.clock += this.dt;
    this.world.shots = [];

    // respawns
    for (const a of this.world.actors.values()) {
      if (!a.alive && this.world.clock >= a.respawnAt) this.world.respawn(a);
    }

    // AI bots: perceive + plan; human bots: apply input
    for (const a of this.world.actors.values()) {
      if (!a.alive) continue;
      if (a.control === "human") {
        this.driveHuman(a);
      } else {
        const p = this.bots.get(a.name);
        if (!p) continue;
        this.perceive(p);
        p.planner.tick({ nodes: this.nodes });
      }
    }

    // item pickups (proximity) + respawns
    for (const it of this.world.items) {
      if (!it.active) {
        if (this.world.clock >= it.respawnAt) it.active = true;
        continue;
      }
      for (const a of this.world.actors.values()) {
        if (a.alive && dist2(a.x, a.z, it.x, it.z) <= PICKUP_RADIUS) {
          this.grant(a, it);
          it.active = false;
          it.respawnAt = this.world.clock + ITEM_RESPAWN;
          break;
        }
      }
    }

    return this.snapshot();
  }

  private grant(a: Combatant, it: ItemState): void {
    if (it.kind === "health") {
      a.hp = Math.min(MAX_HEALTH, a.hp + HEALTH_PACK_AMOUNT);
    } else if (it.weapon) {
      a.ammo.set(it.weapon, WEAPONS[it.weapon].maxAmmo);
    }
  }

  snapshot(): DiveFrame {
    const bots: BotFrame[] = [];
    for (const a of this.world.actors.values()) {
      const p = this.bots.get(a.name);
      const step = p?.planner.currentStep();
      const stepLabel = step && step.k === "op" ? p!.model.describeGroundOp(step.g) : step ? step.k : "—";
      const plan = p?.planner.getPlan();
      const status = p?.planner.getStatus() ?? "—";
      const sees = a.alive ? this.world.nearestEnemy(a.name, true)?.name ?? null : null;
      bots.push({
        name: a.name,
        color: a.color,
        x: round(a.x),
        z: round(a.z),
        heading: round(a.heading),
        hp: round(a.hp),
        alive: a.alive,
        weapon: a.weapon,
        ammo: isFinite(a.ammo.get(a.weapon) ?? Infinity) ? (a.ammo.get(a.weapon) as number) : -1,
        frags: a.frags,
        deaths: a.deaths,
        control: a.control,
        step: stepLabel,
        action: a.control === "human" ? "you" : describeAction(stepLabel, status, a.alive, sees),
        sees,
        goalText: a.control === "human" ? "human player" : goalFor(stepLabel),
        plan: p && plan ? planSummary(p.model, plan) : [],
        events: p ? p.trace.slice(-6).map((e) => e.t) : [],
        replanning: p ? p.trace.slice(-3).some((e) => e.t === "replan.dirty" || e.t === "repair.attempt") || status === "planning" : false,
      });
    }
    return {
      clock: round(this.world.clock),
      halfWidth: this.world.halfWidth,
      halfDepth: this.world.halfDepth,
      bots,
      items: this.world.items.map((it) => ({ name: it.name, x: it.x, z: it.z, kind: it.kind, weapon: it.weapon, active: it.active })),
      obstacles: this.world.obstacles,
      spots: this.spots,
      shots: this.world.shots,
      scoreboard: [...this.world.actors.values()]
        .map((a) => ({ name: a.name, color: a.color, frags: a.frags, deaths: a.deaths }))
        .sort((x, y) => y.frags - x.frags),
    };
  }

  /** run the match to the frag limit or a step cap (offline rollout for tests). */
  run(maxSteps = 2000): DiveFrame[] {
    const frames: DiveFrame[] = [this.snapshot()];
    for (let i = 0; i < maxSteps; i++) {
      frames.push(this.step());
      if (this.matchOver()) break;
    }
    return frames;
  }

  matchOver(): boolean {
    return [...this.world.actors.values()].some((a) => a.frags >= this.fragLimit);
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** small deterministic PRNG (mulberry32) for explore-waypoint / player-fire rolls. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- tactical waypoints

/** Generate a coarse grid of walkable explore waypoints over the arena (skipping
 *  cells inside obstacles) — the discrete positions the explore goal roams between. */
export function generateSpots(inst: DiveInstance): Vec2[] {
  const step = 6;
  const pts: Vec2[] = [];
  const insideObstacle = (x: number, z: number) => inst.obstacles.some((o) => x > o.x - 0.6 && x < o.x + o.w + 0.6 && z > o.z - 0.6 && z < o.z + o.d + 0.6);
  for (let x = -inst.halfWidth + 2; x <= inst.halfWidth - 2; x += step) {
    for (let z = -inst.halfDepth + 2; z <= inst.halfDepth - 2; z += step) {
      if (!insideObstacle(x, z)) pts.push({ x: round(x), z: round(z) });
    }
  }
  return pts;
}

// ---------------------------------------------------------------- view labels

function describeAction(step: string, status: string, alive: boolean, sees: string | null): string {
  if (!alive) return "respawning";
  if (step.startsWith("fight")) return sees ? `firing on ${sees}` : "firing";
  if (step.startsWith("huntTo")) return "hunting last-seen";
  if (step.startsWith("pickup")) return "fetching item";
  if (step.startsWith("roamTo")) return "exploring";
  if (step === "hold" || step === "wait") return "holding";
  if (status === "planning") return "thinking…";
  return "exploring";
}

function goalFor(step: string): string {
  if (step.startsWith("fight") || step.startsWith("huntTo")) return "Attack — neutralize the target";
  if (step.startsWith("pickup")) return "Get item — health / weapon";
  if (step.startsWith("roamTo")) return "Explore — roam the arena";
  return "Compete";
}

// ---------------------------------------------------------------- instances

/** The default arena: a square map with a central block, four corner cover boxes,
 *  health in the middle, and the two special weapons on opposite flanks. 4 bots. */
export function arenaInstance(): DiveInstance {
  const colors = ["#ef4444", "#3b82f6", "#22c55e", "#eab308"];
  return {
    halfWidth: 18,
    halfDepth: 18,
    bots: [
      { name: "Vela", x: -14, z: -14, color: colors[0] },
      { name: "Orion", x: 14, z: 14, color: colors[1] },
      { name: "Lyra", x: -14, z: 14, color: colors[2] },
      { name: "Mira", x: 14, z: -14, color: colors[3] },
    ],
    items: [
      { name: "health-c", x: 0, z: 0, kind: "health" },
      { name: "health-n", x: 0, z: -13, kind: "health" },
      { name: "health-s", x: 0, z: 13, kind: "health" },
      { name: "shotgun-w", x: -13, z: 0, kind: "weapon", weapon: "shotgun" },
      { name: "rifle-e", x: 13, z: 0, kind: "weapon", weapon: "rifle" },
    ],
    obstacles: [
      { x: -3, z: -3, w: 6, d: 6 }, // central block
      { x: -15, z: -1, w: 4, d: 2 }, // west nook
      { x: 11, z: -1, w: 4, d: 2 }, // east nook
      { x: -1, z: -15, w: 2, d: 4 }, // north nook
      { x: -1, z: 11, w: 2, d: 4 }, // south nook
    ],
    spawns: [
      { x: -15, z: -15 },
      { x: 15, z: 15 },
      { x: -15, z: 15 },
      { x: 15, z: -15 },
      { x: 0, z: -15 },
      { x: 0, z: 15 },
    ],
  };
}

/** exposed for focused unit tests that build a single planner directly. */
export function diveModel(inst: DiveInstance, self: string): Model {
  const world = new DiveWorld(inst);
  return buildBotModel(self, world, inst.items, generateSpots(inst));
}
