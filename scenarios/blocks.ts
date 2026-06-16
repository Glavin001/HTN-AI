/**
 * Blocks World — the canonical AI-planning benchmark, in the 4-operator STRIPS
 * formulation (pickup / putdown / unstack / stack) with an explicit gripper.
 *
 * This is the richer cousin of the 3-operator "move" blocks world in
 * tests/puzzles.ts: it adds a held-block state (`holding` / `handEmpty`) and a
 * `hand` entity, so the same domain scales from one arm to several arms
 * (multi-effector coordination) and can be driven through the reactive Planner
 * with executors — exercising plan repair on a stacking domain.
 *
 * Shared by tests/blocks.ts (ground-truth assertions) and the web preview.
 */
import {
  type DomainDoc,
  type InitWriter,
  type Model,
  type Registry,
  E,
  F,
  createModel,
} from "../src/index";

/** entity gid 0 (= null) denotes "the table" for `on`, and "empty" for `holding`. */
export const TABLE = 0;

export const blocksDomain: DomainDoc = {
  name: "blocks-world",
  types: [{ name: "block" }, { name: "hand" }],
  fluents: [
    // what each block rests on; 0 / null = the table
    { name: "on", params: [{ name: "b", type: "block" }], kind: "entity", entityType: "block" },
    // nothing is stacked on top of the block (a held block is not clear)
    { name: "clear", params: [{ name: "b", type: "block" }], kind: "boolean", initial: true },
    // the block a hand currently holds; 0 / null = empty
    { name: "holding", params: [{ name: "h", type: "hand" }], kind: "entity", entityType: "block" },
    { name: "handEmpty", params: [{ name: "h", type: "hand" }], kind: "boolean", initial: true },
  ],
  operators: [
    {
      name: "pickup", // lift a clear block off the table
      params: [{ name: "h", type: "hand" }, { name: "b", type: "block" }],
      pre: F.and(F.lit("handEmpty", ["?h"]), F.lit("clear", ["?b"]), F.lit("on", ["?b"], TABLE)),
      eff: [E.set("holding", ["?h"], "?b"), E.set("handEmpty", ["?h"], false), E.set("clear", ["?b"], false)],
      cost: 1,
    },
    {
      name: "putdown", // set the held block down on the table
      params: [{ name: "h", type: "hand" }, { name: "b", type: "block" }],
      pre: F.lit("holding", ["?h"], "?b"),
      eff: [
        E.set("on", ["?b"], TABLE),
        E.set("clear", ["?b"], true),
        E.set("handEmpty", ["?h"], true),
        E.set("holding", ["?h"], TABLE),
      ],
      cost: 1,
    },
    {
      name: "unstack", // lift a clear block off the block `from`
      params: [{ name: "h", type: "hand" }, { name: "b", type: "block" }, { name: "from", type: "block" }],
      pre: F.and(F.lit("handEmpty", ["?h"]), F.lit("clear", ["?b"]), F.lit("on", ["?b"], "?from")),
      eff: [
        E.set("holding", ["?h"], "?b"),
        E.set("handEmpty", ["?h"], false),
        E.set("clear", ["?b"], false),
        E.set("clear", ["?from"], true),
        E.set("on", ["?b"], TABLE),
      ],
      cost: 1,
    },
    {
      name: "stack", // place the held block onto a clear block `onto`
      params: [{ name: "h", type: "hand" }, { name: "b", type: "block" }, { name: "onto", type: "block" }],
      pre: F.and(F.lit("holding", ["?h"], "?b"), F.lit("clear", ["?onto"])),
      eff: [
        E.set("on", ["?b"], "?onto"),
        E.set("clear", ["?onto"], false),
        E.set("clear", ["?b"], true),
        E.set("handEmpty", ["?h"], true),
        E.set("holding", ["?h"], TABLE),
      ],
      cost: 1,
    },
  ],
};

export interface BlocksSetup {
  blocks: string[];
  /** hand entity names; defaults to a single arm */
  hands?: string[];
  /** seed the initial stacking (defaults: every block on the table, all clear) */
  init?: (w: InitWriter) => void;
  registry?: Registry;
}

/** Build a model over the named blocks + hands with the given initial layout. */
export function blocksModel(setup: BlocksSetup): Model {
  const entities: Record<string, string> = {};
  for (const b of setup.blocks) entities[b] = "block";
  for (const h of setup.hands ?? ["arm"]) entities[h] = "hand";
  return createModel(blocksDomain, { entities, init: setup.init ?? (() => undefined) }, setup.registry ?? {});
}

/**
 * The Sussman anomaly: C on A, A and B on the table; goal A-on-B-on-C. The
 * naive "stack A on B, then B on C" order deadlocks, so the planner must
 * interleave subgoals. Optimal solution is 6 actions in this formulation.
 */
export function sussmanSetup(): BlocksSetup {
  return {
    blocks: ["a", "b", "c"],
    init: (w) => {
      w.set("on", ["c"], "a"); // C starts on A
      w.set("clear", ["a"], false); // A is covered by C
    },
  };
}

/**
 * A single tower `names[0]`-on-`names[1]`-…-on-table, used to test "reverse the
 * stack" goals at scale. Returns the setup plus the names for goal building.
 */
export function towerSetup(names: string[], hands?: string[]): BlocksSetup {
  return {
    blocks: names,
    hands,
    init: (w) => {
      for (let i = 0; i < names.length - 1; i++) {
        w.set("on", [names[i]], names[i + 1]); // names[i] sits on names[i+1]
        w.set("clear", [names[i + 1]], false);
      }
    },
  };
}
