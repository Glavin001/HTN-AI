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

interface RecipeState extends WorldStateBase {
  pantry: Record<string, boolean>;
  prep: Record<string, boolean>;
  assembled: boolean;
  plated: boolean;
  notes: string[];
}

type RecipeContext = Context<RecipeState>;

function appendNote(context: RecipeContext, message: string): void {
  context.setState("notes", [...context.getState("notes"), message], false);
}

function createRecipeDomain(): DomainBuilder<RecipeContext> {
  const builder = new DomainBuilder<RecipeContext>("Recipe assembly");

  builder
    .sequence("Prepare sandwich")
      .action("Prep ingredients")
        .condition("Bread available", (ctx) => ctx.getState("pantry").bread)
        .condition("Protein available", (ctx) => ctx.getState("pantry").tempeh)
        .condition("Veggies washed", (ctx) => ctx.getState("pantry").greens)
        .do((ctx) => {
          const prep = { ...ctx.getState("prep"), breadToasted: true, tempehSeared: true, sauceMixed: true };
          ctx.setState("prep", prep, false);
          appendNote(ctx, "Toasted bread and seared tempeh");
          return TaskStatus.Success;
        })
      .end()
      .action("Assemble sandwich")
        .do((ctx) => {
          const prep = ctx.getState("prep");
          if (!prep.breadToasted || !prep.tempehSeared || !prep.sauceMixed) {
            throw new Error("Attempted to assemble without prep");
          }
          ctx.setState("assembled", true, false);
          appendNote(ctx, "Layered components with sauce");
          return TaskStatus.Success;
        })
      .end()
      .action("Plate and finish")
        .do((ctx) => {
          if (!ctx.getState("assembled")) {
            throw new Error("Cannot plate before assembly");
          }
          ctx.setState("plated", true, false);
          appendNote(ctx, "Garnished with greens");
          return TaskStatus.Success;
        })
      .end()
    .end();

  return builder;
}

function createRecipeContext(overrides: Partial<RecipeState> = {}): RecipeContext {
  return createPuzzleContext<RecipeState>({
    pantry: {
      bread: true,
      tempeh: true,
      greens: true,
    },
    prep: {
      breadToasted: false,
      tempehSeared: false,
      sauceMixed: false,
    },
    assembled: false,
    plated: false,
    notes: [],
    ...overrides,
  });
}

test("Recipe assembly prepares, assembles, and plates sandwich", () => {
  const domain = buildDomain(createRecipeDomain());
  const context = createRecipeContext();

  const plan = ensurePlan(domain, context);
  assert.equal(planNames(plan), ["Prep ingredients", "Assemble sandwich", "Plate and finish"]);

  executePlan(plan, context);

  assert.ok(context.getState("prep").breadToasted);
  assert.ok(context.getState("assembled"));
  assert.ok(context.getState("plated"));
  assert.is(context.getState("notes").length, 3);
});

test("Recipe assembly planning fails without protein", () => {
  const domain = buildDomain(createRecipeDomain());
  const context = createRecipeContext({ pantry: { bread: true, tempeh: false, greens: true } });

  ensureNoPlan(domain, context);
});

test("Recipe assembly refuses to plate unfinished sandwich", () => {
  const domain = buildDomain(createRecipeDomain());
  const context = createRecipeContext();

  const plan = ensurePlan(domain, context);
  const [, assemble] = plan;
  context.setState("prep", { breadToasted: false, tempehSeared: false, sauceMixed: false }, false);
  assert.throws(() => assemble.operator?.(context));
});

test.run();
