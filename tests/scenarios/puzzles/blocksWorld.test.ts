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

interface BlocksWorldState extends WorldStateBase {
  stacks: Record<string, string[]>;
  table: string[];
  tableCapacity: number;
  goalTower: string[];
  goalStackId: string;
}

type BlocksWorldContext = Context<BlocksWorldState>;

function cloneStacks(state: BlocksWorldState): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(state.stacks).map(([key, stack]) => [key, [...stack]]),
  );
}

function findBlock(state: BlocksWorldState, block: string): { stackId: string | null; index: number } {
  for (const [stackId, stack] of Object.entries(state.stacks)) {
    const index = stack.indexOf(block);
    if (index !== -1) {
      return { stackId, index };
    }
  }

  const tableIndex = state.table.indexOf(block);
  if (tableIndex !== -1) {
    return { stackId: null, index: tableIndex };
  }

  throw new Error(`Block ${block} not found in world state`);
}

function blocksAbove(state: BlocksWorldState, block: string): number {
  const location = findBlock(state, block);
  if (!location.stackId) {
    return 0;
  }

  const stack = state.stacks[location.stackId];
  return stack.length - location.index - 1;
}

function ensureTableCapacity(state: BlocksWorldState, requiredSpace: number): void {
  if (state.table.length + requiredSpace > state.tableCapacity) {
    throw new Error("Insufficient table capacity to clear blocks");
  }
}

function exposeBaseBlock(context: BlocksWorldContext): void {
  const world = context.WorldState;
  const base = world.goalTower[0];
  const location = findBlock(world, base);
  if (!location.stackId) {
    return;
  }

  const stack = world.stacks[location.stackId];
  ensureTableCapacity(world, stack.length - location.index - 1);

  while (stack[stack.length - 1] !== base) {
    const removed = stack.pop();
    if (!removed) {
      break;
    }
    world.table.push(removed);
  }

  context.setState("stacks", cloneStacks(world), false);
  context.setState("table", [...world.table], false);
}

function moveBaseToGoalStack(context: BlocksWorldContext): void {
  const world = context.WorldState;
  const base = world.goalTower[0];
  const { stackId, index } = findBlock(world, base);

  if (stackId === world.goalStackId) {
    return;
  }

  if (stackId === null) {
    // Pull from table
    world.table.splice(index, 1);
  } else {
    const stack = world.stacks[stackId];
    if (stack.length !== 1) {
      throw new Error(`Base block ${base} still has blocks above it`);
    }
    delete world.stacks[stackId];
  }

  world.stacks[world.goalStackId] = [base];

  context.setState("stacks", cloneStacks(world), false);
  context.setState("table", [...world.table], false);
}

function stackRemainingBlocks(context: BlocksWorldContext): void {
  const world = context.WorldState;
  const stack = world.stacks[world.goalStackId];
  if (!stack || stack.length === 0) {
    throw new Error("Goal stack not prepared");
  }

  for (let i = 1; i < world.goalTower.length; i++) {
    const block = world.goalTower[i];
    const location = findBlock(world, block);

    if (location.stackId !== null) {
      const sourceStack = world.stacks[location.stackId];
      if (sourceStack.length - 1 !== location.index) {
        throw new Error(`Block ${block} is not clear to move`);
      }
      sourceStack.pop();
      if (sourceStack.length === 0) {
        delete world.stacks[location.stackId];
      }
    } else {
      world.table.splice(location.index, 1);
    }

    stack.push(block);
  }

  context.setState("stacks", cloneStacks(world), false);
  context.setState("table", [...world.table], false);
}

function createBlocksWorldDomain(): DomainBuilder<BlocksWorldContext> {
  const builder = new DomainBuilder<BlocksWorldContext>("Blocks world");

  builder
    .sequence("Assemble goal tower")
      .action("Expose goal base")
        .condition("Have capacity to clear base", (ctx) => {
          const world = ctx.WorldState;
          const required = blocksAbove(world, world.goalTower[0]);
          return world.table.length + required <= world.tableCapacity;
        })
        .do((ctx) => {
          exposeBaseBlock(ctx);
          return TaskStatus.Success;
        })
      .end()
      .action("Move base to goal stack")
        .do((ctx) => {
          moveBaseToGoalStack(ctx);
          return TaskStatus.Success;
        })
      .end()
      .action("Stack remaining blocks")
        .do((ctx) => {
          stackRemainingBlocks(ctx);
          return TaskStatus.Success;
        })
      .end()
    .end();

  return builder;
}

function createBlocksWorldContext(overrides: Partial<BlocksWorldState> = {}): BlocksWorldContext {
  return createPuzzleContext<BlocksWorldState>({
    stacks: {
      start: ["C", "A"],
      spare: ["B"],
    },
    table: [],
    tableCapacity: 2,
    goalTower: ["C", "B", "A"],
    goalStackId: "goal",
    ...overrides,
  });
}

test("Blocks world clears stacked blockers before assembling tower", () => {
  const domain = buildDomain(createBlocksWorldDomain());
  const context = createBlocksWorldContext();

  const plan = ensurePlan(domain, context);
  assert.equal(planNames(plan), [
    "Expose goal base",
    "Move base to goal stack",
    "Stack remaining blocks",
  ]);

  executePlan(plan, context);

  assert.equal(context.getState("stacks").goal, ["C", "B", "A"]);
  assert.equal(context.getState("table"), []);
  assert.ok(!context.getState("stacks").start);
});

test("Blocks world handles pre-cleared base without extra moves", () => {
  const domain = buildDomain(createBlocksWorldDomain());
  const context = createBlocksWorldContext({
    stacks: { start: ["C"], spare: [] },
    table: ["B", "A"],
  });

  const plan = ensurePlan(domain, context);

  executePlan(plan, context);

  assert.equal(context.getState("stacks").goal, ["C", "B", "A"]);
  assert.equal(context.getState("table"), []);
});

test("Blocks world planning fails when insufficient table capacity", () => {
  const domain = buildDomain(createBlocksWorldDomain());
  const context = createBlocksWorldContext({ tableCapacity: 0 });

  ensureNoPlan(domain, context);
});

test.run();
