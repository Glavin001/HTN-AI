/**
 * Compilation pipeline (SPEC §5): validate → intern entities → lay out packed
 * slots → compile formula/effect evaluators (monomorphic closures over slots)
 * → enumerate ground operators → extract relaxation atoms for heuristics.
 */

import {
  AxiomDecl,
  Diagnostic,
  DomainDoc,
  DomainError,
  EffectExpr,
  FluentDecl,
  Formula,
  MethodDecl,
  NumExpr,
  OperatorDecl,
  ParamDecl,
  ScopeDecl,
  SubtaskDef,
  Term,
  TypeName,
  num,
  terms,
  validateDomain,
  varKey,
} from "./ir";
import { CLOCK_SLOT, ExecState, Snap } from "./state";
import { Rng } from "./rng";

export type Bindings = number[];

// ---------------------------------------------------------------- executor & external types

export type TaskStatus = "success" | "failure" | "continue";

export interface ExecutorApi {
  /** entity gids bound to the operator's parameters */
  args: Bindings;
  model: Model;
  read(fluent: string, ...args: (number | string)[]): number;
  write(fluent: string, args: (number | string)[], value: number | string | boolean): void;
  /** execution clock, seconds since the context epoch */
  clock(): number;
  /** seconds elapsed since this step started executing */
  elapsedInStep(): number;
  rng: Rng;
  /** per-step scratch storage (reset when the step changes) */
  remember<T>(init: () => T): T;
}

export type ExecutorFn = (api: ExecutorApi) => TaskStatus | Promise<TaskStatus>;

export interface ExtQuery {
  args: Bindings;
  get(fluent: string, ...args: (number | string)[]): number;
  vec(fluent: string, ...args: (number | string)[]): number[];
  clock(): number;
  gid(name: string): number;
  name(gid: number): string;
}

export interface ExtWriter extends ExtQuery {
  set(fluent: string, args: (number | string)[], value: number | string | boolean): void;
}

export type ExternalPredicate = (q: ExtQuery) => boolean;
export type ExternalNumeric = (q: ExtQuery) => number;
export type ExternalEffect = (w: ExtWriter) => void;
export type OpaquePredicate = (q: ExtQuery) => boolean;

export interface Registry {
  executors?: Record<string, ExecutorFn>;
  predicates?: Record<string, ExternalPredicate | OpaquePredicate>;
  numerics?: Record<string, ExternalNumeric>;
  effects?: Record<string, ExternalEffect>;
}

// ---------------------------------------------------------------- compiled shapes

export interface Atom {
  slot: number;
  value: number;
}

export interface CompiledFormula {
  fn: (s: Snap, b: Bindings) => boolean;
  /** fluent ids read (T1 + declared T2 reads); used for precise replan triggers */
  reads: Set<number>;
  readsClock: boolean;
  /** positive conjunctive lit atoms (for h_add); skipped parts make h more optimistic */
  atoms: (b: Bindings) => Atom[];
  ir: Formula;
}

export interface CompiledNum {
  fn: (s: Snap, b: Bindings) => number;
  reads: Set<number>;
}

export const TIMING_PLAN_ONLY = 1;
export const TIMING_PLAN_AND_EXECUTE = 2;
export const TIMING_PERMANENT = 4;
export const TIMINGS_PLANNING = TIMING_PLAN_ONLY | TIMING_PLAN_AND_EXECUTE | TIMING_PERMANENT;
export const TIMINGS_EXECUTION = TIMING_PLAN_AND_EXECUTE | TIMING_PERMANENT;

export interface WritableState {
  get(slot: number): number;
  set(slot: number, value: number): void;
}

export interface CompiledEffects {
  apply: (target: WritableState, b: Bindings, timingMask: number) => void;
  writes: Set<number>;
  addAtoms: (b: Bindings) => Atom[];
  /** fluents written by effects that cannot be expressed as atoms (NumExpr sets,
   *  inc/dec, setVec, externals) — the relaxation must not call these unreachable */
  fuzzyWrites: Set<number>;
}

export interface CompiledOperator {
  id: number;
  name: string;
  decl: OperatorDecl;
  paramTypes: TypeName[];
  pre: CompiledFormula | null;
  verify: CompiledFormula | null;
  effects: CompiledEffects;
  cost: CompiledNum;
  duration: CompiledNum;
  executor: string | undefined;
}

export interface GroundOp {
  gid: number;
  op: CompiledOperator;
  b: Bindings;
  preAtoms: Atom[];
  addAtoms: Atom[];
}

export interface CompiledScopeTmpl {
  deadline: CompiledNum | null;
  maintain: CompiledFormula | null;
  minHold: number;
  onExit: string | undefined;
  label: string;
}

