/**
 * Intermediate representation (IR) for htn-ai v2 domains.
 *
 * The IR is the canonical artifact (SPEC §4.11): plain data describing types,
 * entities, fluents, operators, methods, axioms and goals. Code (executors,
 * external predicates/effects) is referenced by registry name so documents
 * stay serializable. Three evaluation tiers (SPEC §4.9):
 *   T1 symbolic   — pure IR nodes (lit/cmp/and/or/not, set/inc/dec)
 *   T2 scoped     — external nodes with declared read/write fluent sets
 *   T3 opaque     — registry-bound closures, no declarations (prototyping)
 */

// ---------------------------------------------------------------- types

export type TypeName = string;

export interface TypeDecl {
  name: TypeName;
  parent?: TypeName;
}

export interface ParamDecl {
  name: string; // "?x" convention not required here; any identifier
  type: TypeName;
}

export type FluentKind = "boolean" | "enum" | "int" | "float" | "entity" | "vec2" | "vec3";

export interface FluentDecl {
  name: string;
  /** parameter signature; [] for a global fluent */
  params?: ParamDecl[];
  kind: FluentKind;
  /** enum: allowed symbols */
  values?: string[];
  /** entity kind: the type of the stored entity */
  entityType?: TypeName;
  /** default initial value (boolean=false, numbers=0, enum=values[0], entity=null) */
  initial?: number | boolean | string | [number, number] | [number, number, number];
}

// ---------------------------------------------------------------- terms

export type Term =
  | { t: "var"; name: string }
  | { t: "sym"; name: string } // entity constant or enum symbol (resolved by context)
  | { t: "num"; value: number }
  | { t: "bool"; value: boolean };

export type TermLike = Term | string | number | boolean;

/** Variables may be declared as "x" and referenced as "?x" — normalize for lookups. */
export function varKey(name: string): string {
  return name.startsWith("?") ? name.slice(1) : name;
}

/** "?x" → variable; other strings → symbol; numbers/booleans literal. */
export function term(x: TermLike): Term {
  if (typeof x === "string") {
    return x.startsWith("?") ? { t: "var", name: x } : { t: "sym", name: x };
  }
  if (typeof x === "number") return { t: "num", value: x };
  if (typeof x === "boolean") return { t: "bool", value: x };
  return x;
}

export function terms(xs: TermLike[] | undefined): Term[] {
  return (xs ?? []).map(term);
}

// ---------------------------------------------------------------- numeric expressions

export interface FluentRef {
  fluent: string;
  args: Term[];
}

export type NumExpr =
  | { n: "const"; value: number }
  | { n: "fluent"; fluent: string; args: Term[] }
  | { n: "bin"; op: "+" | "-" | "*" | "/" | "min" | "max"; a: NumExpr; b: NumExpr }
  | { n: "dist"; a: FluentRef; b: FluentRef }
  | { n: "clock" }
  | { n: "external"; name: string; args: Term[]; reads: string[] };

export type NumLike = number | NumExpr;

export function num(x: NumLike): NumExpr {
  return typeof x === "number" ? { n: "const", value: x } : x;
}

/** Numeric expression helpers. */
export const N = {
  c: (value: number): NumExpr => ({ n: "const", value }),
  fl: (fluent: string, ...args: TermLike[]): NumExpr => ({ n: "fluent", fluent, args: terms(args) }),
  add: (a: NumLike, b: NumLike): NumExpr => ({ n: "bin", op: "+", a: num(a), b: num(b) }),
  sub: (a: NumLike, b: NumLike): NumExpr => ({ n: "bin", op: "-", a: num(a), b: num(b) }),
  mul: (a: NumLike, b: NumLike): NumExpr => ({ n: "bin", op: "*", a: num(a), b: num(b) }),
  div: (a: NumLike, b: NumLike): NumExpr => ({ n: "bin", op: "/", a: num(a), b: num(b) }),
  min: (a: NumLike, b: NumLike): NumExpr => ({ n: "bin", op: "min", a: num(a), b: num(b) }),
  max: (a: NumLike, b: NumLike): NumExpr => ({ n: "bin", op: "max", a: num(a), b: num(b) }),
  dist: (aFluent: string, aArgs: TermLike[], bFluent: string, bArgs: TermLike[]): NumExpr => ({
    n: "dist",
    a: { fluent: aFluent, args: terms(aArgs) },
    b: { fluent: bFluent, args: terms(bArgs) },
  }),
  clock: (): NumExpr => ({ n: "clock" }),
  ext: (name: string, args: TermLike[], reads: string[]): NumExpr => ({ n: "external", name, args: terms(args), reads }),
};

