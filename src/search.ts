/**
 * Unified search core (SPEC §7): one engine processes a totally-ordered agenda
 * of tasks (decomposed via methods), operators, inline goals (solved by
 * weighted-A* over ground operators with an h_add relaxation heuristic and
 * novelty tie-breaking), waits, and scopes (deadline/maintain — enforced
 * against the projected clock, SPEC §4.13).
 *
 * Search runs inside generators and yields periodically so sessions can be
 * budgeted by milliseconds or node counts and resumed across ticks (SPEC §7.4).
 */

import {
  Atom,
  Bindings,
  CompiledFormula,
  CompiledMethod,
  CompiledOperator,
  CompiledScopeTmpl,
  CompiledSubtask,
  GroundOp,
  Model,
  TIMINGS_PLANNING,
} from "./compile";
import { GoalSpec } from "./ir";
import { CLOCK_SLOT, Snap, StateView } from "./state";

// ---------------------------------------------------------------- agenda

export interface ScopeInstance {
  id: number;
  label: string;
  /** relative deadline seconds, evaluated at scope entry (null = none) */
  deadlineRel: number | null;
  /** absolute projected clock bound while planning */
  deadlineAbs: number | null;
  enterClock: number;
  maintain: ((s: Snap) => boolean) | null;
  maintainReads: Set<number>;
  minHold: number;
  onExit: string | undefined;
}

export type AgendaItem =
  | { k: "task"; name: string; args: Bindings }
  | { k: "op"; op: CompiledOperator; args: Bindings }
  | { k: "goal"; fn: (s: Snap) => boolean; atoms: Atom[]; reads: Set<number>; readsClock: boolean; label: string }
  | { k: "scopeEnter"; tmpl: CompiledScopeTmpl; b: Bindings; instance?: ScopeInstance }
  | { k: "scopeExit"; forEnter: { k: "scopeEnter"; tmpl: CompiledScopeTmpl; b: Bindings; instance?: ScopeInstance } }
  | { k: "waitUntil"; t: (s: Snap) => number; label: string }
  | { k: "hold"; t: (s: Snap) => number; label: string };

export type Agenda = null | { head: AgendaItem; tail: Agenda };

export function cons(head: AgendaItem, tail: Agenda): Agenda {
  return { head, tail };
}

export function agendaFrom(items: AgendaItem[], tail: Agenda = null): Agenda {
  let a = tail;
  for (let i = items.length - 1; i >= 0; i--) a = cons(items[i], a);
  return a;
}

function agendaSignature(agenda: Agenda): string {
  const parts: string[] = [];
  let cur = agenda;
  let n = 0;
  while (cur && n < 64) {
    const h = cur.head;
    switch (h.k) {
      case "task": parts.push(`t:${h.name}(${h.args.join(",")})`); break;
      case "op": parts.push(`o:${h.op.id}(${h.args.join(",")})`); break;
      case "goal": parts.push(`g:${h.label}`); break;
      case "scopeEnter": parts.push("se"); break;
      case "scopeExit": parts.push("sx"); break;
      case "waitUntil": parts.push("w"); break;
      case "hold": parts.push("h"); break;
    }
    cur = cur.tail;
    n++;
  }
  return parts.join("|");
}

// ---------------------------------------------------------------- plans

export type PlanStep =
  | { k: "op"; g: GroundOp; projStart: number; projEnd: number; agendaBefore: Agenda }
  | { k: "scopeEnter"; scope: ScopeInstance; agendaBefore: Agenda }
  | { k: "scopeExit"; scope: ScopeInstance; agendaBefore: Agenda }
  | { k: "wait"; until: number; label: string; agendaBefore: Agenda };

export interface Plan {
  steps: PlanStep[];
  /** method-traversal record: chosen candidate index at every compound decision */
  mtr: number[];
  cost: number;
  startClock: number;
  makespan: number;
  /** fluent ids the plan's conditions depend on (precise replan triggers) */
  readFluents: Set<number>;
  readsClock: boolean;
}

