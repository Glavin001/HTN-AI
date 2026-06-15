/**
 * Validation & explanation APIs (SPEC §9) — the "sound critic" surface for
 * LLM loops and tests: validate/simulate plans symbolically, query applicable
 * actions (affordances), and render failures as human/LLM-readable text.
 */

import { Bindings, GroundOp, Model, TIMINGS_PLANNING } from "./compile";
import { printFormula } from "./ir";
import { CLOCK_SLOT, Snap, StateView } from "./state";
import { Plan, PlanResult } from "./search";
import { stepLabel } from "./exec";

export interface PlanDiagnosis {
  step: number;
  label: string;
  message: string;
  /** pretty-printed failing condition, when applicable */
  condition?: string;
}

function viewFrom(model: Model, snap: Snap): StateView {
  const flat = new Float64Array(model.slotCount);
  for (let i = 0; i < flat.length; i++) flat[i] = snap.get(i);
  return StateView.fromBase(flat);
}

/** Ground operators whose preconditions hold in the given state (affordance query). */
export function applicableActions(model: Model, snap: Snap): { op: GroundOp; label: string }[] {
  const out: { op: GroundOp; label: string }[] = [];
  for (const g of model.groundOps) {
    if (!g.op.pre || g.op.pre.fn(snap, g.b)) {
      out.push({ op: g, label: model.describeGroundOp(g) });
    }
  }
  return out;
}

/**
 * Symbolically roll a plan forward from a state, verifying every operator
 * precondition and scope constraint. Returns structured diagnoses (empty =
 * valid) — designed for LLM backprompting and tests.
 */
export function validatePlan(model: Model, snap: Snap, plan: Plan): PlanDiagnosis[] {
  const diagnoses: PlanDiagnosis[] = [];
  let state = viewFrom(model, snap);
  const active: { label: string; deadlineAbs: number | null; maintain: ((s: Snap) => boolean) | null; enterClock: number; minHold: number }[] = [];

  for (const [i, step] of plan.steps.entries()) {
    const label = stepLabel(model, step);
    switch (step.k) {
      case "op": {
        const { g } = step;
        if (g.op.pre && !g.op.pre.fn(state, g.b)) {
          diagnoses.push({
            step: i,
            label,
            message: `precondition of '${g.op.name}' is unsatisfied`,
            condition: g.op.pre ? printFormula(g.op.pre.ir) : undefined,
          });
          return diagnoses;
        }
        const child = state.child();
        g.op.effects.apply(child, g.b, TIMINGS_PLANNING);
        const dur = g.op.duration.fn(state, g.b);
        if (dur !== 0) child.set(CLOCK_SLOT, state.get(CLOCK_SLOT) + dur);
        state = child;
        break;
      }
      case "wait": {
        const child = state.child();
        child.set(CLOCK_SLOT, Math.max(state.get(CLOCK_SLOT), step.until));
        state = child;
        break;
      }
      case "scopeEnter": {
        const nowClock = state.get(CLOCK_SLOT);
        if (step.scope.maintain && !step.scope.maintain(state)) {
          diagnoses.push({ step: i, label, message: `maintain condition false at entry of '${step.scope.label}'` });
          return diagnoses;
        }
        active.push({
          label: step.scope.label,
          deadlineAbs: step.scope.deadlineRel === null ? null : nowClock + step.scope.deadlineRel,
          maintain: step.scope.maintain,
          enterClock: nowClock,
          minHold: step.scope.minHold,
        });
        break;
      }
      case "scopeExit": {
        const idx = active.findIndex((a) => a.label === step.scope.label);
        if (idx >= 0) {
          const sc = active[idx];
          const nowClock = state.get(CLOCK_SLOT);
          if (nowClock - sc.enterClock < sc.minHold) {
            const child = state.child();
            child.set(CLOCK_SLOT, sc.enterClock + sc.minHold);
            state = child;
          }
          active.splice(idx, 1);
        }
        break;
      }
    }
    for (const sc of active) {
      const nowClock = state.get(CLOCK_SLOT);
      if (sc.deadlineAbs !== null && nowClock > sc.deadlineAbs + 1e-9) {
        diagnoses.push({
          step: i,
          label,
          message: `deadline of '${sc.label}' exceeded: projected clock ${nowClock.toFixed(2)}s > ${sc.deadlineAbs.toFixed(2)}s`,
        });
        return diagnoses;
      }
      if (sc.maintain && !sc.maintain(state)) {
        diagnoses.push({ step: i, label, message: `maintain condition of '${sc.label}' violated after this step` });
        return diagnoses;
      }
    }
  }
  return diagnoses;
}

/** Roll a plan forward symbolically; returns the resulting state (or diagnoses on failure). */
export function simulatePlan(
  model: Model,
  snap: Snap,
  plan: Plan,
): { ok: boolean; end: StateView; diagnoses: PlanDiagnosis[] } {
  const diagnoses = validatePlan(model, snap, plan);
  let state = viewFrom(model, snap);
  if (diagnoses.length === 0) {
    for (const step of plan.steps) {
      if (step.k === "op") {
        const child = state.child();
        step.g.op.effects.apply(child, step.g.b, TIMINGS_PLANNING);
        const dur = step.g.op.duration.fn(state, step.g.b);
        if (dur !== 0) child.set(CLOCK_SLOT, state.get(CLOCK_SLOT) + dur);
        state = child;
      } else if (step.k === "wait") {
        const child = state.child();
        child.set(CLOCK_SLOT, Math.max(state.get(CLOCK_SLOT), step.until));
        state = child;
      }
    }
  }
  return { ok: diagnoses.length === 0, end: state, diagnoses };
}

/** Human/LLM-readable plan listing. */
export function planSummary(model: Model, plan: Plan): string[] {
  return plan.steps.map((s, i) => {
    const label = stepLabel(model, s);
    if (s.k === "op") return `${i}. ${label} [t=${s.projStart.toFixed(2)}→${s.projEnd.toFixed(2)}s]`;
    return `${i}. ${label}`;
  });
}

/** Render a failed planning result's rejection log as readable reasons. */
export function explainFailure(result: PlanResult): string[] {
  if (result.status === "success") return [];
  if (!result.rejections || result.rejections.length === 0) {
    return ["planning failed (enable collectRejections for detailed reasons)"];
  }
  const counts = new Map<string, number>();
  for (const r of result.rejections) {
    const key = `${r.at}: ${r.reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => (n > 1 ? `${key} (×${n})` : key));
}

export type { Bindings };
