/**
 * Position-queryable spatial / influence field (capability C6) — the
 * rollout-correctness centerpiece.
 *
 * A field is built ONCE per replan from an immutable snapshot of believed threats
 * plus the static map geometry. It is queryable at any position in O(1)-ish time:
 *   • exposureAt(x,z,elev)         — how many snapshot threats can shoot that spot
 *   • exposureIntegral(a→b, elev)  — threat-aware path cost (expected exposure en route)
 *
 * CRITICAL (rollout correctness): the field closes over the threat *snapshot*, never
 * over a live world. During planning the planner rolls `myPos` forward through
 * `planOnly` effects; an external samples this field at the PROJECTED `myPos`
 * (q.vec("myPos")) against the constant snapshot — so step-2 of a plan is evaluated
 * at the position step-1 moved to, with threats as last believed. Reading live actor
 * positions here would silently break multi-step lookahead; this module makes that
 * impossible by construction (it has no `world` reference).
 */

import { type Box, type Foe, type Vec2, dist2, exposureAt as geomExposureAt } from "./geometry";

export interface ThreatSnapshot {
  pos: Vec2;
  elev: number;
  alive: boolean;
}

export interface SpatialField {
  /** how many snapshot threats can shoot (px,pz,pElev) */
  exposureAt(px: number, pz: number, pElev: number): number;
  /** integral of exposure along the segment a→b (fixed-step sampling) — threat-aware path cost */
  exposureIntegral(ax: number, az: number, bx: number, bz: number, pElev: number): number;
  /** the snapshot the field was built from (for assertions / telemetry) */
  threats: ThreatSnapshot[];
}

export interface FieldConfig {
  reach: number;
  sight: number;
  /** sampling step (world units) for the path-exposure integral */
  integralStep: number;
}

/**
 * Build an immutable spatial field from a threat snapshot + static geometry. The
 * returned object reads nothing else; calling it after the world moves yields the
 * same answers (it reflects belief at snapshot time, which is the only honest model
 * during a forward rollout).
 */
export function buildField(threats: ThreatSnapshot[], walls: Box[], softCovers: Box[], cfg: FieldConfig): SpatialField {
  // freeze a private copy of the live foes so later mutation of the source can't leak in
  const foes: Foe[] = threats.filter((t) => t.alive).map((t) => ({ x: t.pos.x, z: t.pos.z, elev: t.elev }));
  const snapshot: ThreatSnapshot[] = threats.map((t) => ({ pos: { x: t.pos.x, z: t.pos.z }, elev: t.elev, alive: t.alive }));
  const wallsCopy = walls.map((w) => ({ ...w }));
  const coversCopy = softCovers.map((c) => ({ ...c }));

  const exposureAt = (px: number, pz: number, pElev: number): number => geomExposureAt(px, pz, pElev, foes, wallsCopy, coversCopy, cfg.reach, cfg.sight);

  const exposureIntegral = (ax: number, az: number, bx: number, bz: number, pElev: number): number => {
    const len = dist2(ax, az, bx, bz);
    const steps = Math.max(1, Math.ceil(len / cfg.integralStep));
    // midpoint rule: one sample centered in each segment so the WHOLE path is covered
    // (including the danger near the endpoints), scaled by length — a long exposed
    // crossing costs more than a short one.
    let sum = 0;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      sum += exposureAt(ax + (bx - ax) * t, az + (bz - az) * t, pElev);
    }
    return (sum / steps) * len;
  };

  return { exposureAt, exposureIntegral, threats: snapshot };
}
