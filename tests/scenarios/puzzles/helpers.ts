import Context, { type WorldStateBase } from "../../../src/context";
import DomainBuilder from "../../../src/domainBuilder";
import DecompositionStatus from "../../../src/decompositionStatus";
import type Domain from "../../../src/domain";
import PrimitiveTask from "../../../src/Tasks/primitiveTask";
import TaskStatus, { type TaskStatusValue } from "../../../src/taskStatus";
import { ContextState } from "../../../src/contextState";

export type PuzzleWorldState = WorldStateBase;

export function createPuzzleContext<TState extends PuzzleWorldState>(state: TState): Context<TState> {
  const ctx = new Context(state);
  ctx.init();
  return ctx;
}

export function buildDomain<TContext extends Context<PuzzleWorldState>>(builder: DomainBuilder<TContext>): Domain<TContext> {
  return builder.build();
}

export function ensurePlan<TContext extends Context<PuzzleWorldState>>(
  domain: Domain<TContext>,
  context: TContext,
): PrimitiveTask<TContext>[] {
  const { status, plan } = domain.findPlan(context);
  if (status !== DecompositionStatus.Succeeded || !plan) {
    throw new Error(`Expected plan but got status ${status}`);
  }
  return plan;
}

export function ensureNoPlan<TContext extends Context<PuzzleWorldState>>(
  domain: Domain<TContext>,
  context: TContext,
): void {
  const { status } = domain.findPlan(context);
  if (status === DecompositionStatus.Succeeded) {
    throw new Error("Expected planning failure but got success");
  }
}

export function planNames<TContext extends Context<PuzzleWorldState>>(plan: PrimitiveTask<TContext>[]): string[] {
  return plan.map((task) => task.Name);
}

export function executePlan<TContext extends Context<PuzzleWorldState>>(
  plan: PrimitiveTask<TContext>[],
  context: TContext,
): TaskStatusValue[] {
  return plan.map((task) => {
    if (typeof task.operator !== "function") {
      throw new Error(`Task '${task.Name}' is missing an operator`);
    }

    const status = task.operator(context);
    if (status !== TaskStatus.Success) {
      throw new Error(`Task '${task.Name}' execution failed with status ${status}`);
    }

    task.applyEffects(context);
    context.IsDirty = false;
    context.ContextState = ContextState.Executing;

    return status;
  });
}
