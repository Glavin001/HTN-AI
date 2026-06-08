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

type Peg = "A" | "B" | "C";

interface TowerWorldState extends WorldStateBase {
  pegs: Record<Peg, number[]>;
  moveLog: Array<{ from: Peg; to: Peg; disk: number }>;
}

type TowerContext = Context<TowerWorldState>;

function clonePegState(state: TowerWorldState): TowerWorldState["pegs"] {
  return {
    A: [...state.pegs.A],
    B: [...state.pegs.B],
    C: [...state.pegs.C],
  };
}

function moveDisk(
  context: TowerContext,
  from: Peg,
  to: Peg,
): void {
  const { pegs, moveLog } = context.WorldState;
  const source = pegs[from];
  if (source.length === 0) {
    throw new Error(`No disk available on peg ${from}`);
  }

  const disk = source[source.length - 1];
  const destination = pegs[to];
  const destinationTop = destination[destination.length - 1] ?? Infinity;

  if (disk > destinationTop) {
    throw new Error(`Illegal move: cannot place disk ${disk} on top of ${destinationTop}`);
  }

  source.pop();
  destination.push(disk);

  context.setState("pegs", clonePegState(context.WorldState), false);
  context.setState("moveLog", [...moveLog, { from, to, disk }], false);
}

function moveStack(
  context: TowerContext,
  n: number,
  from: Peg,
  to: Peg,
  via: Peg,
): void {
  if (n <= 0) {
    return;
  }

  if (n === 1) {
    moveDisk(context, from, to);
    return;
  }

  moveStack(context, n - 1, from, via, to);
  moveDisk(context, from, to);
  moveStack(context, n - 1, via, to, from);
}

function createTowerOfHanoiDomain(): Domain<TowerContext> {
  const builder = new DomainBuilder<TowerContext>("Tower of Hanoi");

  builder
    .sequence("Solve tower")
      .select("Choose approach")
        .sequence("Single disk move")
          .condition("Exactly one disk", (ctx) => ctx.getState("pegs").A.length === 1)
          .action("Move single disk")
            .do((ctx) => {
              moveDisk(ctx, "A", "C");
              return TaskStatus.Success;
            })
          .end()
        .end()
        .sequence("Recursive solution")
          .condition("Multiple disks", (ctx) => ctx.getState("pegs").A.length > 1)
          .condition("Auxiliary clear", (ctx) => ctx.getState("pegs").B.length === 0)
          .action("Move top stack to auxiliary")
            .do((ctx) => {
              const count = ctx.getState("pegs").A.length - 1;
              moveStack(ctx, count, "A", "B", "C");
              return TaskStatus.Success;
            })
          .end()
          .action("Move base disk to target")
            .do((ctx) => {
              moveDisk(ctx, "A", "C");
              return TaskStatus.Success;
            })
          .end()
          .action("Move stack from auxiliary")
            .do((ctx) => {
              const count = ctx.getState("pegs").B.length;
              moveStack(ctx, count, "B", "C", "A");
              return TaskStatus.Success;
            })
          .end()
        .end()
      .end()
    .end();

  return buildDomain(builder);
}

function createTowerContext(pegs: Record<Peg, number[]>): TowerContext {
  return createPuzzleContext<TowerWorldState>({
    pegs,
    moveLog: [],
  });
}

function goalStack(count: number): number[] {
  return Array.from({ length: count }, (_, index) => count - index);
}

test("Tower of Hanoi moves a single disk to the target peg", () => {
  const domain = createTowerOfHanoiDomain();
  const context = createTowerContext({ A: [1], B: [], C: [] });

  const plan = ensurePlan(domain, context);
  assert.equal(planNames(plan), ["Move single disk"]);

  executePlan(plan, context);

  assert.equal(context.getState("pegs"), { A: [], B: [], C: [1] });
  assert.equal(context.getState("moveLog"), [{ from: "A", to: "C", disk: 1 }]);
});

test("Tower of Hanoi performs recursive transfer for a three-disk stack", () => {
  const domain = createTowerOfHanoiDomain();
  const context = createTowerContext({ A: [3, 2, 1], B: [], C: [] });

  const plan = ensurePlan(domain, context);
  assert.equal(planNames(plan), [
    "Move top stack to auxiliary",
    "Move base disk to target",
    "Move stack from auxiliary",
  ]);

  executePlan(plan, context);

  assert.equal(context.getState("pegs"), { A: [], B: [], C: goalStack(3) });
  assert.is(context.getState("moveLog").length, 7);
  assert.equal(context.getState("moveLog")[0], { from: "A", to: "C", disk: 1 });
  assert.equal(context.getState("moveLog")[6], { from: "A", to: "C", disk: 1 });
});

test("Tower of Hanoi rejects plan when auxiliary peg occupied", () => {
  const domain = createTowerOfHanoiDomain();
  const context = createTowerContext({ A: [3, 2, 1], B: [4], C: [] });

  ensureNoPlan(domain, context);
});

test.run();
