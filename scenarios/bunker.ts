/**
 * Bunker Heist — a "collect the star" mission solved purely by GOAP-style goal
 * search. It is the honest re-implementation of the classic Mahler / Fluid-HTN
 * "Acquire key → Acquire C4 → Breach → Get star" bunker demo: same world, same
 * gates (a locked storage door, a sealed bunker), same payoff. The difference is
 * that NOTHING here encodes the solution.
 *
 * The goal is purely DECLARATIVE — a single final-state condition: `hasStar`.
 * The domain has only primitive operators (goto / pickup_key / unlock_storage /
 * pickup_c4 / place_c4 / detonate / pickup_star). There is no "AcquireKey" task,
 * no "BreachBunker" method, no `needsKey`/`needsC4` helper that pre-computes the
 * ordering — the things the original Fluid-HTN port leaned on to fake a plan.
 *
 * Everything is discovered by search over the operators:
 *   • Movement is edge-by-edge over the compound's walk graph (goto from→to), so
 *     the planner finds the spatial route too — not a "teleport if a path exists"
 *     shortcut.
 *   • The two gates are ordinary PRECONDITIONS, not scripted steps: you may only
 *     enter the storage interior while `storageUnlocked`, and the bunker interior
 *     while `bunkerBreached`. To satisfy `hasStar` the planner must therefore work
 *     backwards on its own — the star is inside the sealed bunker, so it needs a
 *     breach, which needs C4 placed + a detonation from a safe distance, which
 *     needs C4, which is behind the locked storage door, which needs the key. None
 *     of that chain is written down anywhere; it falls out of the preconditions.
 *
 * Shared by tests/bunker.ts (ground-truth assertions) and the web preview
 * (examples/web/app/bunker).
 */
import {
  type DomainDoc,
  type Formula,
  type Model,
  E,
  F,
  N,
  createModel,
} from "../src/index";

export type Vec3 = [number, number, number];

/** The nine waypoints of the compound (the walk-graph nodes). */
export const N_ = Object.freeze({
  COURTYARD: "courtyard",
  TABLE: "table_area", // the key sits here, in the open
  STORAGE_DOOR: "storage_door", // locked until unlocked with the key
  STORAGE_INT: "storage_interior",
  C4_TABLE: "c4_table", // the C4 sits here, inside storage
  BUNKER_DOOR: "bunker_door", // where C4 is planted
  BUNKER_INT: "bunker_interior", // sealed until breached
  STAR: "star_pos", // the star sits here, inside the bunker
  SAFE: "safe_spot", // blast-safe distance for the detonation
} as const);

export type BunkerNode = (typeof N_)[keyof typeof N_];

export const BUNKER_NODES: BunkerNode[] = Object.values(N_);

/** A building footprint, used only by the 3D view to draw walls/roof/door. */
export interface BuildingConfig {
  center: Vec3;
  size: Vec3;
  doorFace: "north" | "south" | "east" | "west";
  color: string;
}

export const BUILDINGS: Record<"STORAGE" | "BUNKER", BuildingConfig> = {
  STORAGE: { center: [-10, 0, 6], size: [5, 3.2, 4], doorFace: "north", color: "#3f6212" },
  BUNKER: { center: [12, 0, 0], size: [7, 5, 7], doorFace: "west", color: "#374151" },
};

/** World positions of every waypoint (x right, y up, z depth). */
export const NODE_POS: Record<BunkerNode, Vec3> = {
  [N_.COURTYARD]: [0, 0, 0],
  [N_.TABLE]: [-10, 0, -5],
  [N_.STORAGE_DOOR]: [-10, 0, 3.4],
  [N_.STORAGE_INT]: [-10, 0, 6],
  [N_.C4_TABLE]: [-11.4, 0, 7],
  [N_.BUNKER_DOOR]: [8.2, 0, 0],
  [N_.BUNKER_INT]: [12, 0, 0],
  [N_.STAR]: [13.8, 0, 0],
  [N_.SAFE]: [2.5, 0, 6.5],
};

/**
 * The walk graph — undirected edges between adjacent waypoints. The gating lives
 * on the *nodes* (see `needsUnlock` / `needsBreach` below), not the edges, so this
 * is just the raw connectivity of the compound.
 */
export const BUNKER_EDGES: [BunkerNode, BunkerNode][] = [
  [N_.COURTYARD, N_.TABLE],
  [N_.COURTYARD, N_.STORAGE_DOOR],
  [N_.COURTYARD, N_.BUNKER_DOOR],
  [N_.COURTYARD, N_.SAFE],
  [N_.TABLE, N_.STORAGE_DOOR],
  [N_.STORAGE_DOOR, N_.STORAGE_INT], // gated: storage_interior needs unlock
  [N_.STORAGE_INT, N_.C4_TABLE],
  [N_.STORAGE_DOOR, N_.BUNKER_DOOR],
  [N_.BUNKER_DOOR, N_.SAFE],
  [N_.BUNKER_DOOR, N_.BUNKER_INT], // gated: bunker_interior needs breach
  [N_.BUNKER_INT, N_.STAR],
];

/**
 * The generic mission domain. Note what's absent: there is no compound task and
 * no method. Just primitive operators over a typed world — the planner alone
 * chains them. Movement is one edge at a time; the gates are preconditions.
 */