export type CompiledSubtask =
  | { k: "op"; op: CompiledOperator; args: ArgSource[] }
  | { k: "compound"; name: string; args: ArgSource[] }
  | { k: "goal"; cond: CompiledFormula }
  | { k: "scope"; scope: CompiledScopeTmpl; subtasks: CompiledSubtask[] }
  | { k: "waitUntil"; t: CompiledNum }
  | { k: "hold"; t: CompiledNum };

export type ArgSource = { v: number } | { c: number };

export interface CompiledMethod {
  /** position among its task's methods, in declared order (MTR semantics) */
  index: number;
  decl: MethodDecl;
  task: string;
  label: string;
  taskParams: ParamDecl[];
  freeParams: ParamDecl[];
  pre: CompiledFormula | null;
  utility: CompiledNum | null;
  subtasks: CompiledSubtask[];
}

interface CompiledFluent {
  id: number;
  decl: FluentDecl;
  base: number;
  width: number;
  paramTypes: TypeName[];
  strides: number[];
  size: number; // number of value cells (excluding width)
}

interface CompiledAxiom {
  decl: AxiomDecl;
  fn: (s: Snap, args: Bindings) => boolean;
  reads: Set<number>;
}

// ---------------------------------------------------------------- world setup

export interface EntitySpec {
  name: string;
  type: TypeName;
}

export interface InitWriter {
  set(fluent: string, args: (string | number)[], value: number | string | boolean | [number, number] | [number, number, number]): void;
}

export interface WorldSetup {
  entities?: EntitySpec[] | Record<string, TypeName>;
  init?: (w: InitWriter) => void;
}

// ---------------------------------------------------------------- model

export class Model {
  public readonly doc: DomainDoc;
  public readonly registry: Required<Registry>;

  public readonly entityNames: string[] = [];
  public readonly entityTypes: TypeName[] = [];
  private readonly entityIds = new Map<string, number>();
  public readonly typeMembers = new Map<TypeName, number[]>();
  private readonly indexInType = new Map<TypeName, Map<number, number>>();

  public readonly fluents: CompiledFluent[] = [];
  private readonly fluentByName = new Map<string, CompiledFluent>();
  public readonly axioms = new Map<string, CompiledAxiom>();

  public readonly operators: CompiledOperator[] = [];
  public readonly operatorByName = new Map<string, CompiledOperator>();
  public readonly methodsByTask = new Map<string, CompiledMethod[]>();
  /** fluents read by any method precondition/utility — changes here can unlock better branches */
  public readonly methodReads = new Set<number>();

  public groundOps: GroundOp[] = [];
  /** fluents any operator writes non-atomically — relaxation treats them as optimistically settable */
  public readonly relaxFuzzyWrites = new Set<number>();

  public slotCount = 1; // slot 0 = clock
  public slotOwner!: Int32Array;
  public baseState!: Float64Array;

  constructor(doc: DomainDoc, setup: WorldSetup = {}, registry: Registry = {}) {
    const errors = validateDomain(doc).filter((d) => d.severity === "error");
    if (errors.length > 0) throw new DomainError(errors);

    this.doc = doc;
    this.registry = {
      executors: registry.executors ?? {},
      predicates: registry.predicates ?? {},
      numerics: registry.numerics ?? {},
      effects: registry.effects ?? {},
    };

    this.internEntities(doc, setup);
    this.layoutFluents(doc);
    this.compileAxioms(doc);
    this.compileOperators(doc);
    this.compileMethods(doc);
    this.initializeBase(doc, setup);
    this.groundOperators();
  }

  // ---------------- entities & types

  private typeAncestors(t: TypeName): TypeName[] {
    const out: TypeName[] = [];
    let cur: TypeName | undefined = t;
    const byName = new Map((this.doc.types ?? []).map((d) => [d.name, d]));
    while (cur) {
      out.push(cur);
      cur = byName.get(cur)?.parent;
    }
    return out;
  }

  private internEntities(doc: DomainDoc, setup: WorldSetup): void {
    for (const t of doc.types ?? []) {
      this.typeMembers.set(t.name, []);
      this.indexInType.set(t.name, new Map());
    }
    const list: EntitySpec[] = Array.isArray(setup.entities)
      ? setup.entities
      : Object.entries(setup.entities ?? {}).map(([name, type]) => ({ name, type }));
    for (const ent of list) {
      if (this.entityIds.has(ent.name)) throw new Error(`Duplicate entity '${ent.name}'`);
      if (!this.typeMembers.has(ent.type)) throw new Error(`Entity '${ent.name}' has unknown type '${ent.type}'`);
      const gid = this.entityNames.length;
      this.entityNames.push(ent.name);
      this.entityTypes.push(ent.type);
      this.entityIds.set(ent.name, gid);
      for (const t of this.typeAncestors(ent.type)) {
        const members = this.typeMembers.get(t);
        if (!members) continue;
        this.indexInType.get(t)?.set(gid, members.length);
        members.push(gid);
      }
    }
  }