// ---------------------------------------------------------------- formulas

export type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

export type Formula =
  | { f: "and"; parts: Formula[] }
  | { f: "or"; parts: Formula[] }
  | { f: "not"; part: Formula }
  | { f: "lit"; fluent: string; args: Term[]; value?: Term } // boolean fluents: omitted value = true
  | { f: "cmp"; op: CmpOp; a: NumExpr; b: NumExpr }
  | { f: "external"; name: string; args: Term[]; reads: string[] }
  | { f: "opaque"; name: string };

/** Formula helpers. */
export const F = {
  and: (...parts: Formula[]): Formula => ({ f: "and", parts }),
  or: (...parts: Formula[]): Formula => ({ f: "or", parts }),
  not: (part: Formula): Formula => ({ f: "not", part }),
  /** lit("at", ["hero"], "camp") — entity/enum equality; lit("alive", ["hero"]) — boolean true */
  lit: (fluent: string, args: TermLike[] = [], value?: TermLike): Formula => ({
    f: "lit",
    fluent,
    args: terms(args),
    value: value === undefined ? undefined : term(value),
  }),
  cmp: (op: CmpOp, a: NumLike, b: NumLike): Formula => ({ f: "cmp", op, a: num(a), b: num(b) }),
  lte: (a: NumLike, b: NumLike): Formula => F.cmp("<=", a, b),
  lt: (a: NumLike, b: NumLike): Formula => F.cmp("<", a, b),
  gte: (a: NumLike, b: NumLike): Formula => F.cmp(">=", a, b),
  gt: (a: NumLike, b: NumLike): Formula => F.cmp(">", a, b),
  eq: (a: NumLike, b: NumLike): Formula => F.cmp("==", a, b),
  ext: (name: string, args: TermLike[], reads: string[]): Formula => ({ f: "external", name, args: terms(args), reads }),
  opaque: (name: string): Formula => ({ f: "opaque", name }),
  true: (): Formula => ({ f: "and", parts: [] }),
};

// ---------------------------------------------------------------- effects

export type EffectTiming = "permanent" | "planAndExecute" | "planOnly";

export type EffectExpr =
  | { e: "set"; fluent: string; args: Term[]; value: Term | NumExpr; timing?: EffectTiming }
  | { e: "setVec"; fluent: string; args: Term[]; x: NumExpr; y: NumExpr; z?: NumExpr; timing?: EffectTiming }
  | { e: "inc"; fluent: string; args: Term[]; by: NumExpr; timing?: EffectTiming }
  | { e: "dec"; fluent: string; args: Term[]; by: NumExpr; timing?: EffectTiming }
  | { e: "external"; name: string; writes: string[]; timing?: EffectTiming };

function valueTerm(value: TermLike | NumExpr): Term | NumExpr {
  if (typeof value === "object" && value !== null && "n" in value) return value as NumExpr;
  return term(value as TermLike);
}

/** Effect helpers. */
export const E = {
  set: (fluent: string, args: TermLike[], value: TermLike | NumExpr, timing?: EffectTiming): EffectExpr => ({
    e: "set",
    fluent,
    args: terms(args),
    value: valueTerm(value),
    timing,
  }),
  setVec: (fluent: string, args: TermLike[], x: NumLike, y: NumLike, z?: NumLike, timing?: EffectTiming): EffectExpr => ({
    e: "setVec",
    fluent,
    args: terms(args),
    x: num(x),
    y: num(y),
    z: z === undefined ? undefined : num(z),
    timing,
  }),
  inc: (fluent: string, args: TermLike[], by: NumLike, timing?: EffectTiming): EffectExpr => ({
    e: "inc",
    fluent,
    args: terms(args),
    by: num(by),
    timing,
  }),
  dec: (fluent: string, args: TermLike[], by: NumLike, timing?: EffectTiming): EffectExpr => ({
    e: "dec",
    fluent,
    args: terms(args),
    by: num(by),
    timing,
  }),
  ext: (name: string, writes: string[], timing?: EffectTiming): EffectExpr => ({ e: "external", name, writes, timing }),
};

// ---------------------------------------------------------------- operators, tasks, methods