export const bunkerDomain: DomainDoc = {
  name: "bunker-heist",
  types: [{ name: "node" }],
  fluents: [
    { name: "agentAt", kind: "entity", entityType: "node" },
    // static graph + geometry (set per instance)
    { name: "adj", params: [{ name: "a", type: "node" }, { name: "b", type: "node" }], kind: "boolean", initial: false, static: true },
    { name: "pos", params: [{ name: "c", type: "node" }], kind: "vec3", static: true },
    // a node you can only ENTER once the matching gate is open (static markers)
    { name: "needsUnlock", params: [{ name: "c", type: "node" }], kind: "boolean", initial: false, static: true },
    { name: "needsBreach", params: [{ name: "c", type: "node" }], kind: "boolean", initial: false, static: true },
    // world facts
    { name: "keyOnTable", kind: "boolean", initial: true },
    { name: "c4Available", kind: "boolean", initial: true },
    { name: "starPresent", kind: "boolean", initial: true },
    // inventory
    { name: "hasKey", kind: "boolean", initial: false },
    { name: "hasC4", kind: "boolean", initial: false },
    { name: "hasStar", kind: "boolean", initial: false },
    // environment
    { name: "storageUnlocked", kind: "boolean", initial: false },
    { name: "c4Placed", kind: "boolean", initial: false },
    { name: "bunkerBreached", kind: "boolean", initial: false },
  ],
  operators: [
    {
      // walk one edge of the graph; may only enter a gated node once its gate is open
      name: "goto",
      params: [{ name: "from", type: "node" }, { name: "to", type: "node" }],
      pre: F.and(
        F.lit("agentAt", [], "?from"),
        F.lit("adj", ["?from", "?to"]),
        // entering a `needsUnlock` node requires storageUnlocked; ungated nodes pass freely
        F.or(F.not(F.lit("needsUnlock", ["?to"])), F.lit("storageUnlocked")),
        // entering a `needsBreach` node requires bunkerBreached
        F.or(F.not(F.lit("needsBreach", ["?to"])), F.lit("bunkerBreached")),
      ),
      eff: [E.set("agentAt", [], "?to")],
      // distance cost makes the route realistic; the +0.01 keeps every step strictly positive
      cost: N.add(N.dist("pos", ["?from"], "pos", ["?to"]), N.c(0.01)),
    },
    {
      name: "pickup_key",
      pre: F.and(F.lit("agentAt", [], N_.TABLE), F.lit("keyOnTable")),
      eff: [E.set("hasKey", [], true), E.set("keyOnTable", [], false)],
      cost: 1,
    },
    {
      name: "unlock_storage",
      pre: F.and(F.lit("agentAt", [], N_.STORAGE_DOOR), F.lit("hasKey"), F.not(F.lit("storageUnlocked"))),
      eff: [E.set("storageUnlocked", [], true)],
      cost: 1,
    },
    {
      name: "pickup_c4",
      pre: F.and(F.lit("agentAt", [], N_.C4_TABLE), F.lit("c4Available")),
      eff: [E.set("hasC4", [], true), E.set("c4Available", [], false)],
      cost: 1,
    },
    {
      name: "place_c4",
      pre: F.and(F.lit("agentAt", [], N_.BUNKER_DOOR), F.lit("hasC4"), F.not(F.lit("c4Placed"))),
      eff: [E.set("c4Placed", [], true), E.set("hasC4", [], false)],
      cost: 1,
    },
    {
      name: "detonate",
      // must be a safe distance away — you can't stand on the door and blow it
      pre: F.and(F.lit("agentAt", [], N_.SAFE), F.lit("c4Placed"), F.not(F.lit("bunkerBreached"))),
      eff: [E.set("bunkerBreached", [], true), E.set("c4Placed", [], false)],
      cost: 1,
    },
    {
      name: "pickup_star",
      pre: F.and(F.lit("agentAt", [], N_.STAR), F.lit("starPresent")),
      eff: [E.set("hasStar", [], true), E.set("starPresent", [], false)],
      cost: 1,
    },
  ],
};

/** Overrides for the initial world (used to seed scenario variants). */
export interface BunkerSetup {
  start?: BunkerNode;
  hasKey?: boolean;
  hasC4?: boolean;
  c4Placed?: boolean;
  storageUnlocked?: boolean;
  bunkerBreached?: boolean;
  /** set false to remove the key entirely — makes the storage (and the star) unreachable */
  keyOnTable?: boolean;
}

/** Build a model of the compound over the generic domain. */
export function bunkerModel(setup: BunkerSetup = {}): Model {
  const entities: Record<string, string> = {};
  for (const node of BUNKER_NODES) entities[node] = "node";
  return createModel(bunkerDomain, {
    entities,
    init: (w) => {
      for (const node of BUNKER_NODES) w.set("pos", [node], NODE_POS[node]);
      for (const [a, b] of BUNKER_EDGES) {
        w.set("adj", [a, b], true);
        w.set("adj", [b, a], true);
      }
      // mark the two gated interiors
      w.set("needsUnlock", [N_.STORAGE_INT], true);
      w.set("needsBreach", [N_.BUNKER_INT], true);

      w.set("agentAt", [], setup.start ?? N_.COURTYARD);
      if (setup.keyOnTable === false) w.set("keyOnTable", [], false);
      if (setup.hasKey) w.set("hasKey", [], true);
      if (setup.hasC4) w.set("hasC4", [], true);
      if (setup.c4Placed) w.set("c4Placed", [], true);
      if (setup.storageUnlocked) w.set("storageUnlocked", [], true);
      if (setup.bunkerBreached) w.set("bunkerBreached", [], true);
    },
  });
}

/** The mission goal: hold the star. Everything else is discovered. */
export function starGoal(): Formula {
  return F.lit("hasStar");
}

/** A simpler sub-mission: just get inside the storage (forces key→unlock→enter). */
export function c4Goal(): Formula {
  return F.lit("hasC4");
}

/** Breach the bunker (forces the full key→C4→place→detonate chain, sans star). */
export function breachGoal(): Formula {
  return F.lit("bunkerBreached");
}