export interface Rejection {
  at: string;
  reason: string;
}

export interface PlanRequest {
  goals: GoalSpec[];
  /** MTR of the currently-running plan; candidate plans must beat it (FluidHTN semantics) */
  lastMTR?: number[];
  /** weighted-A* weight for goal searches (1 = admissible-ish, >1 = greedier) */
  weight?: number;
  maxNodes?: number;
  maxDepth?: number;
  collectRejections?: boolean;
  /** novelty tie-breaking on goal-search open lists */
  novelty?: boolean;
  /** goal-search heuristic: h_add (fast, may overestimate — default), h_max (admissible: use with weight 1 for guaranteed-optimal plans), or none (Dijkstra) */
  heuristic?: "hadd" | "hmax" | "none";
  /** internal: plan a pre-built agenda instead of `goals` (used by plan repair) */
  agendaOverride?: Agenda;
}

export interface PlanResult {
  status: "success" | "failure";
  plan?: Plan;
  rejections?: Rejection[];
  stats: { decompositions: number; expansions: number; heuristicEvals: number };
}

// ---------------------------------------------------------------- binary heap

interface HeapNode {
  f: number;
  novelty: number;
  g: number;
  seq: number;
  state: StateView;
  ops: GroundOp[] | null; // path as parent-pointer alternative kept simple: full path arrays are fine at v0 scale
  parent: HeapNode | null;
  via: GroundOp | null;
}

class Heap {
  private items: HeapNode[] = [];

  get size(): number {
    return this.items.length;
  }

  push(n: HeapNode): void {
    const a = this.items;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (Heap.less(a[i], a[p])) {
        [a[i], a[p]] = [a[p], a[i]];
        i = p;
      } else break;
    }
  }

  pop(): HeapNode | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop() as HeapNode;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && Heap.less(a[l], a[m])) m = l;
        if (r < a.length && Heap.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }

  private static less(a: HeapNode, b: HeapNode): boolean {
    if (a.f !== b.f) return a.f < b.f;
    if (a.novelty !== b.novelty) return a.novelty < b.novelty;
    if (a.g !== b.g) return a.g > b.g; // prefer more progress
    return a.seq < b.seq;
  }
}

// ---------------------------------------------------------------- h_add / h_max relaxation heuristic

/** A goal atom resolved against the model's interned relaxation atoms. */
interface GoalAtomDesc {
  /** interned relaxation-atom id, or -1 if no ground operator references this atom */
  id: number;
  slot: number;
  value: number;
  fuzzy: boolean;
}

/** Resolve goal atoms to interned descriptors once (cold path, per goal search). */
function goalDescs(model: Model, goalAtoms: Atom[]): GoalAtomDesc[] {
  const out: GoalAtomDesc[] = new Array(goalAtoms.length);
  for (let i = 0; i < goalAtoms.length; i++) {
    const a = goalAtoms[i];
    const owner = model.slotOwner[a.slot];
    out[i] = {
      id: model.relaxAtomId(a.slot, a.value),
      slot: a.slot,
      value: a.value,
      fuzzy: owner >= 0 && model.relaxFuzzyWrites.has(owner),
    };
  }
  return out;
}

/**
 * Delete-relaxation heuristic over ground operators (unit action costs), computed
 * over compile-time interned atom ids into a reusable numeric cost buffer — no
 * per-atom string keys or maps on the hot path.
 *
 *   add=true  → h_add (informative, may overestimate / inadmissible)
 *   add=false → h_max (admissible; pair with weight 1 for optimal plans)
 *
 * Numeric/external/negative conditions are treated optimistically: a "fuzzy"
 * atom (written non-atomically by some operator) can take any value at cost 1 and
 * is never called unreachable. Semantics match the original Map-based version.
 */
