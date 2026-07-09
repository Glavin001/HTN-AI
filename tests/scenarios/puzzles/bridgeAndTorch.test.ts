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

interface Person {
  name: string;
  time: number;
}

type TorchSide = "left" | "right";
type Strategy = "courier" | "pairSlowest";

interface BridgeWorldState extends WorldStateBase {
  left: Person[];
  right: Person[];
  torchSide: TorchSide;
  elapsed: number;
  strategy: Strategy;
}

type BridgeContext = Context<BridgeWorldState>;

function clonePeople(people: Person[]): Person[] {
  return people.map((person) => ({ ...person }));
}

function sortByTime(people: Person[]): Person[] {
  return [...people].sort((a, b) => a.time - b.time);
}

function movePeople(
  context: BridgeContext,
  names: string[],
  from: "left" | "right",
  to: "left" | "right",
): number {
  const world = context.WorldState;
  const source = from === "left" ? world.left : world.right;
  const destination = to === "left" ? world.left : world.right;

  const travelers: Person[] = [];
  for (const name of names) {
    const index = source.findIndex((person) => person.name === name);
    if (index === -1) {
      throw new Error(`Unable to find ${name} on ${from} bank`);
    }
    const [person] = source.splice(index, 1);
    travelers.push(person);
  }

  const duration = Math.max(...travelers.map((person) => person.time));
  destination.push(...travelers);

  context.setState(from, clonePeople(source), false);
  context.setState(to, clonePeople(destination), false);
  context.setState("torchSide", to as TorchSide, false);
  context.setState("elapsed", context.getState("elapsed") + duration, false);

  return duration;
}

function createBridgeAndTorchDomain(): DomainBuilder<BridgeContext> {
  const builder = new DomainBuilder<BridgeContext>("Bridge and torch");

  builder
    .sequence("Cross bridge")
      .condition("Torch is on starting bank", (ctx) => ctx.getState("torchSide") === "left")
      .select("Pick crossing heuristic")
        .sequence("Courier strategy")
          .condition("Using courier strategy", (ctx) => ctx.getState("strategy") === "courier")
          .action("Escort slowest with fastest")
            .condition("At least two travelers", (ctx) => ctx.getState("left").length >= 2)
            .do((ctx) => {
              const sorted = sortByTime(ctx.getState("left"));
              const fastest = sorted[0];
              const slowest = sorted[sorted.length - 1];
              movePeople(ctx, [fastest.name, slowest.name], "left", "right");
              return TaskStatus.Success;
            })
          .end()
          .action("Return fastest with torch")
            .do((ctx) => {
              if (ctx.getState("right").length === 0) {
                throw new Error("No one available to return with torch");
              }
              const fastest = sortByTime(ctx.getState("right"))[0];
              movePeople(ctx, [fastest.name], "right", "left");
              return TaskStatus.Success;
            })
          .end()
        .end()
        .sequence("Pair slowest together")
          .condition("Using slowest pairing", (ctx) => ctx.getState("strategy") === "pairSlowest")
          .action("Send two slowest across")
            .condition("Enough travelers remaining", (ctx) => ctx.getState("left").length >= 2)
            .do((ctx) => {
              const sorted = sortByTime(ctx.getState("left"));
              const slowest = sorted.slice(-2);
              movePeople(ctx, slowest.map((person) => person.name), "left", "right");
              return TaskStatus.Success;
            })
          .end()
          .action("Return guide")
            .do((ctx) => {
              if (ctx.getState("right").length === 0) {
                throw new Error("No traveler can return");
              }
              const fastest = sortByTime(ctx.getState("right"))[0];
              movePeople(ctx, [fastest.name], "right", "left");
              return TaskStatus.Success;
            })
          .end()
        .end()
      .end()
    .end();

  return builder;
}

function createBridgeContext(overrides: Partial<BridgeWorldState> = {}): BridgeContext {
  return createPuzzleContext<BridgeWorldState>({
    left: [
      { name: "Alice", time: 1 },
      { name: "Ben", time: 2 },
      { name: "Cara", time: 5 },
      { name: "Doug", time: 10 },
    ],
    right: [],
    torchSide: "left",
    elapsed: 0,
    strategy: "courier",
    ...overrides,
  });
}

test("Bridge and torch follows courier plan and tracks time", () => {
  const domain = buildDomain(createBridgeAndTorchDomain());
  const context = createBridgeContext();

  const plan = ensurePlan(domain, context);
  assert.equal(planNames(plan), ["Escort slowest with fastest", "Return fastest with torch"]);

  executePlan(plan, context);

  assert.equal(context.getState("left").map((person) => person.name).sort(), ["Alice", "Ben", "Cara"]);
  assert.equal(context.getState("right").map((person) => person.name), ["Doug"]);
  assert.is(context.getState("elapsed"), 11);
  assert.is(context.getState("torchSide"), "left");
});

test("Bridge and torch pairs slowest travelers when configured", () => {
  const domain = buildDomain(createBridgeAndTorchDomain());
  const context = createBridgeContext({ strategy: "pairSlowest" });

  const plan = ensurePlan(domain, context);
  assert.equal(planNames(plan), ["Send two slowest across", "Return guide"]);

  executePlan(plan, context);

  assert.equal(context.getState("right").map((person) => person.name), ["Doug"]);
  assert.equal(context.getState("left").map((person) => person.name).sort(), ["Alice", "Ben", "Cara"]);
  assert.is(context.getState("elapsed"), 15);
  assert.is(context.getState("torchSide"), "left");
});

test("Bridge and torch planning fails without torch on starting bank", () => {
  const domain = buildDomain(createBridgeAndTorchDomain());
  const context = createBridgeContext({ torchSide: "right" });

  ensureNoPlan(domain, context);
});

test.run();
