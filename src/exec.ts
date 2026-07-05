/**
 * Execution layer (SPEC §8): a reactive Planner per agent — budgeted planning
 * sessions, FluidHTN-style replan-only-if-better (MTR), fluent-precise replan
 * triggers, executing-condition verification, scoped execution (deadline /
 * maintain / minHold / onExit), timeline drift detection, repair-first
 * recovery, and a round-robin multi-agent Scheduler.
 */

import { Bindings, ExecutorApi, ExecutorFn, Model, TIMINGS_EXECUTION, TaskStatus } from "./compile";
import { GoalSpec } from "./ir";
import { CLOCK_SLOT, ExecState } from "./state";
import { Agenda, Plan, PlanResult, PlanStep, PlanningSession, Rejection, ScopeInstance, StepBudget } from "./search";
import { Rng, createRng } from "./rng";

// ---------------------------------------------------------------- trace events

/** Why an executing step failed (machine-readable companion to the reason string). */
export type StepFailCause = "precondition" | "verify" | "executor" | "scope" | "drift";

/** JSON-serializable snapshot of a plan, carried on plan-lifecycle trace events. */
export interface TracePlanInfo {
  cost: number;
  makespan: number;
  steps: { label: string; kind: PlanStep["k"]; start: number | null; end: number | null }[];
}

export type TraceEvent =
  | { t: "plan.new"; cost: number; steps: number; makespan: number; plan: TracePlanInfo }
  | { t: "plan.replaced"; reason: "better" | "repair"; plan: TracePlanInfo }
  | { t: "plan.failed"; rejections?: Rejection[] }
  | { t: "plan.completed" }
  | { t: "replan.dirty"; fluents: string[] }
  | { t: "step.start"; label: string; index: number }
  | { t: "step.done"; label: string; index: number }
  | { t: "step.fail"; label: string; index: number; reason: string; cause: StepFailCause }
  | { t: "scope.enter"; label: string }
  | { t: "scope.exit"; label: string }
  | { t: "scope.violated"; label: string; reason: "deadline" | "maintain" }
  | { t: "drift"; label: string; behindSeconds: number }
  | { t: "repair.attempt"; from: number }
  | { t: "repair.success"; from: number; plan: TracePlanInfo }
  | { t: "repair.fallback" };

export type TraceFn = (e: TraceEvent) => void;

/** Render a plan as the serializable summary used by plan-lifecycle trace events. */
export function planInfo(model: Model, plan: Plan): TracePlanInfo {
  return {
    cost: plan.cost,
    makespan: plan.makespan,
    steps: plan.steps.map((s) => ({
      label: stepLabel(model, s),
      kind: s.k,
      start: s.k === "op" ? s.projStart : null,
      end: s.k === "op" ? s.projEnd : null,
    })),
  };
}

// ---------------------------------------------------------------- planner

export interface PlannerOptions {
  goals?: GoalSpec[];
  /** seconds-resolution clock; defaults to performance.now()/1000. Inject for determinism. */
  now?: () => number;
  seed?: number;
  weight?: number;
  maxNodes?: number;
  maxDepth?: number;
  trace?: TraceFn;
  collectRejections?: boolean;
  /** drift tolerance: replan when actual time falls this many seconds behind projection (0 = off) */
  driftTolerance?: number;
}

export type PlannerStatus = "idle" | "planning" | "running" | "succeeded" | "failed";

interface RuntimeScope {
  instance: ScopeInstance;
  enteredAt: number;
  deadlineAt: number | null;
}

export class Planner {
  public readonly model: Model;
  public readonly state: ExecState;
  public readonly rng: Rng;

  private goals: GoalSpec[];
  private readonly nowFn: () => number;
  private readonly epoch: number;
  private readonly opts: PlannerOptions;
  private trace: TraceFn;

  private plan: Plan | null = null;
  private cursor = 0;
  private session: PlanningSession | null = null;
  private sessionKind: "initial" | "improve" | "repair" = "initial";
  private repairFrom = 0;
  private lastMTR: number[] = [];
  private scopeStack: RuntimeScope[] = [];
  private stepEnteredAt = 0;
  private stepScratch: unknown = undefined;
  private stepStarted = false;
  private pending: { done: boolean; status?: TaskStatus } | null = null;
  private status: PlannerStatus = "idle";

