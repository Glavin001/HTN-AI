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

interface TaskSlot {
  name: string;
  duration: number;
  prerequisites: string[];
}

interface ScheduleState extends WorldStateBase {
  tasks: TaskSlot[];
  assignments: Record<string, number | null>;
  dayLength: number;
  reservedSlots: number[];
}

type ScheduleContext = Context<ScheduleState>;

function findAvailableSlot(state: ScheduleState, duration: number, startAt = 0): number | null {
  for (let slot = startAt; slot <= state.dayLength - duration; slot++) {
    const occupied = state.reservedSlots.some((time) => time >= slot && time < slot + duration);
    if (!occupied) {
      return slot;
    }
  }
  return null;
}

function reserveSlots(context: ScheduleContext, start: number, duration: number): void {
  const reservations = [...context.getState("reservedSlots")];
  for (let offset = 0; offset < duration; offset++) {
    reservations.push(start + offset);
  }
  context.setState("reservedSlots", reservations, false);
}

function scheduleIndependentTasks(context: ScheduleContext): void {
  const world = context.WorldState;
  const assignments = { ...world.assignments };
  for (const task of world.tasks.filter((entry) => entry.prerequisites.length === 0)) {
    if (assignments[task.name] !== null) {
      continue;
    }
    const slot = findAvailableSlot(world, task.duration, 0);
    if (slot === null) {
      throw new Error(`Unable to schedule ${task.name}`);
    }
    assignments[task.name] = slot;
    reserveSlots(context, slot, task.duration);
  }
  context.setState("assignments", assignments, false);
}

function scheduleDependentTasks(context: ScheduleContext): void {
  const world = context.WorldState;
  const assignments = { ...world.assignments };

  for (const task of world.tasks.filter((entry) => entry.prerequisites.length > 0)) {
    const prerequisiteTimes = task.prerequisites.map((name) => assignments[name]);
    if (prerequisiteTimes.some((time) => time === null)) {
      throw new Error(`Prerequisites for ${task.name} incomplete`);
    }
    const earliestStart = Math.max(...(prerequisiteTimes as number[])) + 1;
    const slot = findAvailableSlot(context.WorldState, task.duration, earliestStart);
    if (slot === null) {
      throw new Error(`Unable to schedule dependent task ${task.name}`);
    }
    assignments[task.name] = slot;
    reserveSlots(context, slot, task.duration);
  }

  context.setState("assignments", assignments, false);
}

function validateSchedule(context: ScheduleContext): void {
  const world = context.WorldState;
  for (const task of world.tasks) {
    const start = world.assignments[task.name];
    if (start === null) {
      throw new Error(`Task ${task.name} was not scheduled`);
    }
    for (const prereq of task.prerequisites) {
      const prereqStart = world.assignments[prereq];
      if (prereqStart === null || prereqStart + 1 > start) {
        throw new Error(`Task ${task.name} violates prerequisite ${prereq}`);
      }
    }
  }
}

function createScheduleDomain(): DomainBuilder<ScheduleContext> {
  const builder = new DomainBuilder<ScheduleContext>("Mini schedule");

  builder
    .sequence("Build exam schedule")
      .action("Schedule independent tasks")
        .do((ctx) => {
          scheduleIndependentTasks(ctx);
          return TaskStatus.Success;
        })
      .end()
      .action("Schedule dependent tasks")
        .do((ctx) => {
          scheduleDependentTasks(ctx);
          return TaskStatus.Success;
        })
      .end()
      .action("Validate ordering")
        .do((ctx) => {
          validateSchedule(ctx);
          return TaskStatus.Success;
        })
      .end()
    .end();

  return builder;
}

function createScheduleContext(overrides: Partial<ScheduleState> = {}): ScheduleContext {
  const tasks: TaskSlot[] = [
    { name: "Study", duration: 1, prerequisites: [] },
    { name: "GroupReview", duration: 1, prerequisites: ["Study"] },
    { name: "Exam", duration: 1, prerequisites: ["GroupReview"] },
  ];

  return createPuzzleContext<ScheduleState>({
    tasks,
    assignments: {
      Study: null,
      GroupReview: null,
      Exam: null,
    },
    dayLength: 5,
    reservedSlots: [],
    ...overrides,
  });
}

test("Scheduling pipeline assigns tasks respecting prerequisites", () => {
  const domain = buildDomain(createScheduleDomain());
  const context = createScheduleContext();

  const plan = ensurePlan(domain, context);
  assert.equal(planNames(plan), [
    "Schedule independent tasks",
    "Schedule dependent tasks",
    "Validate ordering",
  ]);

  executePlan(plan, context);

  assert.ok(context.getState("assignments").Study !== null);
  assert.ok(context.getState("assignments").GroupReview! > context.getState("assignments").Study!);
  assert.ok(context.getState("assignments").Exam! > context.getState("assignments").GroupReview!);
});

test("Scheduling planning fails when day too short", () => {
  const domain = buildDomain(createScheduleDomain());
  const context = createScheduleContext({ dayLength: 2 });

  const plan = ensurePlan(domain, context);
  assert.throws(() => executePlan(plan, context));
});

test("Scheduling execution detects prerequisite violation", () => {
  const domain = buildDomain(createScheduleDomain());
  const context = createScheduleContext();

  const plan = ensurePlan(domain, context);
  const [scheduleIndependents, scheduleDependents, validate] = plan;
  scheduleIndependents.operator?.(context);
  scheduleDependents.operator?.(context);
  context.setState("assignments", { ...context.getState("assignments"), Exam: 1 }, false);
  assert.throws(() => validate.operator?.(context));
});

test.run();
