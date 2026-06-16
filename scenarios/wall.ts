/**
 * Construction World — block pickup-and-place whose goal is a *structure* (a shape
 * made of blocks at specific cells), not a position to stand at. The wall demo is
 * one instance; the domain itself is generic.
 *
 * Two ideas carry the scenario:
 *
 * 1. COMPOSABLE METHODS. There is no bespoke "build wall" task. The domain ships
 *    two small, reusable HTN building blocks — FetchBlock (be holding a block) and
 *    PlaceBlockAt(cell) (raise a cell to its target height, composing FetchBlock).
 *    A *structure* is just a COMPOSITION: a list of PlaceBlockAt(c) goals, one per
 *    cell of the shape. A wall, a tower, a line, an L — all reuse the same methods;
 *    only the cell list (data) changes.
 *
 * 2. GOAL-AGENDA SERIALIZATION. Laying an N-cell wall is a conjunction of N
 *    near-identical, serializable sub-goals. Handed to ONE search that conjunction
 *    blows up combinatorially (every ordering and block↔slot assignment is a
 *    distinct state). The standard symbolic-planning fix is to *serialize*: solve
 *    one sub-goal, commit, then plan the next from the reached state. The Planner's
 *    `goalAgenda` mode does exactly this, turning one exponential search into N
 *    small ones — cost grows linearly in cells instead of factorially.
 *
 * Serialization is only sound if the sub-goals don't clobber each other, which two
 * domain rules guarantee:
 *   • `grab` may only take from a `source` cell (the scattered pile), so a block
 *     already laid into the wall is never cannibalised to satisfy a later sub-goal.
 *   • `place` may reach ONE level up (`height(stand) ≥ height(at) − 1`, mirroring
 *     `grab`), so a 2-course wall is laid from the ground without the agent ever
 *     needing to climb its own half-built wall — each cell is independent.
 *
 * Shared by tests/wall.ts and the web preview.
 */
