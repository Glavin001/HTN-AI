import { test } from "uvu";
import * as assert from "uvu/assert";
import { DomainDoc, E, F, N, createModel, goal, planOnce } from "../src/index";

/**
 * The remaining PR #14 puzzle scenarios that are genuine planning/search
 * problems — solved here BY THE PLANNER (no scripted solutions). Each is a
 * distinct usage pattern for library users to learn from.
 *
 *  - word ladder      : graph search over a dictionary (one-letter steps)
 *  - crafting         : numeric resource production planning (Minecraft-style)
 *  - treasure hunt    : sequential clue-gated navigation
 */

// ---------------------------------------------------------------- word ladder

test("word ladder: cat → dog in the optimal 3 transformations (graph search)", () => {
  const words = ["cat", "cot", "cog", "dog", "bat", "bad", "bag", "dot", "cob"];
  const oneApart = (a: string, b: string): boolean => {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    return diff === 1;
  };
  const doc: DomainDoc = {
    name: "wordLadder",
    types: [{ name: "word" }],
    fluents: [
      { name: "cur", kind: "entity", entityType: "word" },
      {
        name: "adj",
        params: [
          { name: "a", type: "word" },
          { name: "b", type: "word" },
        ],
        kind: "boolean",
      },
    ],
    operators: [
      {
        name: "step",
        params: [
          { name: "from", type: "word" },
          { name: "to", type: "word" },
        ],
        pre: F.and(F.lit("cur", [], "?from"), F.lit("adj", ["?from", "?to"])),
        eff: [E.set("cur", [], "?to")],
      },
    ],
  };
  const model = createModel(doc, {
    entities: Object.fromEntries(words.map((w) => [w, "word"])),
    init: (w) => {
      w.set("cur", [], "cat");
      for (const a of words) for (const b of words) if (oneApart(a, b)) w.set("adj", [a, b], true);
    },
  });
  const result = planOnce(model, model.createExecState(), { goals: [goal(F.lit("cur", [], "dog"))], weight: 1 });
  assert.equal(result.status, "success");
  assert.equal(result.plan!.steps.length, 3, "cat→cot→cog→dog (or an equal-length ladder)");
  // every step is a legal one-letter move ending at dog
  const last = result.plan!.steps[2];
  assert.ok(last.k === "op" && model.entityName(last.g.b[1]) === "dog");
});

// ---------------------------------------------------------------- crafting / recipe assembly

test("crafting: produce a pickaxe from raw resources — optimal 7-step numeric plan", () => {
  const doc: DomainDoc = {
    name: "crafting",
    fluents: [
      { name: "logs", kind: "int", initial: 0 },
      { name: "planks", kind: "int", initial: 0 },
      { name: "sticks", kind: "int", initial: 0 },
      { name: "cobble", kind: "int", initial: 0 },
      { name: "pickaxe", kind: "boolean" },
    ],
    operators: [
      { name: "chop", eff: [E.inc("logs", [], 1)] },
      { name: "mine", eff: [E.inc("cobble", [], 1)] },
      { name: "makePlanks", pre: F.gte(N.fl("logs"), 1), eff: [E.dec("logs", [], 1), E.inc("planks", [], 4)] },
      { name: "makeSticks", pre: F.gte(N.fl("planks"), 2), eff: [E.dec("planks", [], 2), E.inc("sticks", [], 2)] },
      {
        name: "craftPickaxe",
        pre: F.and(F.gte(N.fl("sticks"), 2), F.gte(N.fl("cobble"), 3)),
        eff: [E.set("pickaxe", [], true), E.dec("sticks", [], 2), E.dec("cobble", [], 3)],
      },
    ],
  };
  const model = createModel(doc, {});
  const result = planOnce(model, model.createExecState(), { goals: [goal(F.lit("pickaxe"))], weight: 1 });
  assert.equal(result.status, "success");
  // ground truth: chop, makePlanks(→4), makeSticks(→2 sticks), mine×3, craftPickaxe = 7
  assert.equal(result.plan!.steps.length, 7, "minimal resource chain");
  const counts: Record<string, number> = {};
  for (const s of result.plan!.steps) if (s.k === "op") counts[s.g.op.name] = (counts[s.g.op.name] ?? 0) + 1;
  assert.equal(counts.mine, 3, "exactly three cobblestone mined");
  assert.equal(counts.craftPickaxe, 1);
});

// ---------------------------------------------------------------- treasure hunt

test("treasure hunt: clue-gated navigation finds the treasure via the correct route", () => {
  const doc: DomainDoc = {
    name: "treasure",
    types: [{ name: "place" }],
    fluents: [
      { name: "at", kind: "entity", entityType: "place" },
      {
        name: "path",
        params: [
          { name: "a", type: "place" },
          { name: "b", type: "place" },
        ],
        kind: "boolean",
      },
      { name: "clue1", kind: "boolean" },
      { name: "clue2", kind: "boolean" },
      { name: "treasure", kind: "boolean" },
    ],
    operators: [
      {
        name: "goto",
        params: [
          { name: "a", type: "place" },
          { name: "b", type: "place" },
        ],
        pre: F.and(F.lit("at", [], "?a"), F.lit("path", ["?a", "?b"])),
        eff: [E.set("at", [], "?b")],
      },
      // clue chain: the fountain reveals clue1, the library (needs clue1) reveals clue2,
      // the crypt (needs clue2) holds the treasure
      { name: "readFountain", pre: F.lit("at", [], "fountain"), eff: [E.set("clue1", [], true)] },
      { name: "searchLibrary", pre: F.and(F.lit("at", [], "library"), F.lit("clue1")), eff: [E.set("clue2", [], true)] },
      { name: "digCrypt", pre: F.and(F.lit("at", [], "crypt"), F.lit("clue2")), eff: [E.set("treasure", [], true)] },
    ],
  };
  const model = createModel(doc, {
    entities: { gate: "place", fountain: "place", library: "place", market: "place", crypt: "place" },
    init: (w) => {
      w.set("at", [], "gate");
      const edges: [string, string][] = [
        ["gate", "fountain"],
        ["gate", "market"],
        ["fountain", "library"],
        ["market", "library"],
        ["library", "crypt"],
        ["market", "crypt"],
      ];
      for (const [a, b] of edges) {
        w.set("path", [a, b], true);
        w.set("path", [b, a], true);
      }
    },
  });
  const result = planOnce(model, model.createExecState(), { goals: [goal(F.lit("treasure"))], weight: 1 });
  assert.equal(result.status, "success");
  const ops = result.plan!.steps.map((s) => (s.k === "op" ? s.g.op.name : "?"));
  // must read the fountain before the library is useful, and visit the crypt last
  assert.ok(ops.indexOf("readFountain") < ops.indexOf("searchLibrary"), "clue1 before clue2");
  assert.ok(ops.indexOf("searchLibrary") < ops.indexOf("digCrypt"), "clue2 before treasure");
  assert.equal(ops[ops.length - 1], "digCrypt");
});

test.run();
