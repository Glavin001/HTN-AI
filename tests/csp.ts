import { test } from "uvu";
import * as assert from "uvu/assert";
import { DomainDoc, E, F, N, OperatorDecl, createModel, goal, planOnce, simulatePlan } from "../src/index";

/**
 * Constraint-style puzzles from PR #14 (sudoku, logic grid, crossword),
 * solved BY THE PLANNER as backtracking search rather than scripted. Each
 * uses a "first unfilled slot" ordering predicate so the search behaves like
 * classic CSP backtracking with forward consistency checks — a useful pattern
 * for users encoding assignment problems.
 */

// ---------------------------------------------------------------- sudoku 4×4

test("sudoku 4×4: the planner completes the grid by constrained backtracking search", () => {
  const cells = Array.from({ length: 16 }, (_, i) => `c${i}`);
  const rows = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => r * 4 + c));
  const cols = [0, 1, 2, 3].map((c) => [0, 1, 2, 3].map((r) => r * 4 + c));
  const boxes = [
    [0, 1, 4, 5],
    [2, 3, 6, 7],
    [8, 9, 12, 13],
    [10, 11, 14, 15],
  ];
  const peers: number[][] = cells.map((_, i) => {
    const set = new Set<number>();
    for (const group of [...rows, ...cols, ...boxes]) if (group.includes(i)) group.forEach((j) => j !== i && set.add(j));
    return [...set];
  });
  const idxOf = (name: string): number => Number(name.slice(1));

  // one operator per digit (the effect value differs); digit d encodes to enum index d
  const placeOps: OperatorDecl[] = [1, 2, 3, 4].map((d) => ({
    name: `place${d}`,
    params: [{ name: "cell", type: "cell" }],
    pre: F.and(
      F.lit("grid", ["?cell"], "empty"),
      F.ext("firstEmpty", ["?cell"], ["grid"]),
      F.ext("valid", ["?cell", d], ["grid"]),
    ),
    eff: [E.set("grid", ["?cell"], String(d))],
  }));

  const doc: DomainDoc = {
    name: "sudoku4",
    types: [{ name: "cell" }],
    fluents: [{ name: "grid", params: [{ name: "c", type: "cell" }], kind: "enum", values: ["empty", "1", "2", "3", "4"], initial: "empty" }],
    operators: placeOps,
  };

  // givens (the rest are blank); a valid completion exists
  const givens: Record<number, string> = { 0: "1", 3: "4", 5: "4", 6: "1", 9: "1", 10: "4", 12: "4", 15: "1" };
  const model = createModel(
    doc,
    {
      entities: Object.fromEntries(cells.map((c) => [c, "cell"])),
      init: (w) => {
        for (const [i, v] of Object.entries(givens)) w.set("grid", [`c${i}`], v);
      },
    },
    {
      predicates: {
        firstEmpty: (q) => {
          const i = idxOf(q.name(q.args[0]));
          if (q.get("grid", `c${i}`) !== 0) return false; // not empty
          for (let k = 0; k < i; k++) if (q.get("grid", `c${k}`) === 0) return false; // an earlier cell is still empty
          return true;
        },
        valid: (q) => {
          const i = idxOf(q.name(q.args[0]));
          const d = q.args[1];
          for (const p of peers[i]) if (q.get("grid", `c${p}`) === d) return false;
          return true;
        },
      },
    },
  );

  const result = planOnce(model, model.createExecState(), {
    goals: [goal(F.and(...cells.map((c) => F.not(F.lit("grid", [c], "empty")))))],
    weight: 1,
  });
  assert.equal(result.status, "success");
  assert.equal(result.plan!.steps.length, 16 - Object.keys(givens).length, "one placement per blank cell");

  // the produced grid is a valid 4×4 sudoku
  const { end } = simulatePlan(model, model.createExecState(), result.plan!);
  const valueAt = (i: number): number => end.get(model.slotOf("grid", model.entityId(`c${i}`)));
  for (const group of [...rows, ...cols, ...boxes]) {
    const vals = group.map(valueAt).sort();
    assert.equal(vals, [1, 2, 3, 4], `group ${group} is a permutation of 1..4`);
  }
});

// ---------------------------------------------------------------- logic grid (seating)