import {
  type DomainDoc,
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

/**
 * The generic construction domain: spatial pickup-and-place plus the two
 * composable building blocks. Nothing here mentions a wall, a ring, or any
 * particular cell — the shape lives entirely in the goal list and in each cell's
 * `wantHeight`.
 */
export const constructionDomain: DomainDoc = {
  name: "construction-world",
  types: [{ name: "cell" }],
  fluents: [
    { name: "height", params: [{ name: "c", type: "cell" }], kind: "int", initial: 0 },
    // the target height for a cell (0 = not part of the structure); static, set per instance
    { name: "wantHeight", params: [{ name: "c", type: "cell" }], kind: "int", initial: 0, static: true },
    { name: "pos", params: [{ name: "c", type: "cell" }], kind: "vec2" },
    { name: "adj", params: [{ name: "a", type: "cell" }, { name: "b", type: "cell" }], kind: "boolean", initial: false, static: true },
    // a cell blocks may be taken from — the scattered pile. Laid structure blocks
    // sit on non-source cells, so they can never be grabbed back.
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
      // drop the carried block on an adjacent cell, reaching up at most one level
      name: "place",
      params: [{ name: "stand", type: "cell" }, { name: "at", type: "cell" }],
      pre: F.and(
        F.lit("holding"),
        F.lit("agentAt", [], "?stand"),
        F.lit("adj", ["?stand", "?at"]),
        F.gte(N.fl("height", "?stand"), N.sub(N.fl("height", "?at"), N.c(1))),
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

    // PlaceBlockAt(c) — raise c to its target height.
    { task: "PlaceBlockAt", name: "atHeight", pre: F.gte(N.fl("height", "?c"), N.fl("wantHeight", "?c")), subtasks: [] },
    // fetch a block, then let GOAP deliver it onto c (and fetch/deliver again until
    // c reaches wantHeight). Can't re-grab while holding, and grab is source-gated,
    // so nothing already laid moves.
    { task: "PlaceBlockAt", name: "lay", subtasks: [doTask("FetchBlock"), achieve(F.gte(N.fl("height", "?c"), N.fl("wantHeight", "?c")))] },
  ],
};

export interface WallInstance {
  /** the grid (floor tiles); a starting block is encoded as a cell `height` */
  cells: CellSpec[];
  edges: [string, string][];
  start: string;
  /** the cells that make up the structure, in build order */
  targets: string[];
  /** how tall each target must become (uniform here, but per-cell capable) */
  wantHeight: number;
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
  const targetSet = new Set(inst.targets);
  return createModel(constructionDomain, {
    entities,
    init: (w) => {
      for (const c of inst.cells) {
        w.set("pos", [c.name], [c.x, c.z]);
        if (c.height) w.set("height", [c.name], c.height);
        if (sourceSet.has(c.name)) w.set("source", [c.name], true);
        if (targetSet.has(c.name)) w.set("wantHeight", [c.name], inst.wantHeight);
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
 * `PlaceBlockAt(c)` per target cell. Swap the cell list and the same methods build
 * any other shape. Hand this list to a Planner with `goalAgenda: true` so the
 * sub-goals are serialized (one committed placement at a time).
 */
export function wallGoals(targets: string[]): GoalSpec[] {
  return targets.map((c) => task("PlaceBlockAt", c));
}

/** The equivalent FLAT goal — every target at its height at once. Kept for
 *  reference and to show why we serialize: one GOAP search over it blows up. */
export function wallGoal(inst: WallInstance): import("../src/index").Formula {
  return F.and(...inst.targets.map((c) => F.gte(N.fl("height", c), N.c(inst.wantHeight))));
}

const nm = (x: number, z: number): string => `c${x}_${z}`;
const cheby = (x: number, z: number, cx: number, cz: number): number => Math.max(Math.abs(x - cx), Math.abs(z - cz));

/**
 * The courtyard fort: a 9×9 yard whose octagonal inner ring (the 5×5 perimeter
 * around the centre, minus its four corners — 12 cells) is the wall, built TWO
 * courses tall. The agent gathers loose blocks scattered just outside the ring and
 * lays the wall slot by slot, enclosing the central `core` tile.
 *
 *      a 12-cell ring × 2 courses = 24 blocks; 24 loose blocks are scattered on the
 *      cells nearest the ring, so a finished wall leaves the yard tidy.
 */
export function wallInstance(): WallInstance {
  const G = 9;
  const cx = 4, cz = 4;

  // octagonal ring: 5×5 perimeter around the centre minus the 4 corners
  const ring: [number, number][] = [];
  for (let x = cx - 2; x <= cx + 2; x++) {
    for (let z = cz - 2; z <= cz + 2; z++) {
      const onPerim = x === cx - 2 || x === cx + 2 || z === cz - 2 || z === cz + 2;
      const isCorner = (x === cx - 2 || x === cx + 2) && (z === cz - 2 || z === cz + 2);
      if (onPerim && !isCorner) ring.push([x, z]);
    }
  }
  // stable clockwise build order from the top edge — reads as a tidy sweep
  ring.sort((a, b) => Math.atan2(a[1] - cz, a[0] - cx) - Math.atan2(b[1] - cz, b[0] - cx));
  const wallSet = new Set(ring.map(([x, z]) => nm(x, z)));

  const wantHeight = 2;
  const blocksNeeded = ring.length * wantHeight;

  // scatter the loose blocks on the cells nearest the ring (short fetches keep each
  // per-cell search small), excluding the ring itself and the enclosed courtyard.
  const candidates: [number, number][] = [];
  for (let z = 0; z < G; z++) {
    for (let x = 0; x < G; x++) {
      if (wallSet.has(nm(x, z))) continue;
      if (cheby(x, z, cx, cz) <= 2) continue; // courtyard interior + ring corners stay clear
      candidates.push([x, z]);
    }
  }
  candidates.sort((a, b) => cheby(a[0], a[1], cx, cz) - cheby(b[0], b[1], cx, cz));
  const scattered = candidates.slice(0, blocksNeeded);
  const sourceSet = new Set(scattered.map(([x, z]) => nm(x, z)));

  const cells: CellSpec[] = [];
  const edges: [string, string][] = [];
  for (let z = 0; z < G; z++) {
    for (let x = 0; x < G; x++) {
      const name = nm(x, z);
      cells.push({ name, x, z, height: sourceSet.has(name) ? 1 : undefined });
      if (x + 1 < G) edges.push([name, nm(x + 1, z)]);
      if (z + 1 < G) edges.push([name, nm(x, z + 1)]);
    }
  }

  return {
    cells,
    edges,
    start: nm(0, 0),
    targets: ring.map(([x, z]) => nm(x, z)),
    wantHeight,
    sources: scattered.map(([x, z]) => nm(x, z)),
    core: nm(cx, cz),
  };
}
