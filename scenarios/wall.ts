/**
 * Construction World — block pickup-and-place whose goal is a *structure* (a shape
 * made of blocks at specific cells), not a position to stand at. The wall demo is
 * one instance; the domain itself is generic.
 *
 * The point of this scenario is COMPOSABILITY. A naive design bakes the whole
 * shape into one bespoke task ("BuildWall") — but then a slightly different target
 * structure wouldn't match, and the "method" is really just a hard-coded plan. So
 * instead the domain ships two small, reusable HTN building blocks:
 *
 *   • FetchBlock          — ensure the agent is holding a block (grab one from the
 *                           scatter pile if its hands are empty).
 *   • PlaceBlockAt(cell)  — ensure a block rests on `cell` (fetch one, then deliver
 *                           it). Composes FetchBlock.
 *
 * A *structure* is then nothing more than a COMPOSITION of these blocks: a list of
 * `PlaceBlockAt(c)` goals, one per cell of the shape. A wall, a tower, a line, an
 * L — all reuse the exact same two methods; only the cell list (pure data) changes.
 * That's the difference between a composable method and a scenario-specific macro.
 *
 * Two domain rules keep the composition robust without any global, shape-aware
 * coordination:
 *   • `grab` may only take from a `source` cell (the scattered pile), so a block
 *     already laid into the structure can never be cannibalised to satisfy a later
 *     `PlaceBlockAt` — each placement is independent and order-free.
 *   • `place` needs `height(stand) ≥ height(at)` and `goto` may climb at most one
 *     level, the same spatial gating as Scavenger World.
 *
 * Shared by tests/wall.ts and the web preview.
 */
import {
  type DomainDoc,
  type Formula,
  type GoalSpec,
  type Model,
  E,
  F,
  N,
  achieve,
  createModel,
  doTask,
  task,
} from "../src/index";
import type { CellSpec } from "./staircase";

/** A cell counts as "filled" (a block is laid there) once its column reaches this. */
export const BLOCK_HEIGHT = 1;

/**
 * The generic construction domain: spatial pickup-and-place plus the two
 * composable building blocks. Nothing here mentions a wall, a ring, or any
 * particular cell — the shape lives entirely in the goal list (see `wallGoals`).
 */