function relaxCore(model: Model, s: Snap, cost: Float64Array, goals: GoalAtomDesc[], add: boolean): number {
  const n = model.relaxAtomCount;
  const slot = model.relaxAtomSlot;
  const val = model.relaxAtomValue;
  const fuzzy = model.relaxAtomFuzzy;

  // seed: an atom that currently holds costs 0, everything else starts unreachable
  for (let id = 0; id < n; id++) cost[id] = s.get(slot[id]) === val[id] ? 0 : Infinity;

  // already satisfied? (mirrors the original missing===0 early-out)
  let allHold = true;
  for (let i = 0; i < goals.length; i++) {
    const g = goals[i];
    if (!(g.id >= 0 ? cost[g.id] === 0 : s.get(g.slot) === g.value)) {
      allHold = false;
      break;
    }
  }
  if (allHold) return 0;

  // relaxed fixpoint: an op fires once all its preconditions are reachable,
  // lifting its add atoms to (combined precondition cost) + 1
  const ops = model.groundOps;
  let changed = true;
  let rounds = 0;
  while (changed && rounds < 64) {
    changed = false;
    rounds++;
    for (let oi = 0; oi < ops.length; oi++) {
      const addIds = ops[oi].addIds as Int32Array;
      if (addIds.length === 0) continue;
      const preIds = ops[oi].preIds as Int32Array;
      let pc = 0;
      let inf = false;
      for (let i = 0; i < preIds.length; i++) {
        const pid = preIds[i];
        let c = cost[pid];
        if (c === Infinity) c = fuzzy[pid] ? 1 : Infinity;
        if (c === Infinity) {
          inf = true;
          break;
        }
        pc = add ? pc + c : c > pc ? c : pc;
      }
      if (inf) continue;
      const through = pc + 1;
      for (let i = 0; i < addIds.length; i++) {
        const aid = addIds[i];
        if (through < cost[aid]) {
          cost[aid] = through;
          changed = true;
        }
      }
    }
  }

  // combine the (effective) cost of each goal atom
  let h = 0;
  for (let i = 0; i < goals.length; i++) {
    const g = goals[i];
    let c: number;
    if (g.id >= 0) {
      c = cost[g.id];
      if (c === Infinity) c = g.fuzzy ? 1 : Infinity;
    } else {
      c = s.get(g.slot) === g.value ? 0 : g.fuzzy ? 1 : Infinity;
    }
    if (c === Infinity) return Infinity;
    h = add ? h + c : c > h ? c : h;
  }
  return h;
}

/**
 * Public delete-relaxation heuristic (SPEC §7.3). Builds goal descriptors and a
 * scratch buffer per call; the Engine uses a faster path that reuses both.
 */
export function hAdd(model: Model, s: Snap, goalAtoms: Atom[], mode: "add" | "max" = "add"): number {
  if (goalAtoms.length === 0) return 0;
  const cost = new Float64Array(model.relaxAtomCount);
  return relaxCore(model, s, cost, goalDescs(model, goalAtoms), mode === "add");
}

// ---------------------------------------------------------------- engine

interface MtrCursor {
  last: number[] | null;
  pos: number;
  stillEqual: boolean;
}

interface SeekOutcome {
  state: StateView;
  steps: PlanStep[];
  cost: number;
}

export class Engine {
  private readonly model: Model;
  private readonly req: Required<Pick<PlanRequest, "weight" | "maxNodes" | "maxDepth" | "novelty" | "heuristic">> & PlanRequest;
  public decompositions = 0;
  public expansions = 0;
  public heuristicEvals = 0;
  public rejections: Rejection[] = [];
  private mtr: number[] = [];
  private mtrCursor: MtrCursor;
  private scopeIds = 0;
  private readonly pathKeys = new Set<string>();
  private readonly hCache = new Map<number, number>();
  /** reusable relaxation cost buffer (sized to model.relaxAtomCount) */
  private costBuf: Float64Array | null = null;