  entityId(name: string): number {
    const gid = this.entityIds.get(name);
    if (gid === undefined) throw new Error(`Unknown entity '${name}'`);
    return gid;
  }

  entityName(gid: number): string {
    return this.entityNames[gid] ?? `#${gid}`;
  }

  membersOf(type: TypeName): number[] {
    const m = this.typeMembers.get(type);
    if (!m) throw new Error(`Unknown type '${type}'`);
    return m;
  }

  // ---------------- fluent layout

  private static widthOf(kind: FluentDecl["kind"]): number {
    return kind === "vec2" ? 2 : kind === "vec3" ? 3 : 1;
  }

  private layoutFluents(doc: DomainDoc): void {
    let next = 1;
    for (const decl of doc.fluents) {
      const paramTypes = (decl.params ?? []).map((p) => p.type);
      const sizes = paramTypes.map((t) => this.membersOf(t).length);
      const size = sizes.reduce((a, b) => a * b, 1);
      const width = Model.widthOf(decl.kind);
      const strides: number[] = new Array(sizes.length);
      let acc = 1;
      for (let i = sizes.length - 1; i >= 0; i--) {
        strides[i] = acc;
        acc *= sizes[i];
      }
      const cf: CompiledFluent = { id: this.fluents.length, decl, base: next, width, paramTypes, strides, size };
      this.fluents.push(cf);
      this.fluentByName.set(decl.name, cf);
      next += size * width;
    }
    this.slotCount = next;
    this.slotOwner = new Int32Array(this.slotCount).fill(-1);
    for (const cf of this.fluents) {
      for (let s = cf.base; s < cf.base + cf.size * cf.width; s++) this.slotOwner[s] = cf.id;
    }
  }

  fluent(name: string): CompiledFluent {
    const cf = this.fluentByName.get(name);
    if (!cf) throw new Error(`Unknown fluent '${name}'`);
    return cf;
  }

  /** slot of fluent(...entity gids); for vec fluents this is the first component slot */
  slotOf(name: string, ...gids: number[]): number {
    const cf = this.fluent(name);
    let idx = 0;
    for (let i = 0; i < cf.paramTypes.length; i++) {
      const within = this.indexInType.get(cf.paramTypes[i])?.get(gids[i]);
      if (within === undefined) {
        throw new Error(`Entity '${this.entityName(gids[i])}' is not of type '${cf.paramTypes[i]}' (fluent '${name}')`);
      }
      idx += within * cf.strides[i];
    }
    return cf.base + idx * cf.width;
  }

  encodeValue(name: string, value: number | string | boolean): number {
    const cf = this.fluent(name);
    switch (cf.decl.kind) {
      case "boolean":
        return value === true || value === 1 ? 1 : 0;
      case "enum": {
        if (typeof value === "number") return value;
        const idx = (cf.decl.values ?? []).indexOf(String(value));
        if (idx < 0) throw new Error(`'${value}' is not a value of enum '${name}'`);
        return idx;
      }
      case "entity": {
        if (typeof value === "number") return value;
        if (value === false) return 0;
        return this.entityId(String(value)) + 1;
      }
      default:
        if (typeof value !== "number") throw new Error(`Fluent '${name}' expects a number`);
        return value;
    }
  }

  decodeValue(name: string, encoded: number): number | string | boolean | null {
    const cf = this.fluent(name);
    switch (cf.decl.kind) {
      case "boolean": return encoded !== 0;
      case "enum": return (cf.decl.values ?? [])[encoded] ?? encoded;
      case "entity": return encoded === 0 ? null : this.entityName(encoded - 1);
      default: return encoded;
    }
  }

  // ---------------- term/arg resolution helpers

  private resolveArgSources(args: Term[], vars: Map<string, number>, context: string): ArgSource[] {
    return args.map((a) => {
      if (a.t === "var") {
        const idx = vars.get(varKey(a.name));
        if (idx === undefined) throw new Error(`Unbound variable '${a.name}' in ${context}`);
        return { v: idx };
      }
      if (a.t === "sym") return { c: this.entityId(a.name) };
      if (a.t === "num") return { c: a.value };
      throw new Error(`Boolean term not allowed as argument in ${context}`);
    });
  }