  constructor(model: Model, opts: PlannerOptions = {}) {
    this.model = model;
    this.state = model.createExecState();
    this.rng = createRng(opts.seed ?? 0x12345678);
    this.goals = opts.goals ?? [];
    this.nowFn = opts.now ?? defaultNow;
    this.epoch = this.nowFn();
    this.opts = opts;
    this.trace = opts.trace ?? (() => undefined);
  }

  setGoals(goals: GoalSpec[]): void {
    this.goals = goals;
    this.abandonPlan();
    this.status = "idle";
  }

  setTrace(fn: TraceFn): void {
    this.trace = fn;
  }

  getPlan(): Plan | null {
    return this.plan;
  }

  getStatus(): PlannerStatus {
    return this.status;
  }

  currentStep(): PlanStep | null {
    return this.plan && this.cursor < this.plan.steps.length ? this.plan.steps[this.cursor] : null;
  }

  /** execution clock in seconds since this planner was created */
  clock(): number {
    return this.state.get(CLOCK_SLOT);
  }

  private abandonPlan(): void {
    this.plan = null;
    this.cursor = 0;
    this.session = null;
    this.scopeStack = [];
    this.pending = null;
    this.stepStarted = false;
    this.lastMTR = [];
  }

  // ---------------- the tick

  tick(budget: StepBudget = { ms: 2 }): PlannerStatus {
    // 1. advance the execution clock
    this.state.setSilent(CLOCK_SLOT, this.nowFn() - this.epoch);

    if (this.goals.length === 0 && !this.plan) {
      this.status = "idle";
      return this.status;
    }

    // 2. react to relevant world changes: try to find a better plan (keep executing meanwhile)
    if (this.plan && this.state.dirtyFluents.size > 0) {
      const relevant =
        intersects(this.state.dirtyFluents, this.plan.readFluents) ||
        intersects(this.state.dirtyFluents, this.model.methodReads);
      if (relevant && !this.session) {
        this.trace({
          t: "replan.dirty",
          fluents: [...this.state.dirtyFluents].map((id) => this.model.fluents[id]?.decl.name ?? String(id)),
        });
        this.session = new PlanningSession(this.model, this.state, this.request({ lastMTR: this.plan.mtr }));
        this.sessionKind = "improve";
      }
      this.state.clearDirty();
    }

    // 3. pump any active planning session within budget
    if (this.session) {
      const result = this.session.step(budget);
      if (result) {
        this.session = null;
        this.onSessionResult(result);
      } else {
        if (!this.plan) {
          this.status = "planning";
          return this.status;
        }
      }
    } else if (!this.plan) {
      this.session = new PlanningSession(this.model, this.state, this.request({}));
      this.sessionKind = "initial";
      const result = this.session.step(budget);
      if (result) {
        this.session = null;
        this.onSessionResult(result);
      }
      if (!this.plan) {
        this.status = this.session || !this.statusIsTerminal() ? "planning" : this.status;
        return this.status;
      }
    }

    if (!this.plan) return this.status;

    // 4. enforce active scopes every tick
    const violation = this.checkScopes();
    if (violation) {
      this.failStep(`scope ${violation.instance.label} violated`, "scope");
      return this.status;
    }

    // 5. drive the current step
    this.executeSteps();
    return this.status;
  }

  private statusIsTerminal(): boolean {
    return this.status === "failed" || this.status === "succeeded";
  }

  private request(extra: { lastMTR?: number[]; agendaOverride?: Agenda }): {
    goals: GoalSpec[];
    lastMTR?: number[];
    agendaOverride?: Agenda;
    weight?: number;
    maxNodes?: number;
    maxDepth?: number;
    collectRejections?: boolean;
  } {
    return {
      goals: this.goals,
      weight: this.opts.weight,
      maxNodes: this.opts.maxNodes,
      maxDepth: this.opts.maxDepth,
      collectRejections: this.opts.collectRejections,
      ...extra,
    };
  }