export interface OperatorDecl {
  name: string;
  params?: ParamDecl[];
  /** precondition checked when the step is reached (plan time and execution time) */
  pre?: Formula;
  /** executing condition re-verified every tick while the operator runs */
  verify?: Formula;
  eff?: EffectExpr[];
  cost?: NumLike;
  /** seconds, advances the projected clock during planning (temporal-lite, SPEC §4.13) */
  duration?: NumLike;
  /** registry key of the runtime executor; default executor succeeds instantly */
  executor?: string;
  meta?: Record<string, unknown>;
}

export interface CompoundDecl {
  name: string;
  params?: ParamDecl[];
}

export interface ScopeDecl {
  /** relative deadline in seconds from scope entry; enforced in search (projected clock) and execution */
  deadline?: NumLike;
  /** condition that must hold across the scope (checked between steps in search, every tick at execution) */
  maintain?: Formula;
  /** scope must last at least this many seconds before it can complete (execution-enforced) */
  minHold?: number;
  /** registry executor invoked when the scope exits (success, failure, or abort) */
  onExit?: string;
  label?: string;
}

export type SubtaskDef =
  | { do: string; args?: TermLike[] }
  | { achieve: Formula }
  | { scope: ScopeDecl; subtasks: SubtaskDef[] }
  | { waitUntil: NumLike } // advance projected clock to value (wait at execution)
  | { hold: NumLike }; // wait a relative number of seconds

/** Subtask sugar. */
export function doTask(name: string, ...args: TermLike[]): SubtaskDef {
  return { do: name, args };
}

export function achieve(condition: Formula): SubtaskDef {
  return { achieve: condition };
}

export function scoped(scope: ScopeDecl, ...subtasks: SubtaskDef[]): SubtaskDef {
  return { scope, subtasks };
}

/** Temporal-lite subtask helpers (SPEC §4.13). */
export const T = {
  /** advance the projected clock to an absolute value (waits at execution) */
  waitUntil: (t: NumLike): SubtaskDef => ({ waitUntil: t }),
  /** wait a relative number of seconds */
  hold: (t: NumLike): SubtaskDef => ({ hold: t }),
};

export interface MethodDecl {
  name?: string;
  task: string;
  /** extra free variables beyond the task's params, bound by search over entities */
  params?: ParamDecl[];
  pre?: Formula;
  /** higher utility methods are preferred (evaluated in the current state) */
  utility?: NumLike;
  subtasks: SubtaskDef[];
}

export interface AxiomDecl {
  name: string;
  params?: ParamDecl[];
  body: Formula;
}

// ---------------------------------------------------------------- domain & problem documents

export interface DomainDoc {
  format?: "htn-ai/domain@2";
  name: string;
  types?: TypeDecl[];
  fluents: FluentDecl[];
  operators?: OperatorDecl[];
  compounds?: CompoundDecl[];
  methods?: MethodDecl[];
  axioms?: AxiomDecl[];
}

export type GoalSpec =
  | { kind: "task"; name: string; args?: TermLike[] }
  | { kind: "goal"; condition: Formula };

export function task(name: string, ...args: TermLike[]): GoalSpec {
  return { kind: "task", name, args };
}

export function goal(condition: Formula): GoalSpec {
  return { kind: "goal", condition };
}

// ---------------------------------------------------------------- diagnostics & validation

export interface Diagnostic {
  code: string;
  message: string;
  /** location path, e.g. "operators/move/pre" */
  path: string;
  severity: "error" | "warning";
}

export class DomainError extends Error {
  public readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super(`Domain validation failed:\n${diagnostics.map((d) => `  [${d.code}] ${d.path}: ${d.message}`).join("\n")}`);
    this.diagnostics = diagnostics;
  }
}

interface NameIndex {
  fluents: Map<string, FluentDecl>;
  axioms: Map<string, AxiomDecl>;
  operators: Map<string, OperatorDecl>;
  compounds: Set<string>;
  types: Map<string, TypeDecl>;
}

function indexDomain(doc: DomainDoc): NameIndex {
  const idx: NameIndex = {
    fluents: new Map(),
    axioms: new Map(),
    operators: new Map(),
    compounds: new Set(),
    types: new Map(),
  };
  for (const t of doc.types ?? []) idx.types.set(t.name, t);
  for (const fl of doc.fluents) idx.fluents.set(fl.name, fl);
  for (const ax of doc.axioms ?? []) idx.axioms.set(ax.name, ax);
  for (const op of doc.operators ?? []) idx.operators.set(op.name, op);
  for (const c of doc.compounds ?? []) idx.compounds.add(c.name);
  // compound tasks may be declared implicitly by methods
  for (const m of doc.methods ?? []) idx.compounds.add(m.task);
  return idx;
}

