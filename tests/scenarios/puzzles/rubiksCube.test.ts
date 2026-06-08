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

interface RubikState extends WorldStateBase {
  stages: Record<string, boolean>;
  turnLog: string[];
  parity: "even" | "odd";
}

type RubikContext = Context<RubikState>;

function appendTurn(context: RubikContext, algorithm: string): void {
  context.setState("turnLog", [...context.getState("turnLog"), algorithm], false);
}

function createRubikDomain(): DomainBuilder<RubikContext> {
  const builder = new DomainBuilder<RubikContext>("Rubik CFOP");

  builder
    .sequence("Solve cube with CFOP")
      .action("Build cross")
        .condition("Cross unsolved", (ctx) => !ctx.getState("stages").cross)
        .do((ctx) => {
          ctx.setState("stages", { ...ctx.getState("stages"), cross: true }, false);
          appendTurn(ctx, "F R U R' U' F'");
          return TaskStatus.Success;
        })
      .end()
      .action("Complete F2L")
        .do((ctx) => {
          if (!ctx.getState("stages").cross) {
            throw new Error("Cannot solve F2L before cross");
          }
          if (!ctx.getState("stages").f2l) {
            ctx.setState("stages", { ...ctx.getState("stages"), f2l: true }, false);
            appendTurn(ctx, "(U R U' R') (U' F' U F)");
          }
          return TaskStatus.Success;
        })
      .end()
      .action("Orient last layer")
        .do((ctx) => {
          if (!ctx.getState("stages").f2l) {
            throw new Error("Cannot run OLL before finishing F2L");
          }
          if (ctx.getState("parity") === "odd") {
            throw new Error("Cannot orient odd-parity cube without setup");
          }
          if (!ctx.getState("stages").oll) {
            ctx.setState("stages", { ...ctx.getState("stages"), oll: true }, false);
            appendTurn(ctx, "R U2 R' U' R U' R'");
          }
          return TaskStatus.Success;
        })
      .end()
      .action("Permute last layer")
        .do((ctx) => {
          if (!ctx.getState("stages").oll) {
            throw new Error("Cannot run PLL before OLL");
          }
          if (!ctx.getState("stages").pll) {
            ctx.setState("stages", { ...ctx.getState("stages"), pll: true }, false);
            appendTurn(ctx, "(R' U R' U') R' U R D' R' U' R D");
          }
          return TaskStatus.Success;
        })
      .end()
    .end();

  return builder;
}

function createRubikContext(overrides: Partial<RubikState> = {}): RubikContext {
  return createPuzzleContext<RubikState>({
    stages: {
      cross: false,
      f2l: false,
      oll: false,
      pll: false,
    },
    turnLog: [],
    parity: "even",
    ...overrides,
  });
}

test("Rubik CFOP plan solves each stage in order", () => {
  const domain = buildDomain(createRubikDomain());
  const context = createRubikContext();

  const plan = ensurePlan(domain, context);
  assert.equal(planNames(plan), [
    "Build cross",
    "Complete F2L",
    "Orient last layer",
    "Permute last layer",
  ]);

  executePlan(plan, context);

  assert.equal(context.getState("stages"), { cross: true, f2l: true, oll: true, pll: true });
  assert.is(context.getState("turnLog").length, 4);
});

test("Rubik CFOP refuses to run OLL on odd parity state", () => {
  const domain = buildDomain(createRubikDomain());
  const context = createRubikContext({ parity: "odd" });

  const plan = ensurePlan(domain, context);
  assert.throws(() => executePlan(plan, context));
});

test("Rubik CFOP planning fails if cross already solved without log", () => {
  const domain = buildDomain(createRubikDomain());
  const context = createRubikContext({ stages: { cross: true, f2l: false, oll: false, pll: false } });

  ensureNoPlan(domain, context);
});

test.run();