  constructor(model: Model, req: PlanRequest) {
    this.model = model;
    this.req = {
      ...req,
      weight: req.weight ?? 1.4,
      maxNodes: req.maxNodes ?? 50_000,
      maxDepth: req.maxDepth ?? 400,
      novelty: req.novelty ?? true,
      heuristic: req.heuristic ?? "hadd",
    };
    this.mtrCursor = { last: req.lastMTR && req.lastMTR.length > 0 ? req.lastMTR : null, pos: 0, stillEqual: req.lastMTR !== undefined && (req.lastMTR?.length ?? 0) > 0 };
  }

  private reject(at: string, reason: string): void {
    if (this.req.collectRejections && this.rejections.length < 512) this.rejections.push({ at, reason });
  }

  /** Build the initial agenda from goal specs. */
  buildAgenda(goals: GoalSpec[]): Agenda {
    const items: AgendaItem[] = goals.map((g) => {
      if (g.kind === "task") {
        const args = (g.args ?? []).map((a) => {
          if (typeof a === "string" && !a.startsWith("?")) return this.model.entityId(a);
          if (typeof a === "number") return a;
          throw new Error(`Top-level task '${g.name}' requires concrete entity arguments`);
        });
        const op = this.model.operatorByName.get(g.name);
        if (op) return { k: "op", op, args };
        if (!this.model.methodsByTask.has(g.name)) throw new Error(`Unknown task '${g.name}'`);
        return { k: "task", name: g.name, args };
      }
      const cond = this.model.compileFormula(g.condition, new Map(), "goal");
      return {
        k: "goal",
        fn: (s: Snap) => cond.fn(s, []),
        atoms: cond.atoms([]),
        reads: cond.reads,
        readsClock: cond.readsClock,
        label: "goal",
      };
    });
    return agendaFrom(items);
  }