  private onSessionResult(result: PlanResult): void {
    if (result.status === "success" && result.plan) {
      if (this.sessionKind === "repair") {
        // splice: completed prefix stays history; new plan replaces the remainder
        this.trace({ t: "repair.success", from: this.repairFrom, plan: planInfo(this.model, result.plan) });
        this.installPlan(result.plan, "repair");
        return;
      }
      if (this.plan) {
        this.trace({ t: "plan.replaced", reason: "better", plan: planInfo(this.model, result.plan) });
      } else {
        this.trace({ t: "plan.new", cost: result.plan.cost, steps: result.plan.steps.length, makespan: result.plan.makespan, plan: planInfo(this.model, result.plan) });
      }
      this.installPlan(result.plan, "normal");
      return;
    }
    // failure
    if (this.sessionKind === "improve" && this.plan) {
      return; // keep executing the current plan; no better plan exists
    }
    if (this.sessionKind === "repair") {
      this.trace({ t: "repair.fallback" });
      this.abandonPlan();
      this.session = new PlanningSession(this.model, this.state, this.request({}));
      this.sessionKind = "initial";
      return;
    }
    this.trace({ t: "plan.failed", rejections: result.rejections });
    this.abandonPlan();
    this.status = "failed";
  }

  private installPlan(plan: Plan, mode: "normal" | "repair"): void {
    this.plan = plan;
    this.cursor = 0;
    this.scopeStack = [];
    this.pending = null;
    this.stepStarted = false;
    this.lastMTR = mode === "normal" ? plan.mtr : [];
    this.status = "running";
  }

  // ---------------- step execution

  private executeSteps(): void {
    const plan = this.plan;
    if (!plan) return;

    // bookkeeping steps are free; at most one operator executor runs per tick
    for (;;) {
      if (this.cursor >= plan.steps.length) {
        this.trace({ t: "plan.completed" });
        this.plan = null;
        this.cursor = 0;
        this.lastMTR = [];
        this.scopeStack = [];
        this.status = "succeeded";
        return;
      }
      const step = plan.steps[this.cursor];

      if (step.k === "scopeEnter") {
        const enteredAt = this.clock();
        this.scopeStack.push({
          instance: step.scope,
          enteredAt,
          deadlineAt: step.scope.deadlineRel === null ? null : enteredAt + step.scope.deadlineRel,
        });
        this.trace({ t: "scope.enter", label: step.scope.label });
        this.cursor++;
        continue;
      }

      if (step.k === "scopeExit") {
        const rt = this.scopeStack.find((r) => r.instance.id === step.scope.id);
        const heldFor = rt ? this.clock() - rt.enteredAt : Infinity;
        if (rt && heldFor < rt.instance.minHold) {
          this.status = "running"; // keep holding
          return;
        }
        this.exitScope(step.scope.id, false);
        this.cursor++;
        continue;
      }

      if (step.k === "wait") {
        if (this.clock() + 1e-9 >= step.until) {
          this.cursor++;
          continue;
        }
        this.status = "running";
        return;
      }

      // operator step
      this.runOperatorStep(step);
      return;
    }
  }

  private runOperatorStep(step: Extract<PlanStep, { k: "op" }>): void {
    const { g } = step;
    const label = this.model.describeGroundOp(g);

    if (!this.stepStarted) {
      // re-validate the precondition against the live world
      if (g.op.pre && !g.op.pre.fn(this.state, g.b)) {
        this.failStep(`precondition of ${label} no longer holds`, "precondition");
        return;
      }
      this.stepStarted = true;
      this.stepEnteredAt = this.clock();
      this.stepScratch = undefined;
      this.pending = null;
      this.trace({ t: "step.start", label, index: this.cursor });
    }

    // executing condition, every tick
    if (g.op.verify && !g.op.verify.fn(this.state, g.b)) {
      this.failStep(`executing condition of ${label} violated`, "verify");
      return;
    }

    // timeline drift detection (temporal-lite, SPEC §4.13)
    const tol = this.opts.driftTolerance ?? 0;
    if (tol > 0 && this.plan) {
      const behind = this.clock() - (this.plan.startClock + (step.projEnd - this.plan.startClock));
      if (behind > tol) {
        this.trace({ t: "drift", label, behindSeconds: behind });
        this.failStep(`drift: ${behind.toFixed(2)}s behind projection at ${label}`, "drift");
        return;
      }
    }

    let status: TaskStatus;
    if (this.pending) {
      if (!this.pending.done) {
        this.status = "running";
        return;
      }
      status = this.pending.status ?? "failure";
      this.pending = null;
    } else {
      status = this.invokeExecutor(g.op.executor, g.b);
      if (status === "continue" && this.pending && !(this.pending as { done: boolean }).done) {
        this.status = "running";
        return;
      }
    }

    if (status === "continue") {
      this.status = "running";
      return;
    }

    if (status === "success") {
      this.state.withPlannedWrites(() => g.op.effects.apply(this.state, g.b, TIMINGS_EXECUTION));
      this.trace({ t: "step.done", label, index: this.cursor });
      this.cursor++;
      this.stepStarted = false;
      // bookkeeping steps after an op may complete in the same tick
      this.executeStepsBookkeepingOnly();
      return;
    }

    this.failStep(`executor of ${label} returned failure`, "executor");
  }

