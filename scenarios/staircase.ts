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

/** default height of a wall/obstacle pillar — far above the +1 climb limit */
export const WALL_HEIGHT = 6;

export const staircaseDomain: DomainDoc = {
  name: "staircase-world",
  types: [{ name: "cell" }],
  fluents: [
    { name: "height", params: [{ name: "c", type: "cell" }], kind: "int", initial: 0 },
    { name: "pos", params: [{ name: "c", type: "cell" }], kind: "vec2" },
    { name: "supply", params: [{ name: "c", type: "cell" }], kind: "int", initial: 0 },
    { name: "adj", params: [{ name: "a", type: "cell" }, { name: "b", type: "cell" }], kind: "boolean", initial: false, static: true },
    { name: "agentAt", kind: "entity", entityType: "cell" },
    // the agent's elevation = the height of the column it stands on. This is the
    // ONLY observable the goal constrains: "be up in the air at coordinate Y".
    { name: "agentY", kind: "int", initial: 0 },
    { name: "holding", kind: "boolean", initial: false },
    // only designated cells can be built up — keeps the search focused on the
    // staircase (and lets walls/obstacles be no-build). Defaults to true so
    // simple instances need not set it.
    { name: "buildable", params: [{ name: "c", type: "cell" }], kind: "boolean", initial: true, static: true },
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
        F.lit("buildable", ["?at"]),
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
  /** if false, blocks cannot be placed here (walls, depots, the goal pillar) */
  buildable?: boolean;
  /** a tall fixed obstacle the agent can neither climb nor build on */
  wall?: boolean;
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
        const h = c.wall ? (c.height ?? WALL_HEIGHT) : c.height;
        if (h) w.set("height", [c.name], h);
        if (c.supply) w.set("supply", [c.name], c.supply);
        if (c.buildable === false || c.wall) w.set("buildable", [c.name], false);
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

/**
 * "Quarry" — the advanced grid world. A tall fixed goal pillar (height
 * QUARRY_GOAL_HEIGHT = 4) the agent must stand on top of, reachable only by
 * building a 3-step staircase (heights 1→2→3) beside it. The six blocks are
 * scattered across two depots with limited supply, so the agent must collect
 * from BOTH and shuttle them to the build front; a wall pillar is an impassable
 * obstacle. The goal is position-only — the planner works out the optimal route
 * to collect, place, build the staircase, and climb. Solved optimally by pure
 * GOAP search (≈1.5k node expansions, see tests/spatial.ts).
 *
 *      z=1   depotA(3)   wall       depotB(3)
 *      z=0   start - step1 - step2 - step3 - pillar(goal, h4)
 *             x=0     x=1     x=2     x=3      x=4
 */
export const QUARRY_GOAL_HEIGHT = 4;

export function quarryInstance(): StaircaseInstance {
  return {
    cells: [
      { name: "start", x: 0, z: 0 },
      { name: "step1", x: 1, z: 0 }, // built to 1
      { name: "step2", x: 2, z: 0 }, // built to 2
      { name: "step3", x: 3, z: 0 }, // built to 3
      { name: "pillar", x: 4, z: 0, height: QUARRY_GOAL_HEIGHT, buildable: false }, // the goal
      { name: "depotA", x: 0, z: 1, supply: 3, buildable: false },
      { name: "depotB", x: 2, z: 1, supply: 3, buildable: false },
      { name: "wall", x: 1, z: 1, wall: true },
    ],
    edges: [
      ["start", "step1"],
      ["step1", "step2"],
      ["step2", "step3"],
      ["step3", "pillar"],
      ["start", "depotA"],
      ["step2", "depotB"],
      // wall edges: present in the grid but impassable (height 6 ≫ climb limit)
      ["step1", "wall"],
      ["depotA", "wall"],
      ["depotB", "wall"],
    ],
    start: "start",
  };
}

/** Quarry goal: stand on top of the pillar — a pure 3D position, elevation 4. */
export function quarryGoal(): import("../src/index").Formula {
  return F.and(F.lit("agentAt", [], "pillar"), F.eq(N.fl("agentY"), N.c(QUARRY_GOAL_HEIGHT)));
}

// ============================================================================
// Scavenger — collect blocks scattered on the ground (no depots), top-first.
// ============================================================================

/**
 * The Scavenger domain. Same grid world, but blocks are not drawn from depots:
 * they lie around as column heights (a loose block = height 1, a 2-pillar =
 * height 2, …) and the agent collects them with `grab`. Two new rules vs the
 * staircase domain:
 *
 *   • Top-first: `grab` removes the TOP block of a column (height−−), so you
 *     can never pull a block out from under a stack.
 *   • Reach: you can only grab the top block of an adjacent column of height H
 *     if your standing elevation ≥ H − 1. So a 2-pillar's top block is out of
 *     reach from the ground — you must place a block in front, climb onto it,
 *     and THEN grab it. (Mirror of `place`, which needs stand ≥ height(at).)
 *
 * Placement is free: a held block may be placed on any reachable adjacent grid
 * cell, so the planner decides where to build steps and the goal staircase.
 */
export const scavengerDomain: DomainDoc = {
  name: "scavenger-world",
  types: [{ name: "cell" }],
  fluents: [
    { name: "height", params: [{ name: "c", type: "cell" }], kind: "int", initial: 0 },
    { name: "pos", params: [{ name: "c", type: "cell" }], kind: "vec2" },
    { name: "adj", params: [{ name: "a", type: "cell" }, { name: "b", type: "cell" }], kind: "boolean", initial: false, static: true },
    { name: "agentAt", kind: "entity", entityType: "cell" },
    { name: "agentY", kind: "int", initial: 0 },
    { name: "holding", kind: "boolean", initial: false },
  ],
  operators: [
    {
      name: "goto",
      params: [{ name: "from", type: "cell" }, { name: "to", type: "cell" }],
      pre: F.and(
        F.lit("agentAt", [], "?from"),
        F.lit("adj", ["?from", "?to"]),
        F.lte(N.fl("height", "?to"), N.add(N.fl("height", "?from"), N.c(1))),
      ),
      eff: [E.set("agentAt", [], "?to"), E.set("agentY", [], N.fl("height", "?to"))],
      cost: N.add(N.dist("pos", ["?from"], "pos", ["?to"]), N.c(0.01)),
    },
    {
      // grab the TOP block of an adjacent column; reachable iff stand ≥ height(at) − 1
      name: "grab",
      params: [{ name: "stand", type: "cell" }, { name: "at", type: "cell" }],
      pre: F.and(
        F.not(F.lit("holding")),
        F.lit("agentAt", [], "?stand"),
        F.lit("adj", ["?stand", "?at"]),
        F.gte(N.fl("height", "?at"), N.c(1)),
        F.gte(N.fl("height", "?stand"), N.sub(N.fl("height", "?at"), N.c(1))),
      ),
      eff: [E.set("holding", [], true), E.dec("height", ["?at"], N.c(1))],
      cost: 1,
    },
    {
      // place the held block on any reachable adjacent cell (free placement)
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

/** Build a model for a Scavenger instance (reuses the StaircaseInstance shape). */
export function scavengerModel(inst: StaircaseInstance): Model {
  const entities: Record<string, string> = {};
  for (const c of inst.cells) entities[c.name] = "cell";
  return createModel(scavengerDomain, {
    entities,
    init: (w) => {
      for (const c of inst.cells) {
        w.set("pos", [c.name], [c.x, c.z]);
        if (c.height) w.set("height", [c.name], c.height);
      }
      for (const [a, b] of inst.edges) {
        w.set("adj", [a, b], true);
        w.set("adj", [b, a], true);
      }
      w.set("agentAt", [], inst.start);
    },
  });
}

export const SCAVENGER_GOAL_HEIGHT = 2;

/**
 * A scavenger puzzle on a 3×2 grid. Two loose ground blocks and one 2-pillar are
 * scattered around; the goal is the 3D position atop `goal` at elevation 2. The
 * goal column needs 2 blocks plus a height-1 support to place the second and to
 * climb — 3 blocks total, but only 2 loose blocks exist, so the agent MUST
 * harvest the 2-pillar. Harvesting its top block is impossible from the ground,
 * so the planner discovers it has to build a step, climb it, then grab.
 *
 *      z=1  loose1(1) ---- goal ------- loose2(1)
 *      z=0  start ------- s ----------- tower(2)
 */
export function scavengerInstance(): StaircaseInstance {
  return {
    cells: [
      { name: "start", x: 0, z: 0 },
      { name: "s", x: 1, z: 0 },
      { name: "tower", x: 2, z: 0, height: 2 },
      { name: "loose1", x: 0, z: 1, height: 1 },
      { name: "goal", x: 1, z: 1 },
      { name: "loose2", x: 2, z: 1, height: 1 },
    ],
    edges: [
      ["start", "s"],
      ["s", "tower"],
      ["loose1", "goal"],
      ["goal", "loose2"],
      ["start", "loose1"],
      ["s", "goal"],
      ["tower", "loose2"],
    ],
    start: "start",
  };
}

/** Scavenger goal: stand on top of `goal` at elevation 2 — a pure 3D position. */
export function scavengerGoal(): import("../src/index").Formula {
  return F.and(F.lit("agentAt", [], "goal"), F.eq(N.fl("agentY"), N.c(SCAVENGER_GOAL_HEIGHT)));
}

export const SCAVENGER_BIG_GOAL_HEIGHT = 3;

/**
 * A bigger, harder scavenger puzzle: a 4×3 grid, a height-3 goal (a real 3-level
 * climb), and seven blocks scattered as five loose blocks + one 2-pillar. The
 * goal needs six blocks, so the pillar must be harvested, and the planner makes
 * richer decisions — it uses existing loose blocks as stepping stones to reach
 * the pillar's top and as platforms to stack the goal. Solved with a greedier
 * weight (hadd, weight≈5) in ~0.5s; see tests/spatial.ts and the web preview.
 *
 *      z=2  L4(1) - L5(1)
 *      z=1  L1(1) - tower(2) - L2(1) - L3(1)
 *      z=0  start -    A     -   B    -  goal
 */
export function scavengerBigInstance(): StaircaseInstance {
  return {
    cells: [
      { name: "start", x: 0, z: 0 },
      { name: "A", x: 1, z: 0 },
      { name: "B", x: 2, z: 0 },
      { name: "goal", x: 3, z: 0 },
      { name: "L1", x: 0, z: 1, height: 1 },
      { name: "tower", x: 1, z: 1, height: 2 },
      { name: "L2", x: 2, z: 1, height: 1 },
      { name: "L3", x: 3, z: 1, height: 1 },
      { name: "L4", x: 0, z: 2, height: 1 },
      { name: "L5", x: 1, z: 2, height: 1 },
    ],
    edges: [
      ["start", "A"],
      ["A", "B"],
      ["B", "goal"],
      ["start", "L1"],
      ["A", "tower"],
      ["B", "L2"],
      ["goal", "L3"],
      ["L1", "tower"],
      ["tower", "L2"],
      ["L2", "L3"],
      ["L1", "L4"],
      ["tower", "L5"],
      ["L4", "L5"],
    ],
    start: "start",
  };
}

/** Big scavenger goal: stand atop `goal` at elevation 3. */
export function scavengerBigGoal(): import("../src/index").Formula {
  return F.and(F.lit("agentAt", [], "goal"), F.eq(N.fl("agentY"), N.c(SCAVENGER_BIG_GOAL_HEIGHT)));
}

/**
 * A W×D grid scavenger world: a lane along z=0 with `start` at x=0 and the goal
 * cell `c{W-1}_0` at the far end; every cell on rows z≥1 carries a loose block
 * (and one 2-pillar). Used to scale the scavenger up into a HUGE stress example
 * — search cost grows ~cells² (the h_add heuristic is evaluated over every
 * ground op), so a 6×4 grid is roughly 10× the compute of Scavenger XL.
 */
export function scavengerGridInstance(w: number, d: number): StaircaseInstance {
  const nm = (x: number, z: number) => `c${x}_${z}`;
  const cells: CellSpec[] = [];
  const edges: [string, string][] = [];
  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) {
      const c: CellSpec = { name: nm(x, z), x, z };
      if (z >= 1) c.height = x === 1 && z === 1 ? 2 : 1; // scattered loose blocks + one 2-pillar
      cells.push(c);
    }
  }
  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) {
      if (x + 1 < w) edges.push([nm(x, z), nm(x + 1, z)]);
      if (z + 1 < d) edges.push([nm(x, z), nm(x, z + 1)]);
    }
  }
  return { cells, edges, start: nm(0, 0) };
}

/** The HUGE stress instance: a 6×4 grid, height-3 goal. ~9s to plan (≈10× XL). */
export const SCAVENGER_HUGE = { w: 6, d: 4, goalHeight: 3 };
export const scavengerHugeGoalCell = `c${SCAVENGER_HUGE.w - 1}_0`;

export function scavengerHugeInstance(): StaircaseInstance {
  return scavengerGridInstance(SCAVENGER_HUGE.w, SCAVENGER_HUGE.d);
}

export function scavengerHugeGoal(): import("../src/index").Formula {
  return F.and(F.lit("agentAt", [], scavengerHugeGoalCell), F.eq(N.fl("agentY"), N.c(SCAVENGER_HUGE.goalHeight)));
}