  *seek(state: StateView, agenda: Agenda, scopes: ScopeInstance[], depth: number): Generator<void, SeekOutcome | null, void> {
    if (agenda === null) return { state, steps: [], cost: 0 };
    if (depth > this.req.maxDepth) {
      this.reject("engine", `max decomposition depth ${this.req.maxDepth} exceeded`);
      return null;
    }
    this.decompositions++;
    if (this.decompositions % 16 === 0) yield;

    const item = agenda.head;
    const rest = agenda.tail;

    switch (item.k) {
      case "op": {
        const { op, args } = item;
        if (op.pre && !op.pre.fn(state, args)) {
          this.reject(op.name, "precondition failed");
          return null;
        }
        const child = state.child();
        op.effects.apply(child, args, TIMINGS_PLANNING);
        const dur = op.duration.fn(state, args);
        const start = state.get(CLOCK_SLOT);
        if (dur !== 0) child.set(CLOCK_SLOT, start + dur);
        if (!this.scopesOk(child, scopes, op.name)) return null;
        const g: GroundOp = { gid: -1, op, b: args, preAtoms: [], addAtoms: [] };
        const step: PlanStep = { k: "op", g, projStart: start, projEnd: start + dur, agendaBefore: agenda };
        const sub = yield* this.seek(child, rest, scopes, depth + 1);
        if (!sub) return null;
        return { state: sub.state, steps: [step, ...sub.steps], cost: op.cost.fn(state, args) + sub.cost };
      }

      case "waitUntil":
      case "hold": {
        const now = state.get(CLOCK_SLOT);
        const target = item.k === "waitUntil" ? item.t(state) : now + item.t(state);
        const until = Math.max(now, target);
        const child = state.child();
        child.set(CLOCK_SLOT, until);
        if (!this.scopesOk(child, scopes, item.label)) return null;
        const step: PlanStep = { k: "wait", until, label: item.label, agendaBefore: agenda };
        const sub = yield* this.seek(child, rest, scopes, depth + 1);
        if (!sub) return null;
        return { state: sub.state, steps: [step, ...sub.steps], cost: sub.cost };
      }

      case "scopeEnter": {
        const now = state.get(CLOCK_SLOT);
        const rel = item.tmpl.deadline ? item.tmpl.deadline.fn(state, item.b) : null;
        const instance: ScopeInstance = {
          id: this.scopeIds++,
          label: item.tmpl.label,
          deadlineRel: rel,
          deadlineAbs: rel === null ? null : now + rel,
          enterClock: now,
          maintain: item.tmpl.maintain ? ((s: Snap) => (item.tmpl.maintain as CompiledFormula).fn(s, item.b)) : null,
          maintainReads: item.tmpl.maintain?.reads ?? new Set(),
          minHold: item.tmpl.minHold,
          onExit: item.tmpl.onExit,
        };
        item.instance = instance;
        if (instance.maintain && !instance.maintain(state)) {
          this.reject(instance.label, "maintain condition false at scope entry");
          return null;
        }
        const step: PlanStep = { k: "scopeEnter", scope: instance, agendaBefore: agenda };
        const sub = yield* this.seek(state, rest, [...scopes, instance], depth + 1);
        if (!sub) return null;
        return { state: sub.state, steps: [step, ...sub.steps], cost: sub.cost };
      }

      case "scopeExit": {
        const instance = item.forEnter.instance;
        if (!instance) throw new Error("scopeExit before scopeEnter");
        let child = state;
        const now = state.get(CLOCK_SLOT);
        const heldFor = now - instance.enterClock;
        if (heldFor < instance.minHold) {
          child = state.child();
          child.set(CLOCK_SLOT, instance.enterClock + instance.minHold);
          if (!this.scopesOk(child, scopes, instance.label)) return null;
        }
        const remaining = scopes.filter((sc) => sc.id !== instance.id);
        const step: PlanStep = { k: "scopeExit", scope: instance, agendaBefore: agenda };
        const sub = yield* this.seek(child, rest, remaining, depth + 1);
        if (!sub) return null;
        return { state: sub.state, steps: [step, ...sub.steps], cost: sub.cost };
      }

      case "goal": {
        if (item.fn(state)) {
          return yield* this.seek(state, rest, scopes, depth + 1);
        }
        const found = yield* this.goalSearch(state, item, scopes);
        if (!found) {
          this.reject(item.label, "goal search exhausted");
          return null;
        }
        // stamp the goal agenda on the searched steps so repair can re-achieve from any point
        for (const st of found.steps) {
          if (st.agendaBefore === null) st.agendaBefore = agenda;
        }
        const sub = yield* this.seek(found.state, rest, scopes, depth + 1);
        if (!sub) return null;
        return { state: sub.state, steps: [...found.steps, ...sub.steps], cost: found.cost + sub.cost };
      }

      case "task": {
        const key = `${state.key()}|${agendaSignature(agenda)}`;
        if (this.pathKeys.has(key)) {
          this.reject(item.name, "decomposition cycle");
          return null;
        }
        this.pathKeys.add(key);
        try {
          return yield* this.expandTask(state, item, rest, agenda, scopes, depth);
        } finally {
          this.pathKeys.delete(key);
        }
      }
    }
  }

