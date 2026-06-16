/**
 * Wall World — a *structure-building* block scenario. Unlike Staircase/Scavenger,
 * whose goal is a 3D POSITION the agent must stand at, here the goal is a SHAPE
 * made of blocks: a ring of cells that must each hold a block, forming a wall
 * that encloses a central courtyard. Blocks start scattered around the yard; the
 * agent collects them and lays them along the wall line.
 *
 * The twist that makes this interesting for htn-ai: laying an 8-cell wall is a
 * conjunction of eight numeric sub-goals, and one-shot GOAP search over that
 * conjunction blows up combinatorially (symmetric block↔slot assignments × free
 * movement). So the wall is expressed as an HTN compound — `BuildWall` — that
 * decomposes the structure into an ordered list of per-slot `achieve` sub-goals.
 * Each sub-goal ("get a block onto THIS slot") is a small, fast pickup-and-place
 * that the GOAP layer solves on its own. Hierarchy makes the intractable
 * tractable: the same planner that times out on the flat goal finishes the
 * decomposed one in milliseconds.
 *
 * Reuses the Scavenger domain's grab/place mechanics (blocks are column heights,
 * `grab` lifts the top of an adjacent column, `place` drops onto an adjacent
 * cell). Shared by tests/wall.ts and the web preview.
 */
import {
  type DomainDoc,
  type Formula,
  type Model,
  type SubtaskDef,
  F,
  N,
  achieve,
  createModel,
} from "../src/index";
import { scavengerDomain, type CellSpec } from "./staircase";

/** A block counts as "wall" once its column reaches this height. */
export const WALL_SLOT_HEIGHT = 1;

export interface WallInstance {
  /** the grid (floor tiles); blocks present are encoded as cell `height` */
  cells: CellSpec[];
  edges: [string, string][];
  start: string;
  /** the cells that must each end up holding a block — the wall line */
  targets: string[];
  /** the cell at the heart of the ring (the protected courtyard) — visual only */
  core: string;
}

/**
 * The Wall domain = the Scavenger mechanics (goto / grab / place) plus a single
 * HTN compound, `BuildWall`, whose method decomposes into one `achieve` per wall
 * slot, in a stable order. Because the target list is instance data, the domain
 * is generated per instance — each slot becomes its own ordered sub-goal.
 */
export function wallDomain(targets: string[]): DomainDoc {
  // Each step extends the wall by one slot while *keeping every slot laid so far*
  // — the cumulative conjunction is what stops a later pickup-and-place from
  // cannibalising a block already in the wall (a plain per-slot goal only guards
  // the current slot, so GOAP would happily rob an earlier one). Entering step k
  // the first k−1 slots already hold, so the sub-search only has to add one more.
  const upTo = (k: number): SubtaskDef =>
    achieve(F.and(...targets.slice(0, k + 1).map((c) => F.gte(N.fl("height", c), N.c(WALL_SLOT_HEIGHT)))));
  return {
    ...scavengerDomain,
    name: "wall-world",
    compounds: [{ name: "BuildWall" }],
    methods: [
      {
        task: "BuildWall",
        subtasks: targets.map((_, k) => upTo(k)),
      },
    ],
  };
}

/** Build a model for a Wall instance (blocks are encoded as starting heights). */
export function wallModel(inst: WallInstance): Model {
  const entities: Record<string, string> = {};
  for (const c of inst.cells) entities[c.name] = "cell";
  return createModel(wallDomain(inst.targets), {
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

/** The flat goal, for reference/labels: every wall slot holds a block. */
export function wallGoal(targets: string[]): Formula {
  return F.and(...targets.map((c) => F.gte(N.fl("height", c), N.c(WALL_SLOT_HEIGHT))));
}

const nm = (x: number, z: number): string => `c${x}_${z}`;

/**
 * The courtyard fort: a 5×5 yard whose inner ring (the 8 cells around the centre)
 * is the wall line. Eight blocks lie scattered around the outer frame; the agent
 * must gather them and lay the ring, enclosing the central `core` tile. Exactly
 * eight blocks for eight slots, so a finished wall leaves the yard tidy.
 *
 *      z=4  ■ . ■ . ■        ■ = scattered block      ◻ = wall slot (goal)
 *      z=3  . ◻ ◻ ◻ .        ● = courtyard core       S = agent start
 *      z=2  ■ ◻ ● ◻ ■
 *      z=1  . ◻ ◻ ◻ .
 *      z=0  ■ . S . ■
 *           0 1 2 3 4  (x)
 */
export function wallInstance(): WallInstance {
  const W = 5;
  const core: [number, number] = [2, 2];
  // eight scattered blocks around the outer frame (corners + edge midpoints)
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

  // lay the wall in a stable clockwise order from the bottom-left slot — this is
  // the order the HTN method walks, so the build reads as a tidy sweep.
  const order: [number, number][] = [
    [1, 1], [2, 1], [3, 1], [3, 2], [3, 3], [2, 3], [1, 3], [1, 2],
  ];

  return {
    cells,
    edges,
    start: nm(start[0], start[1]),
    targets: order.map(([x, z]) => nm(x, z)),
    core: nm(core[0], core[1]),
  };
}

/** Cells that begin with a scattered block — for the renderer's "source" styling. */
export function wallSources(inst: WallInstance): string[] {
  return inst.cells.filter((c) => (c.height ?? 0) > 0).map((c) => c.name);
}
