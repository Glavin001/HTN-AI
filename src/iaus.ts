/**
 * Infinite Axis Utility System (IAUS) — Dave Mark / Mike Lewis style scored
 * selection. A decision is a set of *options*; each option is scored by a set of
 * *considerations*. A consideration reads a raw input from the context, normalizes
 * it into [0,1], shapes it through a *response curve*, and contributes a factor to
 * the option's score. Scores combine as a geometric mean with the "make-up value"
 * compensation (so adding more considerations doesn't unfairly crush a strong
 * option), and the highest-scoring option wins.
 *
 * This is a pure, deterministic, engine-independent primitive: the planner's scalar
 * method `utility` seam (search.ts `expandTask`) consumes the score, so IAUS *is*
 * the utility, it doesn't sit above the planner. See scenarios/solo-combat.ts.
 */

// ---------------------------------------------------------------- response curves

export type ResponseCurve =
  | { kind: "linear"; m?: number; b?: number } // m*x + b
  | { kind: "poly"; exp: number; m?: number; b?: number } // m*x^exp + b
  | { kind: "logistic"; k: number; x0: number } // 1/(1+e^-k(x-x0))
  | { kind: "step"; at: number } // x >= at ? 1 : 0
  | { kind: "const"; value: number };

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Evaluate a response curve at `x` (input clamped to [0,1]); result clamped to [0,1]. */
export function curve(c: ResponseCurve, x: number): number {
  const t = clamp01(x);
  switch (c.kind) {
    case "linear":
      return clamp01((c.m ?? 1) * t + (c.b ?? 0));
    case "poly":
      return clamp01((c.m ?? 1) * Math.pow(t, c.exp) + (c.b ?? 0));
    case "logistic":
      return clamp01(1 / (1 + Math.exp(-c.k * (t - c.x0))));
    case "step":
      return t >= c.at ? 1 : 0;
    case "const":
      return clamp01(c.value);
  }
}

// ---------------------------------------------------------------- considerations

export interface Consideration<C> {
  name: string;
  /** read the raw input value from the decision context */
  read: (ctx: C) => number;
  /** map the raw value into [0,1] (e.g. clamp by a known max, or a bookend pair) */
  normalize: (raw: number) => number;
  curve: ResponseCurve;
  /**
   * Importance in [0,1] (default 1). A lower weight pulls this consideration's
   * factor toward 1, so it is less able to drag an option's score down — letting a
   * personality reshape priorities with data alone.
   */
  weight?: number;
}

export interface ScoredOption<O> {
  option: O;
  score: number;
  /** per-consideration curved factor, for cost-decomposition telemetry (C17) */
  terms: { name: string; value: number }[];
}

/**
 * Score one option against the considerations. Geometric-mean aggregation with the
 * Dave Mark make-up compensation: each factor is lifted toward 1 by
 * `(1 - v) * modFactor * v`, with `modFactor = 1 - 1/n`, so n considerations don't
 * compound to an unfairly tiny product. A single zero-factor still zeros the option.
 */
export function scoreOption<C, O>(option: O, ctx: C, considerations: Consideration<C>[]): ScoredOption<O> {
  const n = considerations.length;
  if (n === 0) return { option, score: 1, terms: [] };
  const modFactor = 1 - 1 / n;
  let score = 1;
  const terms: { name: string; value: number }[] = [];
  for (const con of considerations) {
    const v0 = curve(con.curve, con.normalize(con.read(ctx)));
    // weight in [0,1]: pull the factor toward 1 as weight drops (less influence)
    const w = con.weight ?? 1;
    const v = clamp01(v0 + (1 - v0) * (1 - w));
    terms.push({ name: con.name, value: v });
    const makeUp = (1 - v) * modFactor * v;
    score *= v + makeUp;
  }
  return { option, score: clamp01(score), terms };
}

/**
 * Score every option and return them sorted by score descending. Ties preserve the
 * input order (stable) so selection is deterministic — important for replayable
 * scenarios.
 */
export function rankOptions<C, O>(options: O[], ctxOf: (o: O) => C, considerations: Consideration<C>[]): ScoredOption<O>[] {
  const scored = options.map((o, i) => ({ ...scoreOption(o, ctxOf(o), considerations), i }));
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map(({ option, score, terms }) => ({ option, score, terms }));
}
