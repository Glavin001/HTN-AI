/**
 * Structured plan-event stream — the "director feed".
 *
 * Correlates a Planner's low-level TraceEvents into plan-lifecycle events —
 * plan created / step started / step completed / plan completed / plan
 * invalidated / plan failed — each stamped with an agent name, a per-agent
 * plan id, a global sequence number and the planner clock, and each carrying
 * a structured, JSON-serializable reason instead of a pre-formatted string.
 *
 * Built entirely on the public trace seam: `attach()` installs a trace fn on
 * the planner and buffers derived events until `drain()`. Many planners can
 * share one stream, so a director consumes a single merged, ordered feed.
 */

import type { Rejection } from "./search";
import type { Planner, StepFailCause, TraceEvent, TraceFn, TracePlanInfo } from "./exec";

// ---------------------------------------------------------------- event shapes

/** Structured, machine-readable reason on plan.invalidated / plan.failed. */
export type PlanEventReason =
  /** a relevant world change produced a better plan; the old plan was abandoned for it */
  | { kind: "world-changed"; fluents: string[] }
  /** an executing step failed; `cause` says how, `scope` names the violated scope when cause is "scope" */
  | {
      kind: "step-failed";
      step: string;
      index: number;
      cause: StepFailCause;
      detail: string;
      scope?: { label: string; violated: "deadline" | "maintain" };
    }
  /** no plan could be found for the current goals (rejections when collectRejections is on) */
  | { kind: "search-exhausted"; rejections: Rejection[] };

/** How a created plan came to be: fresh search, reactive improvement, or repair from a failure point. */
export type PlanCreatedVia = "initial" | "improve" | "repair";

type PlanEventBody =
  | { t: "plan.created"; via: PlanCreatedVia; steps: TracePlanInfo["steps"]; cost: number; makespan: number }
  | { t: "step.started"; label: string; index: number }
  | { t: "step.completed"; label: string; index: number }
  | { t: "plan.completed" }
  | { t: "plan.invalidated"; reason: PlanEventReason }
  | { t: "plan.failed"; reason: PlanEventReason };

export type PlanEvent = {
  /** global monotonic order across all attached agents */
  seq: number;
  /** planner clock (seconds) when the event fired; deterministic under an injected `now` */
  at: number;
  agent: string;
  /**
   * Correlates events to a plan: increments per agent on every plan.created.
   * Events fired before an agent's first plan (e.g. plan.failed) carry 0.
   */
  planId: number;
} & PlanEventBody;

// ---------------------------------------------------------------- the stream

export interface PlanEventStreamOptions {
  /** push-mode delivery, called for every event as it is derived (drain() still works) */
  onEvent?: (e: PlanEvent) => void;
}

interface AgentCtx {
  planner: Planner;
  agent: string;
  planId: number;
  /** fluents from the last replan.dirty since the current plan was installed */
  dirty: string[] | null;
  /** last scope.violated, consumed by the following step.fail with cause "scope" */
  scopeViolation: { label: string; violated: "deadline" | "maintain" } | null;
}

export class PlanEventStream {
  private buffer: PlanEvent[] = [];
  private seq = 0;
  private readonly onEvent?: (e: PlanEvent) => void;

  constructor(opts: PlanEventStreamOptions = {}) {
    this.onEvent = opts.onEvent;
  }

  /**
   * Wire a planner into this stream (replaces the planner's trace fn; pass
   * `forward` to keep receiving the raw TraceEvents as well). Returns the
   * installed trace fn so callers can compose further if needed.
   */
  attach(planner: Planner, agent: string, opts: { forward?: TraceFn } = {}): TraceFn {
    const ctx: AgentCtx = { planner, agent, planId: 0, dirty: null, scopeViolation: null };
    const fn: TraceFn = (e) => {
      this.handle(ctx, e);
      opts.forward?.(e);
    };
    planner.setTrace(fn);
    return fn;
  }

  /** Events buffered and not yet drained. */
  get pending(): number {
    return this.buffer.length;
  }

  /** Return all buffered events (ordered by seq) and clear the buffer. */
  drain(): PlanEvent[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  // ---------------- trace → plan-event correlation

  private emit(ctx: AgentCtx, body: PlanEventBody): void {
    const e = { seq: this.seq++, at: ctx.planner.clock(), agent: ctx.agent, planId: ctx.planId, ...body } as PlanEvent;
    this.buffer.push(e);
    this.onEvent?.(e);
  }

  private created(ctx: AgentCtx, via: PlanCreatedVia, plan: TracePlanInfo): void {
    ctx.planId++;
    ctx.dirty = null;
    ctx.scopeViolation = null;
    this.emit(ctx, { t: "plan.created", via, steps: plan.steps, cost: plan.cost, makespan: plan.makespan });
  }

  private handle(ctx: AgentCtx, e: TraceEvent): void {
    switch (e.t) {
      case "replan.dirty":
        ctx.dirty = e.fluents;
        return;
      case "plan.new":
        this.created(ctx, "initial", e.plan);
        return;
      case "plan.replaced":
        // the running plan is dropped for a better one found after a relevant world change
        this.emit(ctx, { t: "plan.invalidated", reason: { kind: "world-changed", fluents: ctx.dirty ?? [] } });
        this.created(ctx, "improve", e.plan);
        return;
      case "repair.success":
        // the invalidation was already emitted by the step.fail that started the repair
        this.created(ctx, "repair", e.plan);
        return;
      case "step.start":
        this.emit(ctx, { t: "step.started", label: e.label, index: e.index });
        return;
      case "step.done":
        this.emit(ctx, { t: "step.completed", label: e.label, index: e.index });
        return;
      case "scope.violated":
        ctx.scopeViolation = { label: e.label, violated: e.reason };
        return;
      case "step.fail": {
        const reason: PlanEventReason = {
          kind: "step-failed",
          step: e.label,
          index: e.index,
          cause: e.cause,
          detail: e.reason,
          ...(e.cause === "scope" && ctx.scopeViolation ? { scope: ctx.scopeViolation } : {}),
        };
        ctx.scopeViolation = null;
        this.emit(ctx, { t: "plan.invalidated", reason });
        return;
      }
      case "plan.completed":
        this.emit(ctx, { t: "plan.completed" });
        return;
      case "plan.failed":
        this.emit(ctx, { t: "plan.failed", reason: { kind: "search-exhausted", rejections: e.rejections ?? [] } });
        return;
      default:
        // scope.enter/exit, drift, repair.attempt/fallback: internal detail below
        // the plan-lifecycle altitude (drift & repair surface via step.fail / plan.created)
        return;
    }
  }
}
