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

type Grid = number[][];

interface SudokuState extends WorldStateBase {
  grid: Grid;
  size: number;
  boxSize: number;
}

type SudokuContext = Context<SudokuState>;

function cloneGrid(grid: Grid): Grid {
  return grid.map((row) => [...row]);
}

function candidatesForCell(state: SudokuState, row: number, col: number): number[] {
  if (state.grid[row][col] !== 0) {
    return [];
  }

  const possible = new Set<number>(Array.from({ length: state.size }, (_, index) => index + 1));

  for (let i = 0; i < state.size; i++) {
    possible.delete(state.grid[row][i]);
    possible.delete(state.grid[i][col]);
  }

  const boxRow = Math.floor(row / state.boxSize) * state.boxSize;
  const boxCol = Math.floor(col / state.boxSize) * state.boxSize;
  for (let r = 0; r < state.boxSize; r++) {
    for (let c = 0; c < state.boxSize; c++) {
      possible.delete(state.grid[boxRow + r][boxCol + c]);
    }
  }

  return Array.from(possible);
}

function applySingletons(context: SudokuContext): boolean {
  const state = context.WorldState;
  const grid = cloneGrid(state.grid);
  let progress = false;

  for (let row = 0; row < state.size; row++) {
    for (let col = 0; col < state.size; col++) {
      if (grid[row][col] !== 0) {
        continue;
      }
      const options = candidatesForCell(state, row, col);
      if (options.length === 0) {
        throw new Error(`Cell (${row},${col}) has no valid candidates`);
      }
      if (options.length === 1) {
        grid[row][col] = options[0]!;
        progress = true;
      }
    }
  }

  if (progress) {
    context.setState("grid", grid, false);
  }

  return progress;
}

function applyHiddenSingles(context: SudokuContext): boolean {
  const state = context.WorldState;
  const grid = cloneGrid(state.grid);
  let progress = false;

  for (let row = 0; row < state.size; row++) {
    const counts: Record<number, number> = {};
    const positions: Record<number, [number, number]> = {};
    for (let col = 0; col < state.size; col++) {
      if (grid[row][col] !== 0) {
        continue;
      }
      for (const candidate of candidatesForCell(state, row, col)) {
        counts[candidate] = (counts[candidate] ?? 0) + 1;
        positions[candidate] = [row, col];
      }
    }
    for (const [value, count] of Object.entries(counts)) {
      if (count === 1) {
        const [r, c] = positions[Number(value)]!;
        grid[r][c] = Number(value);
        progress = true;
      }
    }
  }

  if (progress) {
    context.setState("grid", grid, false);
  }

  return progress;
}

function isSolved(grid: Grid): boolean {
  return grid.every((row) => row.every((value) => value !== 0));
}

function createSudokuDomain(): DomainBuilder<SudokuContext> {
  const builder = new DomainBuilder<SudokuContext>("Sudoku tactics");

  builder
    .sequence("Solve 4x4 sudoku")
      .condition("Puzzle incomplete", (ctx) => !isSolved(ctx.getState("grid")))
      .action("Apply naked singles")
        .do((ctx) => {
          while (applySingletons(ctx)) {
            // keep applying until no progress
          }
          return TaskStatus.Success;
        })
      .end()
      .action("Apply hidden singles")
        .do((ctx) => {
          let progress = true;
          while (progress) {
            progress = applyHiddenSingles(ctx);
            if (applySingletons(ctx)) {
              progress = true;
            }
          }
          return TaskStatus.Success;
        })
      .end()
      .action("Validate completed grid")
        .do((ctx) => {
          if (!isSolved(ctx.getState("grid"))) {
            throw new Error("Puzzle not solved after tactics");
          }
          return TaskStatus.Success;
        })
      .end()
    .end();

  return builder;
}

function createSudokuContext(overrides: Partial<SudokuState> = {}): SudokuContext {
  return createPuzzleContext<SudokuState>({
    grid: [
      [0, 0, 2, 0],
      [0, 3, 0, 1],
      [1, 0, 0, 0],
      [0, 4, 0, 2],
    ],
    size: 4,
    boxSize: 2,
    ...overrides,
  });
}

test("Sudoku tactics solve a simple 4x4 puzzle", () => {
  const domain = buildDomain(createSudokuDomain());
  const context = createSudokuContext();

  const plan = ensurePlan(domain, context);
  assert.equal(planNames(plan), ["Apply naked singles", "Apply hidden singles", "Validate completed grid"]);

  executePlan(plan, context);

  assert.equal(context.getState("grid"), [
    [4, 1, 2, 3],
    [2, 3, 4, 1],
    [1, 2, 3, 4],
    [3, 4, 1, 2],
  ]);
});

test("Sudoku planning fails when puzzle already solved", () => {
  const domain = buildDomain(createSudokuDomain());
  const context = createSudokuContext({
    grid: [
      [4, 1, 2, 3],
      [2, 3, 4, 1],
      [1, 2, 3, 4],
      [3, 4, 1, 2],
    ],
  });

  ensureNoPlan(domain, context);
});

test("Sudoku execution catches inconsistent puzzle", () => {
  const domain = buildDomain(createSudokuDomain());
  const context = createSudokuContext({
    grid: [
      [1, 2, 0, 3],
      [3, 4, 1, 2],
      [2, 1, 4, 0],
      [4, 3, 2, 1],
    ],
  });

  const plan = ensurePlan(domain, context);
  assert.throws(() => executePlan(plan, context));
});

test.run();
