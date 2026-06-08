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

type Bank = "left" | "right";

interface RiverState extends WorldStateBase {
  left: string[];
  right: string[];
  boatSide: Bank;
  history: string[];
}

type RiverContext = Context<RiverState>;

const FARMER = "Farmer";
const WOLF = "Wolf";
const GOAT = "Goat";
const CABBAGE = "Cabbage";

function isSafe(bank: string[]): boolean {
  const hasFarmer = bank.includes(FARMER);
  if (hasFarmer) {
    return true;
  }
  const goatWithWolf = bank.includes(GOAT) && bank.includes(WOLF);
  const goatWithCabbage = bank.includes(GOAT) && bank.includes(CABBAGE);
  return !goatWithWolf && !goatWithCabbage;
}

function validateSafety(state: RiverState): void {
  if (!isSafe(state.left) || !isSafe(state.right)) {
    throw new Error("Unsafe pairing detected");
  }
}

function movePassengers(context: RiverContext, passengers: string[]): void {
  const fromBank = context.getState("boatSide");
  const toBank: Bank = fromBank === "left" ? "right" : "left";
  const fromList = fromBank === "left" ? context.getState("left") : context.getState("right");
  const toList = toBank === "left" ? context.getState("left") : context.getState("right");

  if (!passengers.includes(FARMER)) {
    throw new Error("Boat must include the farmer");
  }

  const missingPassenger = passengers.find((occupant) => !fromList.includes(occupant));
  if (missingPassenger) {
    throw new Error(`${missingPassenger} is not on the ${fromBank} bank`);
  }

  const updatedFrom = fromList.filter((occupant) => !passengers.includes(occupant));
  const updatedTo = [...toList, ...passengers];

  const nextState: RiverState = {
    ...context.WorldState,
    left: fromBank === "left" ? updatedFrom : updatedTo,
    right: fromBank === "right" ? updatedFrom : updatedTo,
    boatSide: toBank,
  };

  validateSafety(nextState);

  context.setState("left", nextState.left, false);
  context.setState("right", nextState.right, false);
  context.setState("boatSide", nextState.boatSide, false);
  context.setState("history", [...context.getState("history"), `${passengers.join(" & ")} -> ${toBank}`], false);
}

function createRiverDomain(): DomainBuilder<RiverContext> {
  const builder = new DomainBuilder<RiverContext>("River crossing");

  builder
    .sequence("Solve crossing")
      .action("Take goat across")
        .condition("Boat on left", (ctx) => ctx.getState("boatSide") === "left")
        .condition("Goat present", (ctx) => ctx.getState("left").includes(GOAT))
        .do((ctx) => {
          movePassengers(ctx, [FARMER, GOAT]);
          return TaskStatus.Success;
        })
      .end()
      .action("Return farmer alone")
        .do((ctx) => {
          movePassengers(ctx, [FARMER]);
          return TaskStatus.Success;
        })
      .end()
      .action("Take wolf across")
        .condition("Wolf present", (ctx) => ctx.getState("left").includes(WOLF))
        .do((ctx) => {
          movePassengers(ctx, [FARMER, WOLF]);
          return TaskStatus.Success;
        })
      .end()
      .action("Return goat")
        .do((ctx) => {
          movePassengers(ctx, [FARMER, GOAT]);
          return TaskStatus.Success;
        })
      .end()
      .action("Take cabbage across")
        .condition("Cabbage present", (ctx) => ctx.getState("left").includes(CABBAGE))
        .do((ctx) => {
          movePassengers(ctx, [FARMER, CABBAGE]);
          return TaskStatus.Success;
        })
      .end()
      .action("Return farmer again")
        .do((ctx) => {
          movePassengers(ctx, [FARMER]);
          return TaskStatus.Success;
        })
      .end()
      .action("Take goat final time")
        .condition("Goat waiting", (ctx) => ctx.getState("left").includes(GOAT))
        .do((ctx) => {
          movePassengers(ctx, [FARMER, GOAT]);
          return TaskStatus.Success;
        })
      .end()
    .end();

  return builder;
}

function createRiverContext(overrides: Partial<RiverState> = {}): RiverContext {
  return createPuzzleContext<RiverState>({
    left: [FARMER, WOLF, GOAT, CABBAGE],
    right: [],
    boatSide: "left",
    history: [],
    ...overrides,
  });
}

function everyoneOnRight(state: RiverState): boolean {
  return [FARMER, WOLF, GOAT, CABBAGE].every((actor) => state.right.includes(actor));
}

test("River crossing executes canonical solution safely", () => {
  const domain = buildDomain(createRiverDomain());
  const context = createRiverContext();

  const plan = ensurePlan(domain, context);
  assert.equal(planNames(plan), [
    "Take goat across",
    "Return farmer alone",
    "Take wolf across",
    "Return goat",
    "Take cabbage across",
    "Return farmer again",
    "Take goat final time",
  ]);

  executePlan(plan, context);

  assert.ok(everyoneOnRight(context.WorldState));
  assert.is(context.getState("history").length, 7);
});

test("River crossing planning fails if goat missing", () => {
  const domain = buildDomain(createRiverDomain());
  const context = createRiverContext({ left: [FARMER, WOLF, CABBAGE] });

  ensureNoPlan(domain, context);
});

test("River crossing aborts when unsafe pairing would occur", () => {
  const domain = buildDomain(createRiverDomain());
  const context = createRiverContext();

  const plan = ensurePlan(domain, context);
  const [takeGoat] = plan;
  if (!takeGoat.operator) {
    throw new Error("Expected primitive operator");
  }
  context.setState("left", [FARMER, WOLF, CABBAGE], false);
  context.setState("right", [GOAT], false);
  const operator = takeGoat.operator;
  assert.throws(() => operator(context));
});

test.run();