  /** advance through any non-operator steps without running another executor this tick */
  private executeStepsBookkeepingOnly(): void {
    const plan = this.plan;
    if (!plan) return;
    while (this.cursor < plan.steps.length) {
      const step = plan.steps[this.cursor];
      if (step.k === "op") return;
      if (step.k === "scopeEnter") {
        const enteredAt = this.clock();
        this.scopeStack.push({
          instance: step.scope,
          enteredAt,
          deadlineAt: step.scope.deadlineRel === null ? null : enteredAt + step.scope.deadlineRel,
        });
        this.trace({ t: "scope.enter", label: step.scope.label });
        this.cursor++;
        continue;
      }
      if (step.k === "scopeExit") {
        const rt = this.scopeStack.find((r) => r.instance.id === step.scope.id);
        const heldFor = rt ? this.clock() - rt.enteredAt : Infinity;
        if (rt && heldFor < rt.instance.minHold) return;
        this.exitScope(step.scope.id, false);
        this.cursor++;
        continue;
      }
      // wait
      if (this.clock() + 1e-9 >= step.until) {
        this.cursor++;
        continue;
      }
      return;
    }
    if (this.cursor >= plan.steps.length) {
      this.trace({ t: "plan.completed" });
      this.plan = null;
      this.cursor = 0;
      this.lastMTR = [];
      this.scopeStack = [];
      this.status = "succeeded";
    }
  }

  private invokeExecutor(name: string | undefined, args: Bindings): TaskStatus {
    if (!name) return "success";
    const fn: ExecutorFn | undefined = this.model.registry.executors[name];
    if (!fn) throw new Error(`Unregistered executor '${name}'`);
    const api = this.executorApi(args);
    const r = fn(api);
    if (r && typeof r === "object" && "then" in r) {
      const slot: { done: boolean; status?: TaskStatus } = { done: false };
      this.pending = slot;
      (r as Promise<TaskStatus>).then(
        (st) => {
          slot.done = true;
          slot.status = st;
        },
        () => {
          slot.done = true;
          slot.status = "failure";
        },
      );
      return "continue";
    }
    return r as TaskStatus;
  }

  private executorApi(args: Bindings): ExecutorApi {
    const model = this.model;
    const state = this.state;
    return {
      args,
      model,
      read: (fluent, ...a) => state.get(model.slotOf(fluent, ...a.map((x) => (typeof x === "string" ? model.entityId(x) : x)))),
      write: (fluent, a, value) => {
        const slot = model.slotOf(fluent, ...a.map((x) => (typeof x === "string" ? model.entityId(x) : x)));
        state.set(slot, model.encodeValue(fluent, value));
      },
      clock: () => this.clock(),
      elapsedInStep: () => this.clock() - this.stepEnteredAt,
      rng: this.rng,
      remember: <T>(init: () => T): T => {
        if (this.stepScratch === undefined) this.stepScratch = init();
        return this.stepScratch as T;
      },
    };
  }

  // ---------------- scopes & failure handling

