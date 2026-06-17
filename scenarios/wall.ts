/**
 * Construction World — block pickup-and-place whose goal is a *structure* (a shape
 * made of blocks at specific cells), not a position to stand at. The wall demo is
 * one instance; the domain itself is generic.
 *
 * The goal is purely DECLARATIVE: a final-state condition — "every wall cell ends
 * up `wantHeight` blocks tall". The domain has only primitive operators (goto /
 * grab / place); there is no `BuildWall` task, no `PlaceBlockAt` method, nothing
 * telling the agent *how* to satisfy that state. The planner DISCOVERS that it
 * must walk to a scattered block, pick it up, carry it, and set it down — and does
 * so for each cell — purely from search over the operators.
 *
 * The only non-obvious part is making that tractable at scale. Laying an N-cell
 * wall is a conjunction of N near-identical, serializable sub-goals; one search
 * over the whole conjunction blows up combinatorially (every ordering and block↔
 * slot assignment is a distinct state). The standard symbolic-planning fix is to
 * *serialize*: the Planner's `goalAgenda` mode automatically splits the declarative
 * conjunction into its per-cell conjuncts and commits to them one at a time —
 * turning one exponential search into N small ones, linear in cells. The agenda is
 * derived from the goal's own structure, not prescribed by the caller.
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
  type Formula,
  type Model,
  E,
  F,
  N,
  createModel,
} from "../src/index";
import type { CellSpec } from "./staircase";

/**
 * The generic construction domain: just the primitive spatial actions. Nothing
 * here mentions a wall, a ring, or how to build anything — the desired shape lives
 * entirely in the declarative goal and in each cell's static `wantHeight`.
 *
 * `reachUp` controls the only physics knob that matters for the demo:
 *   • true  — the agent may place a block ONE level above where it stands. A wall
 *             cell can then be built to full height from the ground, so the cells
 *             are INDEPENDENT (the easy wall; plain goal-agenda suffices).
 *   • false — realistic: the agent must stand at ≥ the target column's height to
 *             place. Topping a cell needs an adjacent cell already built up, so the
 *             cells INTERFERE (the hard wall; needs landmark layering — base course
 *             before top course).
 */
function makeConstructionDomain(reachUp: boolean): DomainDoc {
  return {
  name: reachUp ? "construction-world" : "construction-world-strict",
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
      // drop the carried block on an adjacent cell. With reachUp you may build one
      // level above where you stand; without it you must stand at ≥ the target's
      // height (so a cell can only be topped from an already-raised neighbour).
      name: "place",
      params: [{ name: "stand", type: "cell" }, { name: "at", type: "cell" }],
      pre: F.and(
        F.lit("holding"),
        F.lit("agentAt", [], "?stand"),
        F.lit("adj", ["?stand", "?at"]),
        F.gte(N.fl("height", "?stand"), reachUp ? N.sub(N.fl("height", "?at"), N.c(1)) : N.fl("height", "?at")),
      ),
      eff: [E.set("holding", [], false), E.inc("height", ["?at"], N.c(1))],
      cost: 1,
    },
  ],
  };
}

/** Easy physics: place reaches one level up, so wall cells are independent. */
export const constructionDomain: DomainDoc = makeConstructionDomain(true);
/** Realistic physics: no reach-up, so wall cells interfere (base before top). */
export const strictConstructionDomain: DomainDoc = makeConstructionDomain(false);

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
  /** realistic physics: no reach-up, so cells interfere and landmark layering is
   *  needed (default false = the easy, independent wall) */
  strictReach?: boolean;
}

/** Build a model for a construction instance over the generic domain. */
export function wallModel(inst: WallInstance): Model {
  const entities: Record<string, string> = {};
  for (const c of inst.cells) entities[c.name] = "cell";
  const domain = inst.strictReach ? strictConstructionDomain : constructionDomain;
  const sourceSet = new Set(inst.sources);
  const targetSet = new Set(inst.targets);
  return createModel(domain, {
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
 * The DECLARATIVE structure goal: a final-state condition — every target cell ends
 * up `wantHeight` blocks tall. This is the *only* thing describing the wall; it
 * says nothing about picking up or placing blocks. Hand it to a Planner with
 * `goalAgenda: true` and the planner splits the conjunction into per-cell subgoals,
 * serializes them, and discovers the goto/grab/place actions for each by search.
 *
 * Handed to a planner WITHOUT goal-agenda it is solved as one joint search — which
 * is the combinatorial blow-up the serialization exists to avoid.
 */
export function wallGoal(inst: WallInstance): Formula {
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

/**
 * The HARD wall: the exact same courtyard fort, but under realistic physics
 * (`strictReach`) — the agent can't place a block above its own reach. Now a ring
 * cell can only be topped from an adjacent cell that's already been raised, so the
 * 24 sub-goals INTERFERE: a lone 2-tall pillar is unbuildable, and per-cell
 * serialization strands cells it can't reach. Solving it needs the base course
 * laid before any top course — i.e. threshold-landmark layering (`landmarks: true`).
 */
export function wallInstanceHard(): WallInstance {
  return { ...wallInstance(), strictReach: true };
}
