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

interface Point {
  x: number;
  y: number;
}

interface SokobanState extends WorldStateBase {
  player: Point;
  box: Point;
  target: Point;
  walls: Point[];
  history: string[];
}

type SokobanContext = Context<SokobanState>;

function equalPoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

function movePlayer(context: SokobanContext, destination: Point): void {
  context.setState("player", destination, false);
  context.setState("history", [...context.getState("history"), `Move to (${destination.x}, ${destination.y})`], false);
}

function pushBox(context: SokobanContext, delta: Point): void {
  const box = context.getState("box");
  const player = context.getState("player");
  const required = { x: box.x - delta.x, y: box.y - delta.y };
  if (!equalPoint(player, required)) {
    throw new Error("Player not positioned to push the box");
  }
  const target = { x: box.x + delta.x, y: box.y + delta.y };
  if (context.getState("walls").some((wall) => equalPoint(wall, target))) {
    throw new Error("Attempted to push box into a wall");
  }
  context.setState("box", target, false);
  context.setState("player", { x: box.x, y: box.y }, false);
  context.setState("history", [...context.getState("history"), `Push box to (${target.x}, ${target.y})`], false);
}

function createSokobanDomain(): DomainBuilder<SokobanContext> {
  const builder = new DomainBuilder<SokobanContext>("Sokoban");

  builder
    .sequence("Solve single-box puzzle")
      .action("Route behind box")
        .condition("Player not yet positioned", (ctx) => !equalPoint(ctx.getState("player"), { x: 0, y: 1 }))
        .do((ctx) => {
          movePlayer(ctx, { x: 0, y: 1 });
          return TaskStatus.Success;
        })
      .end()
      .action("Push box to target")
        .condition("Target not blocked", (ctx) => !ctx.getState("walls").some((wall) => equalPoint(wall, ctx.getState("target"))))
        .do((ctx) => {
          pushBox(ctx, { x: 1, y: 0 });
          return TaskStatus.Success;
        })
      .end()
      .action("Verify solved")
        .do((ctx) => {
          if (!equalPoint(ctx.getState("box"), ctx.getState("target"))) {
            throw new Error("Box not on target");
          }
          return TaskStatus.Success;
        })
      .end()
    .end();

  return builder;
}

function createSokobanContext(overrides: Partial<SokobanState> = {}): SokobanContext {
  return createPuzzleContext<SokobanState>({
    player: { x: 0, y: 0 },
    box: { x: 1, y: 1 },
    target: { x: 2, y: 1 },
    walls: [{ x: 3, y: 1 }],
    history: [],
    ...overrides,
  });
}

test("Sokoban solver routes player and pushes box to target", () => {
  const domain = buildDomain(createSokobanDomain());
  const context = createSokobanContext();

  const plan = ensurePlan(domain, context);
  assert.equal(planNames(plan), ["Route behind box", "Push box to target", "Verify solved"]);

  executePlan(plan, context);

  assert.ok(equalPoint(context.getState("box"), context.getState("target")));
  assert.is(context.getState("history").length, 2);
});

test("Sokoban planning fails when walls block target", () => {
  const domain = buildDomain(createSokobanDomain());
  const context = createSokobanContext({ walls: [{ x: 2, y: 1 }] });

  ensureNoPlan(domain, context);
});

test("Sokoban execution catches illegal pushes", () => {
  const domain = buildDomain(createSokobanDomain());
  const context = createSokobanContext();

  const plan = ensurePlan(domain, context);
  context.setState("walls", [...context.getState("walls"), context.getState("target")], false);
  assert.throws(() => executePlan(plan, context));
});

test.run();