function checkFormula(
  formula: Formula,
  vars: Set<string>,
  idx: NameIndex,
  path: string,
  out: Diagnostic[],
  axiomStack: string[] = [],
): void {
  switch (formula.f) {
    case "and":
    case "or":
      formula.parts.forEach((p, i) => checkFormula(p, vars, idx, `${path}/${formula.f}[${i}]`, out, axiomStack));
      return;
    case "not":
      checkFormula(formula.part, vars, idx, `${path}/not`, out, axiomStack);
      return;
    case "lit": {
      const fl = idx.fluents.get(formula.fluent);
      const ax = idx.axioms.get(formula.fluent);
      if (!fl && !ax) {
        out.push({ code: "unknown-fluent", message: `unknown fluent or axiom '${formula.fluent}'`, path, severity: "error" });
        return;
      }
      const arity = (fl?.params ?? ax?.params ?? []).length;
      if (formula.args.length !== arity) {
        out.push({
          code: "arity",
          message: `'${formula.fluent}' expects ${arity} arg(s), got ${formula.args.length}`,
          path,
          severity: "error",
        });
      }
      for (const a of formula.args) {
        if (a.t === "var" && !vars.has(varKey(a.name))) {
          out.push({ code: "unbound-var", message: `unbound variable '${a.name}'`, path, severity: "error" });
        }
      }
      if (ax) {
        if (axiomStack.includes(formula.fluent)) {
          out.push({ code: "axiom-cycle", message: `recursive axiom '${formula.fluent}'`, path, severity: "error" });
          return;
        }
        const axVars = new Set((ax.params ?? []).map((p) => varKey(p.name)));
        checkFormula(ax.body, axVars, idx, `axioms/${ax.name}/body`, out, [...axiomStack, formula.fluent]);
      }
      if (fl && formula.value !== undefined && formula.value.t === "sym" && fl.kind === "enum") {
        if (!(fl.values ?? []).includes(formula.value.name)) {
          out.push({
            code: "enum-value",
            message: `'${formula.value.name}' is not a value of enum '${fl.name}'`,
            path,
            severity: "error",
          });
        }
      }
      return;
    }
    case "cmp":
      checkNum(formula.a, vars, idx, `${path}/a`, out);
      checkNum(formula.b, vars, idx, `${path}/b`, out);
      return;
    case "external":
    case "opaque":
      return;
  }
}

function checkNum(expr: NumExpr, vars: Set<string>, idx: NameIndex, path: string, out: Diagnostic[]): void {
  switch (expr.n) {
    case "const":
    case "clock":
    case "external":
      return;
    case "fluent": {
      const fl = idx.fluents.get(expr.fluent);
      if (!fl) {
        out.push({ code: "unknown-fluent", message: `unknown fluent '${expr.fluent}'`, path, severity: "error" });
        return;
      }
      // entity fluents are allowed: their encodings compare meaningfully for ==/!=
      if (fl.kind === "vec2" || fl.kind === "vec3") {
        out.push({ code: "non-numeric", message: `vec fluent '${expr.fluent}' cannot be used as a scalar (use dist())`, path, severity: "error" });
      }
      return;
    }
    case "bin":
      checkNum(expr.a, vars, idx, `${path}/a`, out);
      checkNum(expr.b, vars, idx, `${path}/b`, out);
      return;
    case "dist":
      for (const side of [expr.a, expr.b]) {
        const fl = idx.fluents.get(side.fluent);
        if (!fl || (fl.kind !== "vec2" && fl.kind !== "vec3")) {
          out.push({ code: "dist-non-vec", message: `dist() over non-vec fluent '${side.fluent}'`, path, severity: "error" });
        }
      }
      return;
  }
}

