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

interface LadderState extends WorldStateBase {
  start: string;
  target: string;
  dictionary: string[];
  path: string[];
}

type LadderContext = Context<LadderState>;

function neighbors(word: string, dictionary: Set<string>): string[] {
  const results: string[] = [];
  const letters = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < word.length; i++) {
    for (const char of letters) {
      if (char === word[i]) {
        continue;
      }
      const candidate = `${word.slice(0, i)}${char}${word.slice(i + 1)}`;
      if (dictionary.has(candidate)) {
        results.push(candidate);
      }
    }
  }
  return results;
}

function buildLadder(context: LadderContext): void {
  const { start, target, dictionary } = context.WorldState;
  const dict = new Set(dictionary);
  if (!dict.has(target)) {
    dict.add(target);
  }

  const queue: Array<{ word: string; path: string[] }> = [{ word: start, path: [start] }];
  const visited = new Set<string>([start]);

  while (queue.length > 0) {
    const { word, path } = queue.shift()!;
    if (word === target) {
      context.setState("path", path, false);
      return;
    }

    for (const next of neighbors(word, dict)) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push({ word: next, path: [...path, next] });
      }
    }
  }

  throw new Error("No ladder found");
}

function createWordLadderDomain(): DomainBuilder<LadderContext> {
  const builder = new DomainBuilder<LadderContext>("Word ladder");

  builder
    .sequence("Transform start into target")
      .action("Generate ladder path")
        .condition("Start differs from target", (ctx) => ctx.getState("start") !== ctx.getState("target"))
        .do((ctx) => {
          buildLadder(ctx);
          return TaskStatus.Success;
        })
      .end()
      .action("Validate ladder")
        .do((ctx) => {
          const path = ctx.getState("path");
          if (path.length === 0 || path[path.length - 1] !== ctx.getState("target")) {
            throw new Error("Ladder does not reach target");
          }
          return TaskStatus.Success;
        })
      .end()
    .end();

  return builder;
}

function createWordLadderContext(overrides: Partial<LadderState> = {}): LadderContext {
  return createPuzzleContext<LadderState>({
    start: "cold",
    target: "warm",
    dictionary: ["cord", "card", "ward", "warm", "wold", "word"],
    path: [],
    ...overrides,
  });
}

test("Word ladder computes a transformation path", () => {
  const domain = buildDomain(createWordLadderDomain());
  const context = createWordLadderContext();

  const plan = ensurePlan(domain, context);
  assert.equal(planNames(plan), ["Generate ladder path", "Validate ladder"]);

  executePlan(plan, context);

  assert.equal(context.getState("path")[0], "cold");
  assert.equal(context.getState("path")[context.getState("path").length - 1], "warm");
  assert.ok(context.getState("path").length > 2);
});

test("Word ladder planning fails when already solved", () => {
  const domain = buildDomain(createWordLadderDomain());
  const context = createWordLadderContext({ start: "same", target: "same" });

  ensureNoPlan(domain, context);
});

test("Word ladder execution detects missing path", () => {
  const domain = buildDomain(createWordLadderDomain());
  const context = createWordLadderContext({ dictionary: ["cold", "bold"] });

  const plan = ensurePlan(domain, context);
  assert.throws(() => executePlan(plan, context));
});

test.run();