  private checkScopes(): RuntimeScope | null {
    for (const rt of this.scopeStack) {
      if (rt.deadlineAt !== null && this.clock() > rt.deadlineAt + 1e-9) {
        this.trace({ t: "scope.violated", label: rt.instance.label, reason: "deadline" });
        return rt;
      }
      if (rt.instance.maintain && !rt.instance.maintain(this.state)) {
        this.trace({ t: "scope.violated", label: rt.instance.label, reason: "maintain" });
        return rt;
      }
    }
    return null;
  }

  private exitScope(id: number, aborted: boolean): void {
    const idx = this.scopeStack.findIndex((r) => r.instance.id === id);
    if (idx < 0) return;
    // exit nested scopes first (top of stack down to idx) — try/finally semantics
    for (let i = this.scopeStack.length - 1; i >= idx; i--) {
      const rt = this.scopeStack[i];
      if (rt.instance.onExit) {
        const fn = this.model.registry.executors[rt.instance.onExit];
        if (fn) fn(this.executorApi([]));
      }
      this.trace({ t: "scope.exit", label: rt.instance.label });
      void aborted;
    }
    this.scopeStack.length = idx;
  }

  private failStep(reason: string, cause: StepFailCause): void {
    const plan = this.plan;
    if (!plan) return;
    const index = Math.min(this.cursor, plan.steps.length - 1);
    this.trace({ t: "step.fail", label: stepLabel(this.model, plan.steps[index]), index, reason, cause });

    // run all open scope exits (cleanup-on-abort)
    if (this.scopeStack.length > 0) {
      this.exitScope(this.scopeStack[0].instance.id, true);
    }

    const failed = plan.steps[index];
    const canSuffixRepair = failed.agendaBefore !== null && this.scopeStack.length === 0 && !containsScopeItems(failed.agendaBefore);

    this.plan = null;
    this.cursor = 0;
    this.stepStarted = false;
    this.pending = null;
    this.lastMTR = [];

    if (canSuffixRepair) {
      this.trace({ t: "repair.attempt", from: index });
      this.repairFrom = index;
      this.session = new PlanningSession(this.model, this.state, this.request({ agendaOverride: failed.agendaBefore }));
      this.sessionKind = "repair";
      this.status = "planning";
      return;
    }

    this.session = new PlanningSession(this.model, this.state, this.request({}));
    this.sessionKind = "initial";
    this.status = "planning";
  }
}

function containsScopeItems(agenda: Agenda): boolean {
  let cur = agenda;
  while (cur) {
    if (cur.head.k === "scopeEnter" || cur.head.k === "scopeExit") return true;
    cur = cur.tail;
  }
  return false;
}

export function stepLabel(model: Model, step: PlanStep): string {
  switch (step.k) {
    case "op": return model.describeGroundOp(step.g);
    case "scopeEnter": return `enter:${step.scope.label}`;
    case "scopeExit": return `exit:${step.scope.label}`;
    case "wait": return `wait→${step.until.toFixed(2)}s`;
  }
}

function intersects(a: Set<number>, b: Set<number>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) return true;
  return false;
}

function defaultNow(): number {
  return (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
}

// ---------------------------------------------------------------- multi-agent scheduler

/**
 * Round-robin planning budget across many agents (SPEC §8): execution is
 * advanced for every agent every tick, planning time is staggered.
 */
export class Scheduler {
  private readonly planners: Planner[] = [];
  private rotation = 0;

  add(planner: Planner): void {
    this.planners.push(planner);
  }

  tick(totalBudgetMs: number): void {
    const n = this.planners.length;
    if (n === 0) return;
    const start = now();
    const each = Math.max(totalBudgetMs / n, 0.05);
    for (let i = 0; i < n; i++) {
      const idx = (this.rotation + i) % n;
      const remaining = totalBudgetMs - (now() - start);
      this.planners[idx].tick({ ms: Math.max(Math.min(each, remaining), 0) });
      if (remaining <= 0) {
        // out of budget: still advance the rest without planning time
        for (let j = i + 1; j < n; j++) this.planners[(this.rotation + j) % n].tick({ ms: 0, nodes: 0 });
        break;
      }
    }
    this.rotation = (this.rotation + 1) % n;
  }
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
