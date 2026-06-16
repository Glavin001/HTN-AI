/**
 * Expected-HP combat currency (capability C4). The whole tactical trade-off is
 * expressed in one currency — expected HP — so the planner can weigh "fight from
 * here" against "relocate then fight" with a single risk-aversion knob:
 *
 *   reward = P(hit) · damage dealt        (expected HP removed from the target)
 *   risk   = exposedEnemies · P(hit_in) · damage taken   (expected HP lost per beat)
 *
 * `net` is returned as a COST (lower is better) so it drops straight into an
 * operator `cost` or, negated, into a method `utility`. The single `riskAversion`
 * knob (the scenario's `caution` fluent / a personality value) multiplies the risk
 * term: a low value fights in the open, a high value seeks cover and breaks contact.
 *
 * Pure and deterministic — no engine dependency — so behavior can be unit-tested
 * directly (tests/combat-model.ts) instead of inferred from a rollout.
 */

export interface ShotParams {
  /** probability a shot lands, in [0,1] */
  pHit: number;
  /** HP removed by a landed shot */
  damage: number;
}

export interface ExchangeInput {
  /** my shot on the target */
  outgoing: ShotParams;
  /** an average enemy shot on me (per exposed enemy) */
  incoming: ShotParams;
  /** how many enemies currently have a clear shot on me (from the spatial field) */
  exposedEnemies: number;
  /** shots I expect to need to resolve the engagement */
  shotsToResolve: number;
  /** the single risk-aversion knob (caution / personality); 1 = neutral */
  riskAversion: number;
  /** height advantage in [0,1]: raises my reward, lowers my risk (high ground) */
  heightAdvantage?: number;
}

export interface ExchangeCost {
  /** expected HP dealt per shot (higher is better) */
  reward: number;
  /** expected HP taken per beat (higher is worse) */
  risk: number;
  /** the scalar the planner minimizes — expected-HP currency (lower is better) */
  net: number;
}

const EPS = 1e-6;

/** Compute the expected-HP economics of fighting an engagement under given conditions. */
export function exchangeCost(i: ExchangeInput): ExchangeCost {
  const ha = clamp01(i.heightAdvantage ?? 0);
  const reward = Math.max(0, i.outgoing.pHit * i.outgoing.damage) * (1 + ha);
  const risk = Math.max(0, i.exposedEnemies * i.incoming.pHit * i.incoming.damage) * (1 - 0.5 * ha);
  const shots = Math.max(0, i.shotsToResolve);
  const net = shots * (1 / (reward + EPS)) + i.riskAversion * shots * risk;
  return { reward, risk, net };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