function checkEffects(effects: EffectExpr[] | undefined, vars: Set<string>, idx: NameIndex, path: string, out: Diagnostic[]): void {
  for (const [i, eff] of (effects ?? []).entries()) {
    const p = `${path}/eff[${i}]`;
    if (eff.e === "external") continue;
    const fl = idx.fluents.get(eff.fluent);
    if (!fl) {
      if (idx.axioms.has(eff.fluent)) {
        out.push({ code: "write-derived", message: `cannot write derived fluent (axiom) '${eff.fluent}'`, path: p, severity: "error" });
      } else {
        out.push({ code: "unknown-fluent", message: `unknown fluent '${eff.fluent}'`, path: p, severity: "error" });
      }
      continue;
    }
    const arity = (fl.params ?? []).length;
    if (eff.args.length !== arity) {
      out.push({ code: "arity", message: `'${eff.fluent}' expects ${arity} arg(s), got ${eff.args.length}`, path: p, severity: "error" });
    }
    if ((eff.e === "inc" || eff.e === "dec") && fl.kind !== "int" && fl.kind !== "float") {
      out.push({ code: "non-numeric", message: `inc/dec on non-numeric fluent '${eff.fluent}'`, path: p, severity: "error" });
    }
    if (eff.e === "setVec" && fl.kind !== "vec2" && fl.kind !== "vec3") {
      out.push({ code: "non-vec", message: `setVec on non-vec fluent '${eff.fluent}'`, path: p, severity: "error" });
    }
    for (const a of eff.args) {
      if (a.t === "var" && !vars.has(varKey(a.name))) {
        out.push({ code: "unbound-var", message: `unbound variable '${a.name}'`, path: p, severity: "error" });
      }
    }
  }
}

function checkSubtasks(
  subtasks: SubtaskDef[],
  vars: Set<string>,
  idx: NameIndex,
  path: string,
  out: Diagnostic[],
): void {
  subtasks.forEach((st, i) => {
    const p = `${path}/subtasks[${i}]`;
    if ("do" in st) {
      const isOp = idx.operators.has(st.do);
      const isCompound = idx.compounds.has(st.do);
      if (!isOp && !isCompound) {
        out.push({ code: "unknown-task", message: `unknown operator or compound task '${st.do}'`, path: p, severity: "error" });
        return;
      }
      const decl = isOp ? idx.operators.get(st.do) : undefined;
      const arity = isOp ? (decl?.params ?? []).length : undefined;
      const got = (st.args ?? []).length;
      if (arity !== undefined && got !== arity) {
        out.push({ code: "arity", message: `'${st.do}' expects ${arity} arg(s), got ${got}`, path: p, severity: "error" });
      }
      for (const a of terms(st.args)) {
        if (a.t === "var" && !vars.has(varKey(a.name))) {
          out.push({ code: "unbound-var", message: `unbound variable '${a.name}'`, path: p, severity: "error" });
        }
      }
    } else if ("achieve" in st) {
      checkFormula(st.achieve, vars, idx, `${p}/achieve`, out);
    } else if ("scope" in st) {
      if (st.scope.maintain) checkFormula(st.scope.maintain, vars, idx, `${p}/maintain`, out);
      checkSubtasks(st.subtasks, vars, idx, p, out);
    }
  });
}

/**
 * Validate a domain document. Returns all diagnostics (empty = valid).
 * Incremental authoring (LLM loops) can validate per-element via the same paths.
 */
