import { test } from "uvu";
import * as assert from "uvu/assert";
import type Context from "../../../src/context";
import DomainBuilder from "../../../src/domainBuilder";
import TaskStatus from "../../../src/taskStatus";
import type { WorldStateBase } from "../../../src/context";
import {
  buildDomain,
  createPuzzleContext,
  ensureNoPlan,
  ensurePlan,
  executePlan,
  planNames,
} from "./helpers";

interface Slot {
  id: string;
  positions: Array<[number, number]>;
  filled: string | null;
}

interface CrosswordState extends WorldStateBase {
  grid: string[][];
  slots: Slot[];
  words: string[];
  placed: Record<string, string>;
}

type CrosswordContext = Context<CrosswordState>;

function cloneGrid(grid: string[][]): string[][] {
  return grid.map((row) => [...row]);
}

function slotPattern(context: CrosswordContext, slot: Slot): string {
  const letters = slot.positions.map(([row, col]) => context.getState("grid")[row][col]);
  return letters.join("");
}

function compatible(word: string, pattern: string): boolean {
  if (word.length !== pattern.length) {
    return false;
  }
  for (let i = 0; i < word.length; i++) {
    if (pattern[i] !== "_" && pattern[i] !== word[i]) {
      return false;
    }
  }
  return true;
}

function placeWord(context: CrosswordContext, slot: Slot, word: string): void {
  const grid = cloneGrid(context.getState("grid"));
  slot.positions.forEach(([row, col], index) => {
    grid[row][col] = word[index];
  });

  const slots = context.getState("slots").map((existing) => (
    existing.id === slot.id ? { ...existing, filled: word } : existing
  ));

  const remainingWords = context
    .getState("words")
    .filter((candidate) => candidate !== word);

  context.setState("grid", grid, false);
  context.setState("slots", slots, false);
  context.setState("words", remainingWords, false);
  context.setState("placed", { ...context.getState("placed"), [slot.id]: word }, false);
}

function fillLongestSlot(context: CrosswordContext): void {
  const slots = context.getState("slots");
  const unfilled = slots.filter((slot) => !slot.filled);
  if (unfilled.length === 0) {
    return;
  }

  const longest = [...unfilled].sort((a, b) => b.positions.length - a.positions.length)[0];
  const pattern = slotPattern(context, longest);
  const word = context.getState("words").find((candidate) => compatible(candidate, pattern));
  if (!word) {
    throw new Error(`No word fits slot ${longest.id}`);
  }

  placeWord(context, longest, word);
}

function fillRemainingSlots(context: CrosswordContext): void {
  let placed = 0;
  while (context.getState("slots").some((slot) => !slot.filled)) {
    const nextSlot = context.getState("slots").find((slot) => !slot.filled);
    if (!nextSlot) {
      break;
    }
    const pattern = slotPattern(context, nextSlot);
    const word = context.getState("words").find((candidate) => compatible(candidate, pattern));
    if (!word) {
      throw new Error(`Unable to place remaining slot ${nextSlot.id}`);
    }
    placeWord(context, nextSlot, word);
    placed += 1;
    if (placed > 10) {
      throw new Error("Exceeded reasonable placement attempts");
    }
  }
}

function createCrosswordDomain(): DomainBuilder<CrosswordContext> {
  const builder = new DomainBuilder<CrosswordContext>("Crossword fill");

  builder
    .sequence("Fill crossword grid")
      .action("Fill longest slot first")
        .condition("Slots remaining", (ctx) => ctx.getState("slots").some((slot) => !slot.filled))
        .condition("Words available", (ctx) => ctx.getState("words").length > 0)
        .do((ctx) => {
          fillLongestSlot(ctx);
          return TaskStatus.Success;
        })
      .end()
      .action("Propagate remaining slots")
        .do((ctx) => {
          fillRemainingSlots(ctx);
          return TaskStatus.Success;
        })
      .end()
    .end();

  return builder;
}

function createCrosswordContext(overrides: Partial<CrosswordState> = {}): CrosswordContext {
  return createPuzzleContext<CrosswordState>({
    grid: [
      ["_", "_", "_"],
      ["#", "_", "#"],
      ["_", "_", "_"],
    ],
    slots: [
      { id: "Across1", positions: [[0, 0], [0, 1], [0, 2]], filled: null },
      { id: "Down2", positions: [[0, 1], [1, 1], [2, 1]], filled: null },
      { id: "Across3", positions: [[2, 0], [2, 1], [2, 2]], filled: null },
    ],
    words: ["CAR", "ADO", "ROW"],
    placed: {},
    ...overrides,
  });
}

test("Crossword fill places consistent words respecting crossings", () => {
  const domain = buildDomain(createCrosswordDomain());
  const context = createCrosswordContext();

  const plan = ensurePlan(domain, context);
  assert.equal(planNames(plan), ["Fill longest slot first", "Propagate remaining slots"]);

  executePlan(plan, context);

  assert.equal(context.getState("grid"), [
    ["C", "A", "R"],
    ["#", "D", "#"],
    ["R", "O", "W"],
  ]);
  assert.equal(context.getState("placed"), {
    Across1: "CAR",
    Down2: "ADO",
    Across3: "ROW",
  });
});

test("Crossword fill detects incompatible word list", () => {
  const domain = buildDomain(createCrosswordDomain());
  const context = createCrosswordContext({ words: ["DOG", "EEL"] });

  const plan = ensurePlan(domain, context);
  assert.throws(() => executePlan(plan, context));
});

test.run();