  private *expandTask(
    state: StateView,
    item: { k: "task"; name: string; args: Bindings },
    rest: Agenda,
    full: Agenda,
    scopes: ScopeInstance[],
    depth: number,
  ): Generator<void, SeekOutcome | null, void> {
    const methods = this.model.methodsByTask.get(item.name);
    if (!methods || methods.length === 0) {
      this.reject(item.name, "no methods");
      return null;
    }

    // candidates = methods × free-parameter bindings, ordered by utility (desc, stable)
    interface Candidate {
      method: CompiledMethod;
      b: Bindings;
      utility: number;
    }
    const candidates: Candidate[] = [];
    for (const method of methods) {
      for (const free of this.model.freeBindings(method)) {
        const b = [...item.args, ...free];
        const utility = method.utility ? method.utility.fn(state, b) : 0;
        candidates.push({ method, b, utility });
      }
    }
    const anyUtility = methods.some((m) => m.utility !== null);
    if (anyUtility) {
      candidates.sort((a, b) => b.utility - a.utility); // Array.prototype.sort is stable
    }

    const cursor = this.mtrCursor;
    const decisionPos = this.mtr.length;
    const constrained = cursor.stillEqual && cursor.last !== null && decisionPos < cursor.last.length;
    const maxIdx = constrained ? (cursor.last as number[])[decisionPos] : Infinity;

    for (let idx = 0; idx < candidates.length; idx++) {
      if (idx > maxIdx) {
        this.reject(item.name, "pruned by MTR (cannot beat running plan)");
        break;
      }
      const cand = candidates[idx];
      if (cand.method.pre && !cand.method.pre.fn(state, cand.b)) {
        this.reject(cand.method.label, "method precondition failed");
        continue;
      }

      const wasEqual = cursor.stillEqual;
      cursor.stillEqual = constrained ? wasEqual && idx === maxIdx : false;
      this.mtr.push(idx);

      const expanded = this.instantiateSubtasks(cand.method.subtasks, cand.b);
      const agenda = agendaFrom(expanded, rest);
      const sub = yield* this.seek(state, agenda, scopes, depth + 1);
      if (sub) return sub;

      this.mtr.pop();
      cursor.stillEqual = wasEqual;
    }
    return null;
  }

  private instantiateSubtasks(subtasks: CompiledSubtask[], b: Bindings): AgendaItem[] {
    const out: AgendaItem[] = [];
    const resolveArgs = (sources: { v?: number; c?: number }[]): Bindings =>
      sources.map((s) => ("c" in s && s.c !== undefined ? s.c : b[s.v as number]));
    const emit = (st: CompiledSubtask): void => {
      switch (st.k) {
        case "op":
          out.push({ k: "op", op: st.op, args: resolveArgs(st.args) });
          return;
        case "compound":
          out.push({ k: "task", name: st.name, args: resolveArgs(st.args) });
          return;
        case "goal": {
          const cond = st.cond;
          out.push({
            k: "goal",
            fn: (s: Snap) => cond.fn(s, b),
            atoms: cond.atoms(b),
            reads: cond.reads,
            readsClock: cond.readsClock,
            label: "achieve",
          });
          return;
        }
        case "waitUntil":
          out.push({ k: "waitUntil", t: (s: Snap) => st.t.fn(s, b), label: "waitUntil" });
          return;
        case "hold":
          out.push({ k: "hold", t: (s: Snap) => st.t.fn(s, b), label: "hold" });
          return;
        case "scope": {
          const enter: AgendaItem = { k: "scopeEnter", tmpl: st.scope, b };
          out.push(enter);
          st.subtasks.forEach(emit);
          out.push({ k: "scopeExit", forEnter: enter as { k: "scopeEnter"; tmpl: CompiledScopeTmpl; b: Bindings; instance?: ScopeInstance } });
          return;
        }
      }
    };
    subtasks.forEach(emit);
    return out;
  }

  private scopesOk(state: Snap, scopes: ScopeInstance[], at: string): boolean {
    for (const sc of scopes) {
      if (sc.deadlineAbs !== null && state.get(CLOCK_SLOT) > sc.deadlineAbs + 1e-9) {
        this.reject(at, `deadline of ${sc.label} exceeded (projected clock ${state.get(CLOCK_SLOT).toFixed(2)}s > ${sc.deadlineAbs.toFixed(2)}s)`);
        return false;
      }
      if (sc.maintain && !sc.maintain(state)) {
        this.reject(at, `maintain condition of ${sc.label} violated`);
        return false;
      }
    }
    return true;
  }

  // ---------------- goal search (weighted A* + novelty)