export function validateDomain(doc: DomainDoc): Diagnostic[] {
  const out: Diagnostic[] = [];
  const idx = indexDomain(doc);

  for (const t of doc.types ?? []) {
    if (t.parent && !idx.types.has(t.parent)) {
      out.push({ code: "unknown-type", message: `unknown parent type '${t.parent}'`, path: `types/${t.name}`, severity: "error" });
    }
  }

  for (const ax of doc.axioms ?? []) {
    const axVars = new Set((ax.params ?? []).map((p) => varKey(p.name)));
    checkFormula(ax.body, axVars, idx, `axioms/${ax.name}/body`, out, [ax.name]);
  }

  const knownType = (name: TypeName): boolean => idx.types.has(name);

  for (const fl of doc.fluents) {
    for (const p of fl.params ?? []) {
      if (!knownType(p.type)) {
        out.push({ code: "unknown-type", message: `unknown type '${p.type}'`, path: `fluents/${fl.name}`, severity: "error" });
      }
    }
    if (fl.kind === "enum" && (fl.values ?? []).length === 0) {
      out.push({ code: "enum-empty", message: `enum fluent '${fl.name}' declares no values`, path: `fluents/${fl.name}`, severity: "error" });
    }
    if (fl.kind === "entity" && !fl.entityType) {
      out.push({ code: "entity-type", message: `entity fluent '${fl.name}' missing entityType`, path: `fluents/${fl.name}`, severity: "error" });
    }
    if (idx.axioms.has(fl.name)) {
      out.push({ code: "name-clash", message: `fluent and axiom share name '${fl.name}'`, path: `fluents/${fl.name}`, severity: "error" });
    }
  }

  for (const op of doc.operators ?? []) {
    const vars = new Set((op.params ?? []).map((p) => varKey(p.name)));
    for (const p of op.params ?? []) {
      if (!knownType(p.type)) {
        out.push({ code: "unknown-type", message: `unknown type '${p.type}'`, path: `operators/${op.name}`, severity: "error" });
      }
    }
    if (op.pre) checkFormula(op.pre, vars, idx, `operators/${op.name}/pre`, out);
    if (op.verify) checkFormula(op.verify, vars, idx, `operators/${op.name}/verify`, out);
    checkEffects(op.eff, vars, idx, `operators/${op.name}`, out);
    if (idx.compounds.has(op.name)) {
      out.push({ code: "name-clash", message: `operator and compound task share name '${op.name}'`, path: `operators/${op.name}`, severity: "error" });
    }
  }

  for (const [i, m] of (doc.methods ?? []).entries()) {
    const path = `methods[${i}]:${m.task}`;
    const taskParams = (doc.compounds ?? []).find((c) => c.name === m.task)?.params ?? [];
    const vars = new Set<string>([...taskParams.map((p) => varKey(p.name)), ...(m.params ?? []).map((p) => varKey(p.name))]);
    for (const p of m.params ?? []) {
      if (!knownType(p.type)) {
        out.push({ code: "unknown-type", message: `unknown type '${p.type}'`, path, severity: "error" });
      }
    }
    if (m.pre) checkFormula(m.pre, vars, idx, `${path}/pre`, out);
    checkSubtasks(m.subtasks, vars, idx, path, out);
  }

  for (const c of doc.compounds ?? []) {
    const hasMethod = (doc.methods ?? []).some((m) => m.task === c.name);
    if (!hasMethod) {
      out.push({ code: "no-methods", message: `compound task '${c.name}' has no methods`, path: `compounds/${c.name}`, severity: "warning" });
    }
  }

  return out;
}

// ---------------------------------------------------------------- pretty printing

export function printTerm(t: Term): string {
  switch (t.t) {
    case "var": return t.name;
    case "sym": return t.name;
    case "num": return String(t.value);
    case "bool": return String(t.value);
  }
}

export function printNum(e: NumExpr): string {
  switch (e.n) {
    case "const": return String(e.value);
    case "fluent": return `${e.fluent}(${e.args.map(printTerm).join(",")})`;
    case "bin": return `(${printNum(e.a)} ${e.op} ${printNum(e.b)})`;
    case "dist": return `dist(${e.a.fluent}, ${e.b.fluent})`;
    case "clock": return "clock";
    case "external": return `${e.name}(${e.args.map(printTerm).join(",")})`;
  }
}

export function printFormula(formula: Formula): string {
  switch (formula.f) {
    case "and": return formula.parts.length === 0 ? "true" : `(and ${formula.parts.map(printFormula).join(" ")})`;
    case "or": return `(or ${formula.parts.map(printFormula).join(" ")})`;
    case "not": return `(not ${printFormula(formula.part)})`;
    case "lit": {
      const head = `${formula.fluent}(${formula.args.map(printTerm).join(",")})`;
      return formula.value === undefined ? head : `${head}=${printTerm(formula.value)}`;
    }
    case "cmp": return `${printNum(formula.a)} ${formula.op} ${printNum(formula.b)}`;
    case "external": return `@${formula.name}(${formula.args.map(printTerm).join(",")})`;
    case "opaque": return `#${formula.name}`;
  }
}

// ---------------------------------------------------------------- JSON round-trip

/** Domain documents are plain data; these helpers make the contract explicit. */
export function domainToJSON(doc: DomainDoc): string {
  return JSON.stringify({ format: "htn-ai/domain@2", ...doc });
}

export function domainFromJSON(json: string): DomainDoc {
  const doc = JSON.parse(json) as DomainDoc;
  if (doc.format && doc.format !== "htn-ai/domain@2") {
    throw new Error(`Unsupported domain format: ${doc.format}`);
  }
  const diags = validateDomain(doc).filter((d) => d.severity === "error");
  if (diags.length > 0) throw new DomainError(diags);
  return doc;
}
