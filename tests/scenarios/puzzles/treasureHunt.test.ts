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

interface TreasureState extends WorldStateBase {
  location: string;
  keys: string[];
  unlocked: string[];
  treasureCollected: boolean;
  route: string[];
}

type TreasureContext = Context<TreasureState>;

const FOREST_KEY = "ForestKey";
const GATE = "AncientGate";
const VAULT = "TreasureVault";

function moveTo(context: TreasureContext, location: string): void {
  context.setState("location", location, false);
  context.setState("route", [...context.getState("route"), location], false);
}

function createTreasureDomain(): DomainBuilder<TreasureContext> {
  const builder = new DomainBuilder<TreasureContext>("Treasure hunt");

  builder
    .sequence("Recover vault treasure")
      .action("Retrieve forest key")
        .condition("Starting in village", (ctx) => ctx.getState("location") === "Village")
        .do((ctx) => {
          moveTo(ctx, "Forest");
          ctx.setState("keys", [...ctx.getState("keys"), FOREST_KEY], false);
          return TaskStatus.Success;
        })
      .end()
      .action("Unlock gate")
        .do((ctx) => {
          if (!ctx.getState("keys").includes(FOREST_KEY)) {
            throw new Error("Missing required key");
          }
          moveTo(ctx, GATE);
          ctx.setState("unlocked", [...ctx.getState("unlocked"), GATE], false);
          return TaskStatus.Success;
        })
      .end()
      .action("Collect treasure")
        .do((ctx) => {
          if (!ctx.getState("unlocked").includes(GATE)) {
            throw new Error("Gate remains locked");
          }
          moveTo(ctx, VAULT);
          ctx.setState("treasureCollected", true, false);
          return TaskStatus.Success;
        })
      .end()
    .end();

  return builder;
}

function createTreasureContext(overrides: Partial<TreasureState> = {}): TreasureContext {
  return createPuzzleContext<TreasureState>({
    location: "Village",
    keys: [],
    unlocked: [],
    treasureCollected: false,
    route: ["Village"],
    ...overrides,
  });
}

test("Treasure hunt navigates key-door sequence", () => {
  const domain = buildDomain(createTreasureDomain());
  const context = createTreasureContext();

  const plan = ensurePlan(domain, context);
  assert.equal(planNames(plan), ["Retrieve forest key", "Unlock gate", "Collect treasure"]);

  executePlan(plan, context);

  assert.ok(context.getState("treasureCollected"));
  assert.equal(context.getState("route"), ["Village", "Forest", GATE, VAULT]);
});

test("Treasure hunt planning fails when starting away from key", () => {
  const domain = buildDomain(createTreasureDomain());
  const context = createTreasureContext({ location: "Cave", route: ["Cave"] });

  ensureNoPlan(domain, context);
});

test("Treasure hunt execution detects locked vault", () => {
  const domain = buildDomain(createTreasureDomain());
  const context = createTreasureContext();

  const plan = ensurePlan(domain, context);
  const [retrieveKey, unlockGate, collectTreasure] = plan;
  retrieveKey.operator?.(context);
  unlockGate.operator?.(context);
  context.setState("unlocked", [], false);
  assert.throws(() => collectTreasure.operator?.(context));
});

test.run();