  private *goalSearch(
    start: StateView,
    item: { fn: (s: Snap) => boolean; atoms: Atom[]; label: string },
    scopes: ScopeInstance[],
  ): Generator<void, SeekOutcome | null, void> {
    const model = this.model;
    const weight = this.req.weight;
    const open = new Heap();
    const closed = new Map<number, number>();
    const seenAtoms = new Set<number>();
    const descs = goalDescs(model, item.atoms);
    let seq = 0;

    const h0 = this.heuristic(start, descs);
    if (h0 === Infinity && item.atoms.length > 0) {
      this.reject(item.label, "goal unreachable under relaxation");
      return null;
    }
    open.push({ f: weight * h0, novelty: 0, g: 0, seq: seq++, state: start, ops: null, parent: null, via: null });
    closed.set(start.key(), 0);

    while (open.size > 0) {
      this.expansions++;
      if (this.expansions % 16 === 0) yield;
      if (this.expansions > this.req.maxNodes) {
        this.reject(item.label, `goal search node budget (${this.req.maxNodes}) exhausted`);
        return null;
      }
      const node = open.pop() as HeapNode;

      if (item.fn(node.state)) {
        // reconstruct path
        const ops: { g: GroundOp; start: number; end: number }[] = [];
        let cur: HeapNode | null = node;
        while (cur && cur.via) {
          const prevClock = cur.parent ? cur.parent.state.get(CLOCK_SLOT) : 0;
          ops.unshift({ g: cur.via, start: prevClock, end: cur.state.get(CLOCK_SLOT) });
          cur = cur.parent;
        }
        const steps: PlanStep[] = ops.map((o) => ({ k: "op", g: o.g, projStart: o.start, projEnd: o.end, agendaBefore: null }));
        return { state: node.state, steps, cost: node.g };
      }

      for (const g of model.groundOps) {
        if (g.op.pre && !g.op.pre.fn(node.state, g.b)) continue;
        const child = node.state.child();
        g.op.effects.apply(child, g.b, TIMINGS_PLANNING);
        const dur = g.op.duration.fn(node.state, g.b);
        if (dur !== 0) child.set(CLOCK_SLOT, node.state.get(CLOCK_SLOT) + dur);
        if (!this.scopesOkQuiet(child, scopes)) continue;
        const key = child.key();
        const cost = g.op.cost.fn(node.state, g.b);
        const g2 = node.g + (cost > 0 ? cost : 1e-6);
        const known = closed.get(key);
        if (known !== undefined && known <= g2) continue;
        closed.set(key, g2);
        const h = this.heuristic(child, descs);
        if (h === Infinity) continue;
        let novelty = 1;
        if (this.req.novelty) {
          const addIds = g.addIds as Int32Array;
          for (let i = 0; i < addIds.length; i++) {
            const aid = addIds[i];
            if (!seenAtoms.has(aid)) {
              seenAtoms.add(aid);
              novelty = 0;
            }
          }
        }
        open.push({ f: g2 + weight * h, novelty, g: g2, seq: seq++, state: child, ops: null, parent: node, via: g });
      }
    }
    this.reject(item.label, "goal search exhausted open list");
    return null;
  }

  private scopesOkQuiet(state: Snap, scopes: ScopeInstance[]): boolean {
    for (const sc of scopes) {
      if (sc.deadlineAbs !== null && state.get(CLOCK_SLOT) > sc.deadlineAbs + 1e-9) return false;
      if (sc.maintain && !sc.maintain(state)) return false;
    }
    return true;
  }

  private heuristic(state: StateView, descs: GoalAtomDesc[]): number {
    if (descs.length === 0 || this.req.heuristic === "none") return 0;
    const key = state.key();
    const cached = this.hCache.get(key);
    if (cached !== undefined) return cached;
    this.heuristicEvals++;
    const n = this.model.relaxAtomCount;
    if (!this.costBuf || this.costBuf.length !== n) this.costBuf = new Float64Array(n);
    const h = relaxCore(this.model, state, this.costBuf, descs, this.req.heuristic !== "hmax");
    this.hCache.set(key, h);
    return h;
  }