  private argFn(sources: ArgSource[]): (b: Bindings) => Bindings {
    if (sources.every((s) => "c" in s)) {
      const fixed = sources.map((s) => (s as { c: number }).c);
      return () => fixed;
    }
    return (b: Bindings) => sources.map((s) => ("c" in s ? s.c : b[s.v]));
  }

  private slotFn(name: string, args: Term[], vars: Map<string, number>, context: string): (b: Bindings) => number {
    const sources = this.resolveArgSources(args, vars, context);
    if (sources.every((s) => "c" in s)) {
      const slot = this.slotOf(name, ...sources.map((s) => (s as { c: number }).c));
      return () => slot;
    }
    const getArgs = this.argFn(sources);
    return (b: Bindings) => this.slotOf(name, ...getArgs(b));
  }

  private extQuery(s: Snap, args: Bindings): ExtQuery {
    return {
      args,
      get: (fluent: string, ...a: (number | string)[]) => s.get(this.slotOf(fluent, ...a.map((x) => (typeof x === "string" ? this.entityId(x) : x)))),
      vec: (fluent: string, ...a: (number | string)[]) => {
        const cf = this.fluent(fluent);
        const slot = this.slotOf(fluent, ...a.map((x) => (typeof x === "string" ? this.entityId(x) : x)));
        const out: number[] = [];
        for (let i = 0; i < cf.width; i++) out.push(s.get(slot + i));
        return out;
      },
      clock: () => s.get(CLOCK_SLOT),
      gid: (name: string) => this.entityId(name),
      name: (gid: number) => this.entityName(gid),
    };
  }

  extWriter(target: WritableState, args: Bindings): ExtWriter {
    const q = this.extQuery(target, args);
    return {
      ...q,
      set: (fluent: string, a: (number | string)[], value: number | string | boolean) => {
        const slot = this.slotOf(fluent, ...a.map((x) => (typeof x === "string" ? this.entityId(x) : x)));
        target.set(slot, this.encodeValue(fluent, value));
      },
    };
  }

  // ---------------- numeric expression compilation

  compileNum(expr: NumExpr, vars: Map<string, number>, context: string): CompiledNum {
    const reads = new Set<number>();
    const fn = this.buildNum(expr, vars, context, reads);
    return { fn, reads };
  }

  private buildNum(expr: NumExpr, vars: Map<string, number>, context: string, reads: Set<number>): (s: Snap, b: Bindings) => number {
    switch (expr.n) {
      case "const": {
        const v = expr.value;
        return () => v;
      }
      case "clock":
        return (s) => s.get(CLOCK_SLOT);
      case "fluent": {
        reads.add(this.fluent(expr.fluent).id);
        const slot = this.slotFn(expr.fluent, expr.args, vars, context);
        return (s, b) => s.get(slot(b));
      }
      case "bin": {
        const a = this.buildNum(expr.a, vars, context, reads);
        const c = this.buildNum(expr.b, vars, context, reads);
        switch (expr.op) {
          case "+": return (s, b) => a(s, b) + c(s, b);
          case "-": return (s, b) => a(s, b) - c(s, b);
          case "*": return (s, b) => a(s, b) * c(s, b);
          case "/": return (s, b) => a(s, b) / c(s, b);
          case "min": return (s, b) => Math.min(a(s, b), c(s, b));
          case "max": return (s, b) => Math.max(a(s, b), c(s, b));
        }
        break;
      }
      case "dist": {
        const fa = this.fluent(expr.a.fluent);
        const fb = this.fluent(expr.b.fluent);
        reads.add(fa.id);
        reads.add(fb.id);
        const sa = this.slotFn(expr.a.fluent, expr.a.args, vars, context);
        const sb = this.slotFn(expr.b.fluent, expr.b.args, vars, context);
        const dims = Math.min(fa.width, fb.width);
        return (s, b) => {
          const pa = sa(b);
          const pb = sb(b);
          let sum = 0;
          for (let i = 0; i < dims; i++) {
            const d = s.get(pa + i) - s.get(pb + i);
            sum += d * d;
          }
          return Math.sqrt(sum);
        };
      }
      case "external": {
        const fn = this.registry.numerics[expr.name];
        if (!fn) throw new Error(`Unregistered external numeric '${expr.name}' in ${context}`);
        for (const r of expr.reads) reads.add(this.fluent(r).id);
        const getArgs = this.argFn(this.resolveArgSources(expr.args, vars, context));
        return (s, b) => fn(this.extQuery(s, getArgs(b)));
      }
    }
    throw new Error(`Unreachable numeric expression in ${context}`);
  }

  // ---------------- formula compilation

