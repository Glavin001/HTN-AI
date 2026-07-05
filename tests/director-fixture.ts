/**
 * The "discrete executive" acceptance fixture: a ~6-operator tactical demo
 * domain — GoTo / Breach / TakeCover / Suppress / Regroup / Idle — wired the
 * way a flagship game layer would wire it:
 *
 *  - preconditions are FUNCTION-BASED live queries (`F.ext`) against mutable
 *    host objects (a nav-mesh stub and a cover-system stub), not baked fluents;
 *  - movement COSTS call a traversal oracle (`N.ext`, the "kinocat" seam);
 *  - subsystems announce changes by bumping a version fluent declared in the
 *    externals' reads, which is what makes reactive replanning fluent-precise.
 *
 * This file is a test fixture (shared by tests/director.ts and bench/) — the
 * real demo domain ships in the flagship repo, per the integration spec.
 *
 * Map (undirected edges; the doorstep–room edge is the breachable door):
 *
 *     start ──1── doorstep ══door══ room ──1── cover1 ★cover
 *       │ ╲                                      │
 *       │  ╲──6────────── rally ────────6────────┘
 *       └────10────────── flank ───────10── cover1
 */

import { DomainDoc, ExtQuery, Model, achieve, createModel, doTask, F, N, E, scoped } from "../src/index";

// ---------------------------------------------------------------- live host stubs

export interface DirectorWorld {
  /** layer-2 nav stub: undirected edges, mutable at runtime (a live query target) */
  nav: { edges: Set<string>; blocked: Set<string> };
  /** kinocat stub: traversal seconds per edge, re-weightable at runtime */
  oracle: Map<string, number>;
  /** layer-5 cover-system stub: spots that currently offer cover */
  cover: Set<string>;
}

export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

const DOOR_EDGE = edgeKey("doorstep", "room");

export function directorWorld(): DirectorWorld {
  const edges = [
    ["start", "doorstep", 1],
    ["doorstep", "room", 1],
    ["room", "cover1", 1],
    ["start", "rally", 6],
    ["rally", "cover1", 6],
    ["start", "flank", 10],
    ["flank", "cover1", 10],
  ] as const;
  return {
    nav: { edges: new Set(edges.map(([a, b]) => edgeKey(a, b))), blocked: new Set() },
    oracle: new Map(edges.map(([a, b, t]) => [edgeKey(a, b), t])),
    cover: new Set(["cover1"]),
  };
}

// ---------------------------------------------------------------- domain

const NAV_READS = ["at", "sealed", "navVersion"];

export function directorDomain(): DomainDoc {
  return {
    name: "director-demo",
    types: [{ name: "node" }, { name: "rallyNode", parent: "node" }],
    fluents: [
      { name: "at", kind: "entity", entityType: "node" },
      { name: "sealed", kind: "boolean" },
      { name: "inCover", kind: "boolean" },
      { name: "threatKnown", kind: "boolean" },
      { name: "threatDown", kind: "boolean" },
      { name: "regrouped", kind: "boolean" },
      /** bumped by the host when the nav/traversal oracle changes (layer 2) */
      { name: "navVersion", kind: "int" },
      /** bumped by the host when the cover system changes (layer 5) */
      { name: "coverVersion", kind: "int" },
    ],
    operators: [
      {
        name: "GoTo",
        params: [{ name: "to", type: "node" }],
        pre: F.ext("navEdge", ["?to"], NAV_READS),
        eff: [E.set("at", [], "?to"), E.set("inCover", [], false)],
        cost: N.ext("travelTime", ["?to"], ["at", "navVersion"]),
      },
      {
        name: "Breach",
        pre: F.and(F.lit("at", [], "doorstep"), F.lit("sealed")),
        eff: [E.set("sealed", [], false)],
        cost: 2,
      },
      {
        // move into an adjacent spot that the cover system says is available
        name: "TakeCover",
        params: [{ name: "spot", type: "node" }],
        pre: F.and(F.ext("navEdge", ["?spot"], NAV_READS), F.ext("coverFree", ["?spot"], ["coverVersion"])),
        eff: [E.set("at", [], "?spot"), E.set("inCover", [], true)],
        cost: N.ext("travelTime", ["?spot"], ["at", "navVersion"]),
      },
      {
        name: "Suppress",
        pre: F.and(F.lit("inCover"), F.lit("threatKnown")),
        verify: F.lit("threatKnown"),
        eff: [E.set("threatDown", [], true)],
        cost: 1,
        duration: 1,
        executor: "suppressFire",
      },
      {
        name: "Regroup",
        params: [{ name: "r", type: "rallyNode" }],
        pre: F.and(F.lit("threatDown"), F.ext("navEdge", ["?r"], NAV_READS)),
        eff: [E.set("at", [], "?r"), E.set("regrouped", [], true), E.set("inCover", [], false)],
        cost: N.ext("travelTime", ["?r"], ["at", "navVersion"]),
      },
      {
        name: "Idle",
        cost: 0.1,
      },
    ],
    compounds: [{ name: "Directive" }, { name: "TimedClear" }],
    methods: [
      {
        name: "assault",
        task: "Directive",
        pre: F.lit("threatKnown"),
        subtasks: [achieve(F.lit("regrouped"))],
      },
      {
        name: "hold",
        task: "Directive",
        pre: F.not(F.lit("threatKnown")),
        subtasks: [doTask("GoTo", "rally"), doTask("Idle")],
      },
      {
        name: "clearWindow",
        task: "TimedClear",
        subtasks: [scoped({ deadline: 2, label: "clear-window" }, achieve(F.lit("threatDown")))],
      },
    ],
  };
}

// ---------------------------------------------------------------- model

export interface DirectorInit {
  at?: string;
  sealed?: boolean;
  inCover?: boolean;
  threatKnown?: boolean;
}

export function directorModel(world: DirectorWorld, init: DirectorInit = {}): Model {
  const nodeAt = (q: ExtQuery): string | null => {
    const raw = q.get("at");
    return raw === 0 ? null : q.name(raw - 1); // entity slots store gid+1 (0 = null)
  };
  return createModel(
    directorDomain(),
    {
      entities: { start: "node", doorstep: "node", room: "node", cover1: "node", flank: "node", rally: "rallyNode" },
      init: (w) => {
        w.set("at", [], init.at ?? "start");
        w.set("sealed", [], init.sealed ?? true);
        w.set("inCover", [], init.inCover ?? false);
        w.set("threatKnown", [], init.threatKnown ?? true);
      },
    },
    {
      predicates: {
        // live layer-2 query: is there a traversable edge from where I (will) stand to ?to
        navEdge: (q) => {
          const from = nodeAt(q);
          if (from === null) return false;
          const key = edgeKey(from, q.name(q.args[0]));
          if (!world.nav.edges.has(key) || world.nav.blocked.has(key)) return false;
          return key !== DOOR_EDGE || q.get("sealed") === 0;
        },
        // live layer-5 query: does the cover system have this spot available
        coverFree: (q) => world.cover.has(q.name(q.args[0])),
      },
      numerics: {
        // kinocat oracle: traversal seconds for the edge being considered
        travelTime: (q) => {
          const from = nodeAt(q);
          if (from === null) return 999;
          return world.oracle.get(edgeKey(from, q.name(q.args[0]))) ?? 999;
        },
      },
      executors: {
        // suppression takes ~1s of real time; the executing condition (verify)
        // re-checks threatKnown every tick while it runs
        suppressFire: (api) => (api.elapsedInStep() >= 1 ? "success" : "continue"),
      },
    },
  );
}