  finishPlan(outcome: SeekOutcome, startClock: number): Plan {
    const readFluents = new Set<number>();
    let readsClock = false;
    for (const step of outcome.steps) {
      if (step.k === "op") {
        for (const r of step.g.op.pre?.reads ?? []) readFluents.add(r);
        for (const r of step.g.op.verify?.reads ?? []) readFluents.add(r);
        if (step.g.op.pre?.readsClock || step.g.op.verify?.readsClock) readsClock = true;
      } else if (step.k === "scopeEnter") {
        for (const r of step.scope.maintainReads) readFluents.add(r);
        if (step.scope.deadlineAbs !== null) readsClock = true;
      } else if (step.k === "wait") {
        readsClock = true;
      }
    }
    return {
      steps: outcome.steps,
      mtr: this.mtr.slice(),
      cost: outcome.cost,
      startClock,
      makespan: outcome.state.get(CLOCK_SLOT) - startClock,
      readFluents,
      readsClock,
    };
  }

  /** After a successful seek: reject plans identical to the running plan (FluidHTN). */
  isEqualToLast(): boolean {
    const last = this.mtrCursor.last;
    if (!last) return false;
    if (this.mtr.length !== last.length) return false;
    for (let i = 0; i < this.mtr.length; i++) {
      if (this.mtr[i] < last[i]) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------- sessions

export interface StepBudget {
  ms?: number;
  nodes?: number;
}

export class PlanningSession {
  private readonly engine: Engine;
  private readonly gen: Generator<void, SeekOutcome | null, void>;
  private readonly startClock: number;
  private result: PlanResult | null = null;
  private readonly collectRejections: boolean;

  constructor(model: Model, start: Snap, req: PlanRequest) {
    this.engine = new Engine(model, req);
    const view = start instanceof StateView ? start : StateView.fromBase((start as { buffer?: Float64Array }).buffer?.slice() ?? copySnap(start, model));
    this.startClock = view.get(CLOCK_SLOT);
    const agenda = req.agendaOverride ?? this.engine.buildAgenda(req.goals);
    this.gen = this.engine.seek(view, agenda, [], 0);
    this.collectRejections = req.collectRejections ?? false;
  }

  get done(): boolean {
    return this.result !== null;
  }

  /** Pump the search until the budget is exhausted or a result is found. */
  step(budget: StepBudget = {}): PlanResult | null {
    if (this.result) return this.result;
    const deadline = budget.ms !== undefined ? now() + budget.ms : Infinity;
    const nodeCap = budget.nodes !== undefined ? this.engine.decompositions + this.engine.expansions + budget.nodes : Infinity;
    for (;;) {
      const r = this.gen.next();
      if (r.done) {
        const outcome = r.value;
        const stats = {
          decompositions: this.engine.decompositions,
          expansions: this.engine.expansions,
          heuristicEvals: this.engine.heuristicEvals,
        };
        if (outcome && !this.engine.isEqualToLast()) {
          this.result = { status: "success", plan: this.engine.finishPlan(outcome, this.startClock), stats };
        } else {
          this.result = {
            status: "failure",
            rejections: this.collectRejections ? this.engine.rejections : undefined,
            stats,
          };
        }
        return this.result;
      }
      if (now() >= deadline) return null;
      if (this.engine.decompositions + this.engine.expansions >= nodeCap) return null;
    }
  }
}

function copySnap(s: Snap, model: Model): Float64Array {
  const out = new Float64Array(model.slotCount);
  for (let i = 0; i < out.length; i++) out[i] = s.get(i);
  return out;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Plan to completion (no budget). */
export function planOnce(model: Model, start: Snap, req: PlanRequest): PlanResult {
  const session = new PlanningSession(model, start, req);
  for (;;) {
    const r = session.step({ nodes: 1_000_000 });
    if (r) return r;
  }
}