  compileFormula(formula: Formula, vars: Map<string, number>, context: string): CompiledFormula {
    const reads = new Set<number>();
    const readsClock = { v: false };
    const fn = this.buildFormula(formula, vars, context, reads, readsClock);
    const atomFns = this.collectAtomFns(formula, vars, context);
    return {
      fn,
      reads,
      readsClock: readsClock.v,
      atoms: (b: Bindings) => atomFns.map((f) => f(b)),
      ir: formula,
    };
  }

  private buildFormula(
    formula: Formula,
    vars: Map<string, number>,
    context: string,
    reads: Set<number>,
    readsClock: { v: boolean },
  ): (s: Snap, b: Bindings) => boolean {
    switch (formula.f) {
      case "and": {
        const parts = formula.parts.map((p) => this.buildFormula(p, vars, context, reads, readsClock));
        if (parts.length === 0) return () => true;
        return (s, b) => {
          for (const p of parts) if (!p(s, b)) return false;
          return true;
        };
      }
      case "or": {
        const parts = formula.parts.map((p) => this.buildFormula(p, vars, context, reads, readsClock));
        return (s, b) => {
          for (const p of parts) if (p(s, b)) return true;
          return false;
        };
      }
      case "not": {
        const inner = this.buildFormula(formula.part, vars, context, reads, readsClock);
        return (s, b) => !inner(s, b);
      }
      case "lit": {
        const ax = this.axioms.get(formula.fluent);
        if (ax) {
          for (const r of ax.reads) reads.add(r);
          const getArgs = this.argFn(this.resolveArgSources(formula.args, vars, context));
          const expectTrue = formula.value === undefined || (formula.value.t === "bool" ? formula.value.value : formula.value.t === "num" ? formula.value.value !== 0 : true);
          return (s, b) => ax.fn(s, getArgs(b)) === expectTrue;
        }
        const cf = this.fluent(formula.fluent);
        reads.add(cf.id);
        const slot = this.slotFn(formula.fluent, formula.args, vars, context);
        const expected = this.encodeLitValue(cf, formula.value, vars, context);
        if (typeof expected === "number") {
          return (s, b) => s.get(slot(b)) === expected;
        }
        const dyn = expected;
        return (s, b) => s.get(slot(b)) === dyn(b);
      }
      case "cmp": {
        const a = this.buildNum(formula.a, vars, context, reads);
        const c = this.buildNum(formula.b, vars, context, reads);
        if (clockMentioned(formula.a) || clockMentioned(formula.b)) readsClock.v = true;
        switch (formula.op) {
          case "==": return (s, b) => a(s, b) === c(s, b);
          case "!=": return (s, b) => a(s, b) !== c(s, b);
          case "<": return (s, b) => a(s, b) < c(s, b);
          case "<=": return (s, b) => a(s, b) <= c(s, b);
          case ">": return (s, b) => a(s, b) > c(s, b);
          case ">=": return (s, b) => a(s, b) >= c(s, b);
        }
        break;
      }
      case "external": {
        const fn = this.registry.predicates[formula.name];
        if (!fn) throw new Error(`Unregistered external predicate '${formula.name}' in ${context}`);
        for (const r of formula.reads) reads.add(this.fluent(r).id);
        const getArgs = this.argFn(this.resolveArgSources(formula.args, vars, context));
        return (s, b) => fn(this.extQuery(s, getArgs(b)));
      }
      case "opaque": {
        const fn = this.registry.predicates[formula.name];
        if (!fn) throw new Error(`Unregistered opaque predicate '${formula.name}' in ${context}`);
        return (s, b) => fn(this.extQuery(s, b));
      }
    }
    throw new Error(`Unreachable formula in ${context}`);
  }

  /** encoded comparison value for a lit; number when constant, fn when variable */
  private encodeLitValue(
    cf: CompiledFluent,
    value: Term | undefined,
    vars: Map<string, number>,
    context: string,
  ): number | ((b: Bindings) => number) {
    if (value === undefined) return 1; // boolean true
    switch (value.t) {
      case "bool": return value.value ? 1 : 0;
      case "num": return value.value;
      case "sym": {
        if (cf.decl.kind === "enum") {
          const idx = (cf.decl.values ?? []).indexOf(value.name);
          if (idx < 0) throw new Error(`'${value.name}' is not a value of enum '${cf.decl.name}' in ${context}`);
          return idx;
        }
        if (cf.decl.kind === "entity") return this.entityId(value.name) + 1;
        throw new Error(`Symbol value '${value.name}' for non-enum/entity fluent '${cf.decl.name}' in ${context}`);
      }
      case "var": {
        const idx = vars.get(varKey(value.name));
        if (idx === undefined) throw new Error(`Unbound variable '${value.name}' in ${context}`);
        if (cf.decl.kind === "entity") return (b: Bindings) => b[idx] + 1;
        return (b: Bindings) => b[idx];
      }
    }
  }

