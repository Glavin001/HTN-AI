/**
 * Staircase World — a spatial block-stacking scenario where geometry drives the
 * plan. An agent on a grid of columns must raise column heights (placing blocks
 * from a supply) so it can climb — one level at a time — onto an elevated goal.
 *
 * This is the scenario the web preview renders in 3D, and the first test where
 * htn-ai's spatial features actually drive search:
 *   - `height(cell):int` is read by BOTH the climb precondition
 *     (height(to) ≤ height(from)+1) and the place precondition
 *     (height(stand) ≥ height(at)) — so the build order is *discovered*, not
 *     scripted: you must build a support before you can stand high enough to
 *     build/climb higher (the ordering constraint the vibe-city demo hard-coded).
 *   - movement cost is `dist(pos(from), pos(to))` over `vec2` positions — the
 *     first use of N.dist as a planning-relevant cost.
 *   - `supply(cell):int` is a consumable resource the planner must account for.
 *
 * Shared by tests/spatial.ts and the web preview.
 */
import {
  type DomainDoc,
  type Model,
  E,
  F,
  N,
  createModel,
} from "../src/index";

export const staircaseDomain: DomainDoc = {
  name: "staircase-world",
  types: [{ name: "cell" }],
  fluents: [
    { name: "height", params: [{ name: "c", type: "cell" }], kind: "int", initial: 0 },
    { name: "pos", params: [{ name: "c", type: "cell" }], kind: "vec2" },
    { name: "supply", params: [{ name: "c", type: "cell" }], kind: "int", initial: 0 },
    { name: "adj", params: [{ name: "a", type: "cell" }, { name: "b", type: "cell" }], kind: "boolean", initial: false },
    { name: "agentAt", kind: "entity", entityType: "cell" },
    // the agent's elevation = the height of the column it stands on. This is the
    // ONLY observable the goal constrains: "be up in the air at coordinate Y".
    { name: "agentY", kind: "int", initial: 0 },
    { name: "holding", kind: "boolean", initial: false },
  ],
  operators: [
    {
      // walk to an adjacent cell; can ascend at most one level (descend freely)
      name: "goto",
      params: [{ name: "from", type: "cell" }, { name: "to", type: "cell" }],
      pre: F.and(
        F.lit("agentAt", [], "?from"),
        F.lit("adj", ["?from", "?to"]),
        F.lte(N.fl("height", "?to"), N.add(N.fl("height", "?from"), N.c(1))),
      ),
      // moving onto a column sets the agent's elevation to that column's height
      eff: [E.set("agentAt", [], "?to"), E.set("agentY", [], N.fl("height", "?to"))],
      cost: N.add(N.dist("pos", ["?from"], "pos", ["?to"]), N.c(0.01)),
    },
    {
      // pick a block off the column the agent stands on (a supply cell)
      name: "pick",
      params: [{ name: "at", type: "cell" }],
      pre: F.and(F.not(F.lit("holding")), F.lit("agentAt", [], "?at"), F.gt(N.fl("supply", "?at"), N.c(0))),
      eff: [E.set("holding", [], true), E.dec("supply", ["?at"], N.c(1))],
      cost: 1,
    },
    {
      // place the carried block on an adjacent column at or below the agent's level
      name: "place",
      params: [{ name: "stand", type: "cell" }, { name: "at", type: "cell" }],
      pre: F.and(
        F.lit("holding"),
        F.lit("agentAt", [], "?stand"),
        F.lit("adj", ["?stand", "?at"]),
        F.gte(N.fl("height", "?stand"), N.fl("height", "?at")),
      ),
      eff: [E.set("holding", [], false), E.inc("height", ["?at"], N.c(1))],
      cost: 1,
    },
  ],
};

export interface CellSpec {
  name: string;
  x: number;
  z: number;
  height?: number;
  supply?: number;
}

export interface StaircaseInstance {
  cells: CellSpec[];
  /** undirected edges; adjacency is written both ways */
  edges: [string, string][];
  start: string;
}

/** Build a model for a Staircase World instance. */
export function staircaseModel(inst: StaircaseInstance): Model {
  const entities: Record<string, string> = {};
  for (const c of inst.cells) entities[c.name] = "cell";
  return createModel(staircaseDomain, {
    entities,
    init: (w) => {
      for (const c of inst.cells) {
        w.set("pos", [c.name], [c.x, c.z]);
        if (c.height) w.set("height", [c.name], c.height);
        if (c.supply) w.set("supply", [c.name], c.supply);
      }
      for (const [a, b] of inst.edges) {
        w.set("adj", [a, b], true);
        w.set("adj", [b, a], true);
      }
      w.set("agentAt", [], inst.start);
    },
  });
}

/**
 * Minimal "climb the ledge": a fixed height-2 wall the agent must get on top of.
 * It can't climb 2 levels directly, so it must build `mid` up to height 1 first,
 * then ascend ground→mid→ledge. Solvable by pure GOAP search.
 */
export function ledgeInstance(supply = 1): StaircaseInstance {
  return {
    cells: [
      { name: "ground", x: 0, z: 0, supply },
      { name: "mid", x: 1, z: 0 },
      { name: "ledge", x: 2, z: 0, height: 2 },
    ],
    edges: [
      ["ground", "mid"],
      ["mid", "ledge"],
    ],
    start: "ground",
  };
}

/**
 * The staircase the agent builds from a supply depot, then climbs onto. The
 * goal is to stand on top of `goal` once it's been raised to GOAL_HEIGHT — which
 * is impossible to reach across flat ground (you can only climb one level at a
 * time), so the agent must build the `s1` support up to 1 and `goal` up to 2,
 * carrying each block from the depot. Used for the "runs through the reactive
 * Planner" test and as the web preview's flagship scene.
 */
export const GOAL_HEIGHT = 2;

export function staircaseInstance(): StaircaseInstance {
  return {
    cells: [
      { name: "depot", x: 0, z: 0, supply: 8 },
      { name: "s1", x: 1, z: 0 },
      { name: "goal", x: 2, z: 0 },
    ],
    edges: [
      ["depot", "s1"],
      ["s1", "goal"],
    ],
    start: "depot",
  };
}

/**
 * The goal is a 3D POSITION, nothing more: be at the `goal` cell's (x,z) and at
 * elevation GOAL_HEIGHT — i.e. "up in the air at this coordinate". It does NOT
 * say to place blocks or to build any particular column; the planner must
 * *discover* that the only way to be that high is to stack a staircase up to it.
 */
export const GOAL_X = 2;
export const GOAL_Z = 0;

export function staircaseGoal(): import("../src/index").Formula {
  return F.and(F.lit("agentAt", [], "goal"), F.eq(N.fl("agentY"), N.c(GOAL_HEIGHT)));
}

/** The ledge goal: be at the ledge coordinate, elevation 2 (atop the wall). */
export function ledgeGoal(): import("../src/index").Formula {
  return F.and(F.lit("agentAt", [], "ledge"), F.eq(N.fl("agentY"), N.c(2)));
}