test("logic grid: deduce a unique seating from relational clues by search", () => {
  // people in declared order; first-unassigned ordering makes this CSP backtracking
  const people = ["alice", "bob", "carol"];
  const seats = ["s1", "s2", "s3"]; // left → right, index 1..3
  const doc: DomainDoc = {
    name: "seating",
    types: [{ name: "person" }, { name: "seat" }],
    fluents: [
      { name: "seatOf", params: [{ name: "p", type: "person" }], kind: "entity", entityType: "seat" },
      { name: "taken", params: [{ name: "s", type: "seat" }], kind: "boolean" },
      { name: "idx", params: [{ name: "s", type: "seat" }], kind: "int" },
    ],
    operators: [
      {
        name: "sit",
        params: [
          { name: "p", type: "person" },
          { name: "s", type: "seat" },
        ],
        pre: F.and(F.cmp("==", N.fl("seatOf", "?p"), 0), F.not(F.lit("taken", ["?s"])), F.ext("firstUnseated", ["?p"], ["seatOf"])),
        eff: [E.set("seatOf", ["?p"], "?s"), E.set("taken", ["?s"], true)],
      },
    ],
  };
  const model = createModel(
    doc,
    {
      entities: { alice: "person", bob: "person", carol: "person", s1: "seat", s2: "seat", s3: "seat" },
      init: (w) => seats.forEach((s, i) => w.set("idx", [s], i + 1)),
    },
    {
      predicates: {
        firstUnseated: (q) => {
          const p = q.name(q.args[0]);
          if (q.get("seatOf", p) !== 0) return false;
          for (const earlier of people) {
            if (earlier === p) break;
            if (q.get("seatOf", earlier) === 0) return false;
          }
          return true;
        },
        // clues: Alice sits in the middle (s2); Bob is left of Carol
        cluesHold: (q) => {
          const seatIdx = (person: string): number => {
            const seatGid = q.get("seatOf", person); // gid+1, 0 if unseated
            if (seatGid === 0) return 0;
            return q.get("idx", q.name(seatGid - 1));
          };
          return seatIdx("alice") === 2 && seatIdx("bob") < seatIdx("carol");
        },
      },
    },
  );
  const result = planOnce(model, model.createExecState(), {
    goals: [goal(F.and(...people.map((p) => F.cmp("!=", N.fl("seatOf", p), 0)), F.ext("cluesHold", [], ["seatOf"])))],
    weight: 1,
  });
  assert.equal(result.status, "success");
  const seatName = (p: string): string => {
    const { end } = simulatePlan(model, model.createExecState(), result.plan!);
    const gid = end.get(model.slotOf("seatOf", model.entityId(p)));
    return model.entityName(gid - 1);
  };
  assert.equal(seatName("alice"), "s2", "Alice in the middle");
  assert.equal(seatName("bob"), "s1", "Bob left of Carol → Bob at s1");
  assert.equal(seatName("carol"), "s3");
});

// ---------------------------------------------------------------- crossword (intersecting slots)

test("crossword: fill two intersecting slots from a word list with letter agreement", () => {
  // 'across' and 'down' share their first cell → first letters must match
  const words = ["cat", "cot", "dog", "car", "art", "ace"];
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  const doc: DomainDoc = {
    name: "crossword",
    types: [{ name: "slot" }, { name: "word" }],
    fluents: [
      { name: "fill", params: [{ name: "s", type: "slot" }], kind: "entity", entityType: "word" },
      { name: "used", params: [{ name: "w", type: "word" }], kind: "boolean" },
      // first letter of each word, as an enum, precomputed
      { name: "firstLetter", params: [{ name: "w", type: "word" }], kind: "enum", values: letters },
    ],
    operators: [
      {
        name: "place",
        params: [
          { name: "s", type: "slot" },
          { name: "w", type: "word" },
        ],
        pre: F.and(
          F.cmp("==", N.fl("fill", "?s"), 0),
          F.not(F.lit("used", ["?w"])),
          F.ext("firstUnfilled", ["?s"], ["fill"]),
          F.ext("consistent", ["?s", "?w"], ["fill", "firstLetter"]),
        ),
        eff: [E.set("fill", ["?s"], "?w"), E.set("used", ["?w"], true)],
      },
    ],
  };
  const slotOrder = ["across", "down"];
  const model = createModel(
    doc,
    {
      entities: { across: "slot", down: "slot", ...Object.fromEntries(words.map((w) => [w, "word"])) },
      init: (w) => {
        for (const word of words) w.set("firstLetter", [word], word[0]);
      },
    },
    {
      predicates: {
        firstUnfilled: (q) => {
          const s = q.name(q.args[0]);
          if (q.get("fill", s) !== 0) return false;
          for (const earlier of slotOrder) {
            if (earlier === s) break;
            if (q.get("fill", earlier) === 0) return false;
          }
          return true;
        },
        // the two slots intersect at their first letter → first letters must agree
        consistent: (q) => {
          const s = q.name(q.args[0]);
          const w = q.name(q.args[1]);
          const other = s === "across" ? "down" : "across";
          const otherWordGid = q.get("fill", other);
          if (otherWordGid === 0) return true; // other slot not yet filled
          const otherWord = q.name(otherWordGid - 1);
          return q.get("firstLetter", w) === q.get("firstLetter", otherWord);
        },
      },
    },
  );
  const result = planOnce(model, model.createExecState(), {
    goals: [goal(F.and(F.cmp("!=", N.fl("fill", "across"), 0), F.cmp("!=", N.fl("fill", "down"), 0)))],
    weight: 1,
  });
  assert.equal(result.status, "success");
  const { end } = simulatePlan(model, model.createExecState(), result.plan!);
  const wordIn = (slot: string): string => model.entityName(end.get(model.slotOf("fill", model.entityId(slot))) - 1);
  const across = wordIn("across");
  const down = wordIn("down");
  assert.not.equal(across, down, "distinct words");
  assert.equal(across[0], down[0], "shared first cell → matching first letter");
});

test.run();