export const constructionDomain: DomainDoc = {
  name: "construction-world",
  types: [{ name: "cell" }],
  fluents: [
    { name: "height", params: [{ name: "c", type: "cell" }], kind: "int", initial: 0 },
    { name: "pos", params: [{ name: "c", type: "cell" }], kind: "vec2" },
    { name: "adj", params: [{ name: "a", type: "cell" }, { name: "b", type: "cell" }], kind: "boolean", initial: false, static: true },
    // a cell from which blocks may be taken — the scattered pile. Placed structure
    // blocks sit on non-source cells, so they can never be grabbed back.
    { name: "source", params: [{ name: "c", type: "cell" }], kind: "boolean", initial: false, static: true },
    { name: "agentAt", kind: "entity", entityType: "cell" },
    { name: "agentY", kind: "int", initial: 0 },
    { name: "holding", kind: "boolean", initial: false },
  ],
  operators: [
    {
      // walk to an adjacent cell; may ascend at most one level (descend freely)
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
      // pick up the top block of an adjacent SOURCE column you can reach
      name: "grab",
      params: [{ name: "stand", type: "cell" }, { name: "at", type: "cell" }],
      pre: F.and(
        F.not(F.lit("holding")),
        F.lit("agentAt", [], "?stand"),
        F.lit("adj", ["?stand", "?at"]),
        F.lit("source", ["?at"]),
        F.gte(N.fl("height", "?at"), N.c(1)),
        F.gte(N.fl("height", "?stand"), N.sub(N.fl("height", "?at"), N.c(1))),
      ),
      eff: [E.set("holding", [], true), E.dec("height", ["?at"], N.c(1))],
      cost: 1,
    },
    {
      // drop the carried block on a reachable adjacent cell
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
  compounds: [
    { name: "FetchBlock" },
    { name: "PlaceBlockAt", params: [{ name: "c", type: "cell" }] },
  ],
  methods: [
    // FetchBlock — be holding a block.
    { task: "FetchBlock", name: "alreadyHolding", pre: F.lit("holding"), subtasks: [] },
    // otherwise let GOAP route to a source pile and grab one (grab is source-gated)
    { task: "FetchBlock", name: "grabFromPile", subtasks: [achieve(F.lit("holding"))] },

    // PlaceBlockAt(c) — ensure a block rests on c.
    { task: "PlaceBlockAt", name: "alreadyFilled", pre: F.gte(N.fl("height", "?c"), N.c(BLOCK_HEIGHT)), subtasks: [] },
    // compose FetchBlock, then let GOAP deliver the held block onto c (it cannot
    // re-grab while holding, and grab is source-gated, so nothing already laid moves)
    { task: "PlaceBlockAt", name: "fetchAndLay", subtasks: [doTask("FetchBlock"), achieve(F.gte(N.fl("height", "?c"), N.c(BLOCK_HEIGHT)))] },
  ],
};

export interface WallInstance {
  /** the grid (floor tiles); a starting block is encoded as a cell `height` */
  cells: CellSpec[];
  edges: [string, string][];
  start: string;
  /** the cells that must each end up holding a block — the structure */
  targets: string[];
  /** the scattered-pile cells blocks may be taken from */
  sources: string[];
  /** the cell at the heart of the ring (the protected courtyard) — visual only */
  core: string;
}

/** Build a model for a construction instance over the generic domain. */
export function wallModel(inst: WallInstance): Model {
  const entities: Record<string, string> = {};
  for (const c of inst.cells) entities[c.name] = "cell";
  const sourceSet = new Set(inst.sources);
  return createModel(constructionDomain, {
    entities,
    init: (w) => {
      for (const c of inst.cells) {
        w.set("pos", [c.name], [c.x, c.z]);
        if (c.height) w.set("height", [c.name], c.height);
        if (sourceSet.has(c.name)) w.set("source", [c.name], true);
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
 * The structure goal, *composed* from the reusable building block: one
 * `PlaceBlockAt(c)` per target cell. This is all that distinguishes a wall from a
 * tower or any other shape — swap the cell list and the same methods build it.
 */
export function wallGoals(targets: string[]): GoalSpec[] {
  return targets.map((c) => task("PlaceBlockAt", c));
}

/** The equivalent FLAT goal — every target filled at once. Kept for reference and
 *  to show why we decompose: handed to one GOAP search it blows up combinatorially. */
export function wallGoal(targets: string[]): Formula {
  return F.and(...targets.map((c) => F.gte(N.fl("height", c), N.c(BLOCK_HEIGHT))));
}

const nm = (x: number, z: number): string => `c${x}_${z}`;

/**
 * The courtyard fort: a 5×5 yard whose inner ring (the 8 cells around the centre)
 * is the wall. Eight blocks lie scattered around the outer frame; the agent must
 * gather them and lay the ring, enclosing the central `core` tile. Exactly eight
 * blocks for eight slots, so a finished wall leaves the yard tidy.
 *
 *      z=4  ■ . ■ . ■        ■ = scattered block (source)   ◻ = wall slot (goal)
 *      z=3  . ◻ ◻ ◻ .        ● = courtyard core             S = agent start
 *      z=2  ■ ◻ ● ◻ ■
 *      z=1  . ◻ ◻ ◻ .
 *      z=0  ■ . S . ■
 *           0 1 2 3 4  (x)
 */
export function wallInstance(): WallInstance {
  const W = 5;
  const core: [number, number] = [2, 2];
  const scattered: [number, number][] = [
    [0, 0], [4, 0], [0, 2], [4, 2], [0, 4], [2, 4], [4, 4], [2, 0],
  ];
  const start: [number, number] = [2, 0];

  const blockSet = new Set(scattered.map(([x, z]) => nm(x, z)));

  const cells: CellSpec[] = [];
  const edges: [string, string][] = [];
  for (let z = 0; z < W; z++) {
    for (let x = 0; x < W; x++) {
      const name = nm(x, z);
      cells.push({ name, x, z, height: blockSet.has(name) ? 1 : undefined });
      if (x + 1 < W) edges.push([name, nm(x + 1, z)]);
      if (z + 1 < W) edges.push([name, nm(x, z + 1)]);
    }
  }

  // lay the wall in a stable clockwise order from the bottom-left slot — purely so
  // the build reads as a tidy sweep; order doesn't affect correctness (source-gated
  // grab makes each placement independent).
  const order: [number, number][] = [
    [1, 1], [2, 1], [3, 1], [3, 2], [3, 3], [2, 3], [1, 3], [1, 2],
  ];

  return {
    cells,
    edges,
    start: nm(start[0], start[1]),
    targets: order.map(([x, z]) => nm(x, z)),
    sources: scattered.map(([x, z]) => nm(x, z)),
    core: nm(core[0], core[1]),
  };
}
