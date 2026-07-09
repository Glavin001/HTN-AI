import { test } from "uvu";
import * as assert from "uvu/assert";
import type Context from "../../../src/context";
import DomainBuilder from "../../../src/domainBuilder";
import TaskStatus from "../../../src/taskStatus";
import type { WorldStateBase } from "../../../src/context";
import {
  buildDomain,
  createPuzzleContext,
  ensurePlan,
  executePlan,
  planNames,
} from "./helpers";

type PossibilityMap = Record<string, string[]>;

interface LogicGridState extends WorldStateBase {
  people: string[];
  pets: string[];
  possibilities: PossibilityMap;
  assignments: Record<string, string | null>;
  appliedClues: string[];
}

type LogicGridContext = Context<LogicGridState>;

function removeOption(possibilities: PossibilityMap, person: string, pet: string): PossibilityMap {
  return {
    ...possibilities,
    [person]: possibilities[person].filter((option) => option !== pet),
  };
}

function ensureSingletons(context: LogicGridContext): void {
  const world = context.WorldState;
  const assignments = { ...world.assignments };
  const possibilities = { ...world.possibilities };

  let progress = true;
  while (progress) {
    progress = false;
    for (const person of world.people) {
      const options = possibilities[person];
      if (options.length === 1 && assignments[person] !== options[0]) {
        assignments[person] = options[0];
        for (const other of world.people) {
          if (other !== person && possibilities[other].includes(options[0]!)) {
            possibilities[other] = possibilities[other].filter((candidate) => candidate !== options[0]);
            progress = true;
          }
        }
        context.setState(
          "appliedClues",
          [...context.getState("appliedClues"), `${person} assigned to ${options[0]}`],
          false,
        );
      }
    }
  }

  context.setState("assignments", assignments, false);
  context.setState("possibilities", possibilities, false);
}

function applyDirectClues(context: LogicGridContext): void {
  const world = context.WorldState;
  const updated = removeOption(world.possibilities, "Ada", "Dog");
  context.setState("possibilities", updated, false);
  context.setState("appliedClues", [...world.appliedClues, "Ada does not own the dog"], false);
}

function resolveExclusiveClue(context: LogicGridContext): void {
  const world = context.WorldState;
  const possibilities = { ...world.possibilities };

  const catOwners = world.people.filter((person) => possibilities[person].includes("Cat"));
  if (catOwners.length === 1) {
    const owner = catOwners[0]!;
    possibilities[owner] = ["Cat"];
    for (const person of world.people) {
      if (person !== owner) {
        possibilities[person] = possibilities[person].filter((pet) => pet !== "Cat");
      }
    }
    context.setState("appliedClues", [...world.appliedClues, `Cat assigned to ${owner}`], false);
  } else if (catOwners.length === 0) {
    throw new Error("Clue contradiction: cat must have an owner");
  }

  context.setState("possibilities", possibilities, false);
  ensureSingletons(context);
}

function finalizeAssignments(context: LogicGridContext): void {
  const world = context.WorldState;
  ensureSingletons(context);
  const solved = Object.values(context.getState("assignments")).every((value) => value !== null);
  if (!solved) {
    throw new Error("Failed to deduce complete assignment");
  }
}

function createLogicGridDomain(): DomainBuilder<LogicGridContext> {
  const builder = new DomainBuilder<LogicGridContext>("Logic grid");

  builder
    .sequence("Solve pet ownership puzzle")
      .action("Apply direct clues")
        .do((ctx) => {
          applyDirectClues(ctx);
          return TaskStatus.Success;
        })
      .end()
      .action("Resolve exclusive clue")
        .do((ctx) => {
          resolveExclusiveClue(ctx);
          return TaskStatus.Success;
        })
      .end()
      .action("Finalize assignments")
        .do((ctx) => {
          finalizeAssignments(ctx);
          return TaskStatus.Success;
        })
      .end()
    .end();

  return builder;
}

function createLogicGridContext(overrides: Partial<LogicGridState> = {}): LogicGridContext {
  const people = ["Ada", "Ben"];
  const pets = ["Cat", "Dog"];
  return createPuzzleContext<LogicGridState>({
    people,
    pets,
    possibilities: {
      Ada: [...pets],
      Ben: [...pets],
    },
    assignments: {
      Ada: null,
      Ben: null,
    },
    appliedClues: [],
    ...overrides,
  });
}

test("Logic grid applies elimination to deduce assignments", () => {
  const domain = buildDomain(createLogicGridDomain());
  const context = createLogicGridContext();

  const plan = ensurePlan(domain, context);
  assert.equal(planNames(plan), [
    "Apply direct clues",
    "Resolve exclusive clue",
    "Finalize assignments",
  ]);

  executePlan(plan, context);

  assert.equal(context.getState("assignments"), { Ada: "Cat", Ben: "Dog" });
  assert.ok(context.getState("appliedClues").length >= 1);
});

test("Logic grid detects contradictory clues", () => {
  const domain = buildDomain(createLogicGridDomain());
  const context = createLogicGridContext({
    possibilities: {
      Ada: ["Dog"],
      Ben: ["Dog"],
    },
  });

  const plan = ensurePlan(domain, context);
  assert.throws(() => executePlan(plan, context));
});

test.run();
