/**
 * htn-ai v2 — real-time planning & execution runtime for TypeScript agents.
 *
 * Pipeline: DomainDoc (IR, ./ir) → Model (compile, ./compile) → PlanningSession /
 * planOnce (search, ./search) → Planner / Scheduler (exec, ./exec), with
 * validation & explanation in ./trace. See SPEC.md for the design.
 */

// IR: domain documents, formulas, effects, helpers
export {
  type TypeDecl,
  type ParamDecl,
  type FluentKind,
  type FluentDecl,
  type Term,
  type TermLike,
  type NumExpr,
  type NumLike,
  type Formula,
  type CmpOp,
  type EffectExpr,
  type EffectTiming,
  type OperatorDecl,
  type CompoundDecl,
  type ScopeDecl,
  type SubtaskDef,
  type MethodDecl,
  type AxiomDecl,
  type DomainDoc,
  type GoalSpec,
  type Diagnostic,
  DomainError,
  F,
  N,
  E,
  T,
  term,
  terms,
  num,
  task,
  goal,
  doTask,
  achieve,
  scoped,
  validateDomain,
  printFormula,
  printNum,
  printTerm,
  domainToJSON,
  domainFromJSON,
} from "./ir";

// Compilation: model, registry, executors, externals
export {
  Model,
  createModel,
  type Bindings,
  type Registry,
  type WorldSetup,
  type EntitySpec,
  type InitWriter,
  type TaskStatus,
  type ExecutorApi,
  type ExecutorFn,
  type ExtQuery,
  type ExtWriter,
  type ExternalPredicate,
  type ExternalNumeric,
  type ExternalEffect,
  type CompiledOperator,
  type GroundOp,
  type Atom,
  TIMINGS_PLANNING,
  TIMINGS_EXECUTION,
} from "./compile";

// State runtime
export { CLOCK_SLOT, StateView, ExecState, type Snap } from "./state";

// Search: sessions, plans
export {
  PlanningSession,
  planOnce,
  hAdd,
  type Plan,
  type PlanStep,
  type PlanRequest,
  type PlanResult,
  type StepBudget,
  type Rejection,
  type Agenda,
  type AgendaItem,
  type ScopeInstance,
} from "./search";

// Execution: reactive planner + multi-agent scheduler
export {
  Planner,
  Scheduler,
  stepLabel,
  type PlannerOptions,
  type PlannerStatus,
  type TraceEvent,
  type TraceFn,
} from "./exec";

// Validation & explanation
export { validatePlan, simulatePlan, applicableActions, planSummary, explainFailure, type PlanDiagnosis } from "./trace";

// Determinism
export { createRng, type Rng } from "./rng";
