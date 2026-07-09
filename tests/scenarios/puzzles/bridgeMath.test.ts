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

interface BridgeMathState extends WorldStateBase {
  knowns: Record<string, number>;
  variables: Record<string, number | null>;
  steps: string[];
  sanityCheck: number | null;
}

type BridgeMathContext = Context<BridgeMathState>;

function appendStep(context: BridgeMathContext, message: string): void {
  context.setState("steps", [...context.getState("steps"), message], false);
}

function createBridgeMathDomain(): DomainBuilder<BridgeMathContext> {
  const builder = new DomainBuilder<BridgeMathContext>("Bridge word problem");

  builder
    .sequence("Solve bridge span length")
      .action("Extract givens")
        .condition("Total length provided", (ctx) => typeof ctx.getState("knowns").totalLength === "number")
        .condition("Ramp length provided", (ctx) => typeof ctx.getState("knowns").rampLength === "number")
        .condition("Span count provided", (ctx) => ctx.getState("knowns").spanCount > 0)
        .do((ctx) => {
          appendStep(ctx, "Captured givens from problem statement");
          return TaskStatus.Success;
        })
      .end()
      .action("Set up bridge relation")
        .do((ctx) => {
          const { totalLength, rampLength, spanCount } = ctx.getState("knowns");
          const spanTotal = totalLength - rampLength;
          if (spanTotal <= 0) {
            throw new Error("Ramp length exceeds total bridge length");
          }
          ctx.setState("variables", { ...ctx.getState("variables"), spanTotal }, false);
          appendStep(ctx, `Isolated span total: ${spanTotal}`);
          ctx.setState("sanityCheck", spanTotal + rampLength, false);
          return TaskStatus.Success;
        })
      .end()
      .action("Solve for individual span")
        .do((ctx) => {
          const { spanCount } = ctx.getState("knowns");
          const { spanTotal } = ctx.getState("variables");
          if (typeof spanTotal !== "number" || spanCount <= 0) {
            throw new Error("Invalid span configuration");
          }
          const spanLength = spanTotal / spanCount;
          ctx.setState("variables", { ...ctx.getState("variables"), spanLength }, false);
          appendStep(ctx, `Computed span length: ${spanLength}`);
          return TaskStatus.Success;
        })
      .end()
      .action("Validate solution")
        .do((ctx) => {
          const { totalLength } = ctx.getState("knowns");
          const { spanLength, spanTotal } = ctx.getState("variables");
          if (typeof spanLength !== "number" || typeof spanTotal !== "number") {
            throw new Error("Missing calculated values");
          }
          const recomputed = spanLength * ctx.getState("knowns").spanCount + ctx.getState("knowns").rampLength;
          if (Math.abs(recomputed - totalLength) > 1e-6) {
            throw new Error("Solution does not satisfy original equation");
          }
          appendStep(ctx, "Validated result against original equation");
          return TaskStatus.Success;
        })
      .end()
    .end();

  return builder;
}

function createBridgeMathContext(overrides: Partial<BridgeMathState> = {}): BridgeMathContext {
  return createPuzzleContext<BridgeMathState>({
    knowns: {
      totalLength: 96,
      rampLength: 12,
      spanCount: 3,
    },
    variables: {
      spanTotal: null,
      spanLength: null,
    },
    steps: [],
    sanityCheck: null,
    ...overrides,
  });
}

test("Bridge word problem derives span length with back substitution", () => {
  const domain = buildDomain(createBridgeMathDomain());
  const context = createBridgeMathContext();

  const plan = ensurePlan(domain, context);
  assert.equal(planNames(plan), [
    "Extract givens",
    "Set up bridge relation",
    "Solve for individual span",
    "Validate solution",
  ]);

  executePlan(plan, context);

  const variables = context.getState("variables");
  assert.is(variables.spanTotal, 84);
  assert.is(variables.spanLength, 28);
  assert.is(context.getState("sanityCheck"), 84 + 12);
  assert.ok(context.getState("steps").length >= 3);
});

test("Bridge word problem planning fails when givens incomplete", () => {
  const domain = buildDomain(createBridgeMathDomain());
  const context = createBridgeMathContext({
    knowns: {
      totalLength: 96,
      rampLength: 12,
      spanCount: 0,
    },
  });

  ensureNoPlan(domain, context);
});

test.run();
