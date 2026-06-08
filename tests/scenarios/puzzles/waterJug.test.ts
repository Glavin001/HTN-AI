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

interface Jug {
  capacity: number;
  amount: number;
}

interface JugState extends WorldStateBase {
  jugs: Record<string, Jug>;
  target: number;
  history: string[];
}

type JugContext = Context<JugState>;

function fillJug(jug: Jug): Jug {
  return { ...jug, amount: jug.capacity };
}

function emptyJug(jug: Jug): Jug {
  return { ...jug, amount: 0 };
}

function pour(source: Jug, dest: Jug): { source: Jug; dest: Jug } {
  const availableSpace = dest.capacity - dest.amount;
  const transfer = Math.min(source.amount, availableSpace);
  return {
    source: { ...source, amount: source.amount - transfer },
    dest: { ...dest, amount: dest.amount + transfer },
  };
}

function runJugAlgorithm(context: JugContext): void {
  let { A, B } = context.getState("jugs");
  const history = [...context.getState("history")];
  const target = context.getState("target");

  let iterations = 0;
  while (A.amount !== target && B.amount !== target) {
    if (A.amount === 0) {
      A = fillJug(A);
      history.push("Fill jug A");
    } else if (B.amount === B.capacity) {
      B = emptyJug(B);
      history.push("Empty jug B");
    } else {
      const poured = pour(A, B);
      A = poured.source;
      B = poured.dest;
      history.push(`Pour A->B (A=${A.amount}, B=${B.amount})`);
    }

    iterations += 1;
    if (iterations > 30) {
      throw new Error("Exceeded pour iterations");
    }
  }

  context.setState("jugs", { A, B }, false);
  context.setState("history", history, false);
}

function createWaterJugDomain(): DomainBuilder<JugContext> {
  const builder = new DomainBuilder<JugContext>("Water jug");

  builder
    .sequence("Reach target volume")
      .action("Execute pour sequence")
        .condition("Target unmet", (ctx) => {
          const { A, B } = ctx.getState("jugs");
          return A.amount !== ctx.getState("target") && B.amount !== ctx.getState("target");
        })
        .do((ctx) => {
          runJugAlgorithm(ctx);
          return TaskStatus.Success;
        })
      .end()
      .action("Confirm measurement")
        .do((ctx) => {
          const { A, B } = ctx.getState("jugs");
          if (A.amount !== ctx.getState("target") && B.amount !== ctx.getState("target")) {
            throw new Error("Target volume not reached");
          }
          return TaskStatus.Success;
        })
      .end()
    .end();

  return builder;
}

function createWaterJugContext(overrides: Partial<JugState> = {}): JugContext {
  return createPuzzleContext<JugState>({
    jugs: {
      A: { capacity: 3, amount: 0 },
      B: { capacity: 5, amount: 0 },
    },
    target: 4,
    history: [],
    ...overrides,
  });
}

test("Water jug sequence measures the target volume", () => {
  const domain = buildDomain(createWaterJugDomain());
  const context = createWaterJugContext();

  const plan = ensurePlan(domain, context);
  assert.equal(planNames(plan), ["Execute pour sequence", "Confirm measurement"]);

  executePlan(plan, context);

  const { A, B } = context.getState("jugs");
  assert.ok(A.amount === 4 || B.amount === 4);
  assert.ok(context.getState("history").length > 0);
});

test("Water jug planning fails when target already present", () => {
  const domain = buildDomain(createWaterJugDomain());
  const context = createWaterJugContext({ jugs: { A: { capacity: 3, amount: 0 }, B: { capacity: 5, amount: 4 } } });

  ensureNoPlan(domain, context);
});

test("Water jug execution detects impossible target", () => {
  const domain = buildDomain(createWaterJugDomain());
  const context = createWaterJugContext({
    jugs: { A: { capacity: 2, amount: 0 }, B: { capacity: 4, amount: 0 } },
    target: 3,
  });

  const plan = ensurePlan(domain, context);
  assert.throws(() => executePlan(plan, context));
});

test.run();