  /** positive conjunctive lits → atom extractors (for heuristics); other parts skipped (optimistic) */
  private collectAtomFns(formula: Formula, vars: Map<string, number>, context: string): ((b: Bindings) => Atom)[] {
    const out: ((b: Bindings) => Atom)[] = [];
    const walk = (f: Formula): void => {
      if (f.f === "and") {
        f.parts.forEach(walk);
        return;
      }
      if (f.f !== "lit") return;
      if (this.axioms.has(f.fluent)) return;
      const cf = this.fluent(f.fluent);
      let expected: number | ((b: Bindings) => number);
      try {
        expected = this.encodeLitValue(cf, f.value, vars, context);
      } catch {
        return;
      }
      const slot = this.slotFn(f.fluent, f.args, vars, context);
      if (typeof expected === "number") {
        const v = expected;
        out.push((b) => ({ slot: slot(b), value: v }));
      } else {
        const ev = expected;
        out.push((b) => ({ slot: slot(b), value: ev(b) }));
      }
    };
    walk(formula);
    return out;
  }

  // ---------------- effects compilation

  compileEffects(effects: EffectExpr[] | undefined, vars: Map<string, number>, context: string): CompiledEffects {
    const writes = new Set<number>();
    const fuzzyWrites = new Set<number>();
    const appliers: ((target: WritableState, b: Bindings, mask: number) => void)[] = [];
    const atomFns: ((b: Bindings) => Atom | null)[] = [];

    for (const eff of effects ?? []) {
      const timingBit =
        eff.timing === "planOnly" ? TIMING_PLAN_ONLY : eff.timing === "permanent" ? TIMING_PERMANENT : TIMING_PLAN_AND_EXECUTE;

      if (eff.e === "external") {
        const fn = this.registry.effects[eff.name];
        if (!fn) throw new Error(`Unregistered external effect '${eff.name}' in ${context}`);
        for (const w of eff.writes) {
          writes.add(this.fluent(w).id);
          fuzzyWrites.add(this.fluent(w).id);
        }
        appliers.push((target, b, mask) => {
          if ((mask & timingBit) === 0) return;
          fn(this.extWriter(target, b));
        });
        continue;
      }

      const cf = this.fluent(eff.fluent);
      writes.add(cf.id);
      const slot = this.slotFn(eff.fluent, eff.args, vars, context);

      if (eff.e === "set") {
        const value = eff.value;
        if ("n" in value) {
          const cn = this.compileNum(value, vars, context);
          fuzzyWrites.add(cf.id);
          appliers.push((target, b, mask) => {
            if ((mask & timingBit) === 0) return;
            target.set(slot(b), cn.fn(target, b));
          });
          atomFns.push(() => null);
        } else {
          const enc = this.encodeLitValue(cf, value, vars, context);
          if (typeof enc === "number") {
            appliers.push((target, b, mask) => {
              if ((mask & timingBit) === 0) return;
              target.set(slot(b), enc);
            });
            atomFns.push((b) => ({ slot: slot(b), value: enc }));
          } else {
            appliers.push((target, b, mask) => {
              if ((mask & timingBit) === 0) return;
              target.set(slot(b), enc(b));
            });
            atomFns.push((b) => ({ slot: slot(b), value: enc(b) }));
          }
        }
      } else if (eff.e === "setVec") {
        fuzzyWrites.add(cf.id);
        const xs = [eff.x, eff.y, ...(eff.z ? [eff.z] : [])].map((e) => this.compileNum(e, vars, context));
        appliers.push((target, b, mask) => {
          if ((mask & timingBit) === 0) return;
          const s0 = slot(b);
          xs.forEach((cn, i) => target.set(s0 + i, cn.fn(target, b)));
        });
        atomFns.push(() => null);
      } else {
        fuzzyWrites.add(cf.id);
        const by = this.compileNum(eff.by, vars, context);
        const sign = eff.e === "inc" ? 1 : -1;
        appliers.push((target, b, mask) => {
          if ((mask & timingBit) === 0) return;
          const sl = slot(b);
          target.set(sl, target.get(sl) + sign * by.fn(target, b));
        });
        atomFns.push(() => null);
      }
    }

    return {
      apply: (target, b, mask) => {
        for (const a of appliers) a(target, b, mask);
      },
      writes,
      fuzzyWrites,
      addAtoms: (b) => {
        const out: Atom[] = [];
        for (const f of atomFns) {
          const a = f(b);
          if (a) out.push(a);
        }
        return out;
      },
    };
  }

  // ---------------- axioms

  private compileAxioms(doc: DomainDoc): void {
    // axioms may reference other axioms (acyclic, validated); compile in dependency order via lazy thunks
    const pending = new Map<string, AxiomDecl>((doc.axioms ?? []).map((a) => [a.name, a]));
    const compile = (name: string, stack: string[]): CompiledAxiom => {
      const existing = this.axioms.get(name);
      if (existing) return existing;
      const decl = pending.get(name);
      if (!decl) throw new Error(`Unknown axiom '${name}'`);
      if (stack.includes(name)) throw new Error(`Recursive axiom '${name}'`);
      // ensure referenced axioms compile first
      const visit = (f: Formula): void => {
        if (f.f === "and" || f.f === "or") f.parts.forEach(visit);
        else if (f.f === "not") visit(f.part);
        else if (f.f === "lit" && pending.has(f.fluent) && !this.axioms.has(f.fluent)) compile(f.fluent, [...stack, name]);
      };
      visit(decl.body);
      const vars = new Map((decl.params ?? []).map((p, i) => [varKey(p.name), i]));
      const cf = this.compileFormula(decl.body, vars, `axioms/${name}`);
      const compiled: CompiledAxiom = { decl, fn: cf.fn, reads: cf.reads };
      this.axioms.set(name, compiled);
      return compiled;
    };
    for (const name of pending.keys()) compile(name, []);
  }

  // ---------------- operators & methods

  private compileOperators(doc: DomainDoc): void {
    for (const decl of doc.operators ?? []) {
      const params = decl.params ?? [];
      const vars = new Map(params.map((p, i) => [varKey(p.name), i]));
      const ctxName = `operators/${decl.name}`;
      const op: CompiledOperator = {
        id: this.operators.length,
        name: decl.name,
        decl,
        paramTypes: params.map((p) => p.type),
        pre: decl.pre ? this.compileFormula(decl.pre, vars, `${ctxName}/pre`) : null,
        verify: decl.verify ? this.compileFormula(decl.verify, vars, `${ctxName}/verify`) : null,
        effects: this.compileEffects(decl.eff, vars, ctxName),
        cost: decl.cost !== undefined ? this.compileNum(num(decl.cost), vars, `${ctxName}/cost`) : { fn: () => 1, reads: new Set() },
        duration:
          decl.duration !== undefined
            ? this.compileNum(num(decl.duration), vars, `${ctxName}/duration`)
            : { fn: () => 0, reads: new Set() },
        executor: decl.executor,
      };
      this.operators.push(op);
      this.operatorByName.set(decl.name, op);
      for (const f of op.effects.fuzzyWrites) this.relaxFuzzyWrites.add(f);
    }
  }

  private compileSubtasks(
    defs: SubtaskDef[],
    vars: Map<string, number>,
    context: string,
  ): CompiledSubtask[] {
    return defs.map((st, i) => {
      const ctx = `${context}/subtasks[${i}]`;
      if ("do" in st) {
        const args = this.resolveArgSources(terms(st.args), vars, ctx);
        const op = this.operatorByName.get(st.do);
        if (op) return { k: "op", op, args };
        return { k: "compound", name: st.do, args };
      }
      if ("achieve" in st) {
        return { k: "goal", cond: this.compileFormula(st.achieve, vars, `${ctx}/achieve`) };
      }
      if ("waitUntil" in st) {
        return { k: "waitUntil", t: this.compileNum(num(st.waitUntil), vars, ctx) };
      }
      if ("hold" in st) {
        return { k: "hold", t: this.compileNum(num(st.hold), vars, ctx) };
      }
      const scope: CompiledScopeTmpl = {
        deadline: st.scope.deadline !== undefined ? this.compileNum(num(st.scope.deadline), vars, `${ctx}/deadline`) : null,
        maintain: st.scope.maintain ? this.compileFormula(st.scope.maintain, vars, `${ctx}/maintain`) : null,
        minHold: st.scope.minHold ?? 0,
        onExit: st.scope.onExit,
        label: st.scope.label ?? `scope@${ctx}`,
      };
      return { k: "scope", scope, subtasks: this.compileSubtasks(st.subtasks, vars, ctx) };
    });
  }

  private compileMethods(doc: DomainDoc): void {
    const declaredParams = new Map((doc.compounds ?? []).map((c) => [c.name, c.params ?? []]));
    const counters = new Map<string, number>();
    for (const decl of doc.methods ?? []) {
      const taskParams = declaredParams.get(decl.task) ?? [];
      const freeParams = decl.params ?? [];
      const all = [...taskParams, ...freeParams];
      const vars = new Map(all.map((p, i) => [varKey(p.name), i]));
      const index = counters.get(decl.task) ?? 0;
      counters.set(decl.task, index + 1);
      const label = decl.name ?? `${decl.task}#${index}`;
      const ctx = `methods/${label}`;
      const compiled: CompiledMethod = {
        index,
        decl,
        task: decl.task,
        label,
        taskParams,
        freeParams,
        pre: decl.pre ? this.compileFormula(decl.pre, vars, `${ctx}/pre`) : null,
        utility: decl.utility !== undefined ? this.compileNum(num(decl.utility), vars, `${ctx}/utility`) : null,
        subtasks: this.compileSubtasks(decl.subtasks, vars, ctx),
      };
      const list = this.methodsByTask.get(decl.task) ?? [];
      list.push(compiled);
      this.methodsByTask.set(decl.task, list);
      for (const r of compiled.pre?.reads ?? []) this.methodReads.add(r);
      for (const r of compiled.utility?.reads ?? []) this.methodReads.add(r);
    }
  }

  // ---------------- initial state

  private initializeBase(doc: DomainDoc, setup: WorldSetup): void {
    this.baseState = new Float64Array(this.slotCount);
    for (const cf of this.fluents) {
      const init = cf.decl.initial;
      if (init === undefined) continue;
      for (let cell = 0; cell < cf.size; cell++) {
        const slot = cf.base + cell * cf.width;
        if (Array.isArray(init)) {
          init.forEach((v, i) => {
            this.baseState[slot + i] = v;
          });
        } else {
          this.baseState[slot] = this.encodeValue(cf.decl.name, init);
        }
      }
    }
    if (setup.init) {
      const writer: InitWriter = {
        set: (fluent, args, value) => {
          const gids = args.map((a) => (typeof a === "string" ? this.entityId(a) : a));
          const slot = this.slotOf(fluent, ...gids);
          if (Array.isArray(value)) {
            value.forEach((v, i) => {
              this.baseState[slot + i] = v;
            });
          } else {
            this.baseState[slot] = this.encodeValue(fluent, value);
          }
        },
      };
      setup.init(writer);
    }
  }

  /** Create a live execution state seeded from the initial world. */
  createExecState(): ExecState {
    return new ExecState(this.baseState.slice(), this.slotOwner);
  }

  // ---------------- grounding

  private enumerateBindings(paramTypes: TypeName[]): Bindings[] {
    if (paramTypes.length === 0) return [[]];
    const pools = paramTypes.map((t) => this.membersOf(t));
    const total = pools.reduce((a, p) => a * p.length, 1);
    if (total > 100_000) {
      throw new Error(`Grounding explosion (${total} bindings); declare fewer entities or mark for lazy grounding`);
    }
    const out: Bindings[] = [];
    const current: number[] = new Array(paramTypes.length);
    const rec = (i: number): void => {
      if (i === paramTypes.length) {
        out.push(current.slice());
        return;
      }
      for (const gid of pools[i]) {
        current[i] = gid;
        rec(i + 1);
      }
    };
    rec(0);
    return out;
  }

  private groundOperators(): void {
    this.groundOps = [];
    for (const op of this.operators) {
      for (const b of this.enumerateBindings(op.paramTypes)) {
        this.groundOps.push({
          gid: this.groundOps.length,
          op,
          b,
          preAtoms: op.pre ? op.pre.atoms(b) : [],
          addAtoms: op.effects.addAtoms(b),
        });
      }
    }
  }

  /** Enumerate bindings for a method's free parameters. */
  freeBindings(method: CompiledMethod): Bindings[] {
    return this.enumerateBindings(method.freeParams.map((p) => p.type));
  }

  // ---------------- introspection helpers

  read(snap: Snap, fluent: string, ...args: (string | number)[]): number | string | boolean | null {
    const gids = args.map((a) => (typeof a === "string" ? this.entityId(a) : a));
    return this.decodeValue(fluent, snap.get(this.slotOf(fluent, ...gids)));
  }

  describeGroundOp(g: GroundOp): string {
    return `${g.op.name}(${g.b.map((gid) => this.entityName(gid)).join(",")})`;
  }
}

function clockMentioned(e: NumExpr): boolean {
  switch (e.n) {
    case "clock": return true;
    case "bin": return clockMentioned(e.a) || clockMentioned(e.b);
    default: return false;
  }
}

/** Convenience: validate + compile a domain against a world setup. */
export function createModel(doc: DomainDoc, setup: WorldSetup = {}, registry: Registry = {}): Model {
  return new Model(doc, setup, registry);
}

export type { Diagnostic, ScopeDecl };
