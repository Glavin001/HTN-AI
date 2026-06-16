/**
 * Pure 2.5D tactical geometry — world-agnostic functions over plain arguments (no
 * mutable combat state). These are the spatial primitives shared by the single-agent
 * solo-combat scenario: line-of-sight, directional soft cover, exposure, walkable
 * pathfinding, and tactical-spot generation.
 *
 * 2.5D model: navigation is 2D (x,z); every position and obstacle also carries a
 * scalar elevation/height. A soft-cover crate has a top height; a shooter (or target)
 * standing higher than that top "sees over" the crate, so the cover lapses — which is
 * what makes high ground a real advantage. Line-of-sight itself is computed on 2D
 * footprints (no volumetric tracing), keeping it fast and deterministic.
 *
 * Lifted/adapted from scenarios/squad-combat.ts (which keeps its own 2D copies — a
 * later DRY pass is mechanical and out of scope). The squad suite is unaffected.
 */

export interface Vec2 {
  x: number;
  z: number;
}

/** An axis-aligned obstacle footprint. `height` is the top (for 2.5D cover lapse). */
export interface Box {
  x: number;
  z: number;
  w: number;
  d: number;
  /** top height of the obstacle; used only for soft-cover lapse (default COVER_TOP) */
  height?: number;
}

/** Default soft-cover top height — a shooter above this sees over the crate. */
export const COVER_TOP = 1.0;

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}

/** Segment (a→b) vs axis-aligned box intersection (slab method) — used for LOS. */
export function segHitsBox(ax: number, az: number, bx: number, bz: number, b: Box): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  let t0 = 0;
  let t1 = 1;
  const minX = b.x;
  const maxX = b.x + b.w;
  const minZ = b.z;
  const maxZ = b.z + b.d;
  for (const [p, q0] of [
    [-dx, ax - minX],
    [dx, maxX - ax],
    [-dz, az - minZ],
    [dz, maxZ - az],
  ] as [number, number][]) {
    if (p === 0) {
      if (q0 < 0) return false; // parallel and outside this slab
    } else {
      const t = q0 / p;
      if (p < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return t0 <= t1;
}

/** Distance from a point to an axis-aligned box (0 if inside). */
export function distToBox(px: number, pz: number, b: Box): number {
  const dx = Math.max(b.x - px, 0, px - (b.x + b.w));
  const dz = Math.max(b.z - pz, 0, pz - (b.z + b.d));
  return Math.hypot(dx, dz);
}

/** The four padded corners of a box, as candidate path waypoints. */
export function boxCorners(b: Box, pad: number): Vec2[] {
  return [
    { x: b.x - pad, z: b.z - pad },
    { x: b.x + b.w + pad, z: b.z - pad },
    { x: b.x - pad, z: b.z + b.d + pad },
    { x: b.x + b.w + pad, z: b.z + b.d + pad },
  ];
}

/** Position reached by walking `dist` along a polyline; `done` once past the end. */
export function walkPolyline(path: Vec2[], dist: number): { x: number; z: number; done: boolean } {
  let rem = dist;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = dist2(path[i].x, path[i].z, path[i + 1].x, path[i + 1].z);
    if (rem <= seg) {
      const t = seg > 0 ? rem / seg : 1;
      return { x: lerp(path[i].x, path[i + 1].x, t), z: lerp(path[i].z, path[i + 1].z, t), done: false };
    }
    rem -= seg;
  }
  const last = path[path.length - 1];
  return { x: last.x, z: last.z, done: true };
}

/** Is the straight line (a→b) clear of every wall in `walls`? */
export function losClear(ax: number, az: number, bx: number, bz: number, walls: Box[]): boolean {
  for (const w of walls) if (segHitsBox(ax, az, bx, bz, w)) return false;
  return true;
}

/**
 * Is a unit at (px,pz,pElev) in soft cover against a shooter at (ex,ez,eElev)? True
 * when a crate it is hugging sits on the line between them AND neither the shooter
 * nor the unit stands above the crate's top (2.5D lapse — high ground sees over).
 */
export function inCoverVs(
  px: number,
  pz: number,
  pElev: number,
  ex: number,
  ez: number,
  eElev: number,
  softCovers: Box[],
  reach: number,
): boolean {
  for (const c of softCovers) {
    if (distToBox(px, pz, c) > reach) continue; // must be hugging THIS crate
    const top = c.height ?? COVER_TOP;
    if (eElev > top + 1e-9 || pElev > top + 1e-9) continue; // someone is above it → no cover
    if (segHitsBox(px, pz, ex, ez, c)) return true; // crate blocks the incoming line
  }
  return false;
}

export interface Foe {
  x: number;
  z: number;
  elev: number;
}

/**
 * How many of `foes` currently have a clear line of fire on (px,pz,pElev): within
 * sight, LOS not blocked by a wall, and no soft cover denies them. The exposure of a
 * spot — the danger lever the planner reasons over.
 */
export function exposureAt(
  px: number,
  pz: number,
  pElev: number,
  foes: Foe[],
  walls: Box[],
  softCovers: Box[],
  reach: number,
  sight: number,
): number {
  let n = 0;
  for (const f of foes) {
    if (dist2(px, pz, f.x, f.z) > sight) continue;
    if (!losClear(px, pz, f.x, f.z, walls)) continue; // a wall already shields you
    if (inCoverVs(px, pz, pElev, f.x, f.z, f.elev, softCovers, reach)) continue; // a crate denies this shooter
    n++;
  }
  return n;
}

/** How many of `foes` this spot has soft cover against (its defensive value). */
export function coverCountAt(
  px: number,
  pz: number,
  pElev: number,
  foes: Foe[],
  softCovers: Box[],
  reach: number,
  sight: number,
): number {
  let n = 0;
  for (const f of foes) if (dist2(px, pz, f.x, f.z) <= sight && inCoverVs(px, pz, pElev, f.x, f.z, f.elev, softCovers, reach)) n++;
  return n;
}

const UNIT_RADIUS_DEFAULT = 0.6;

/**
 * Shortest walkable path from (ax,az) to (bx,bz) around obstacles (visibility graph
 * over padded box corners + Dijkstra). Returns waypoints including the goal. Straight
 * line if already clear; best-effort straight line if the goal is unreachable.
 */
export function findPath(ax: number, az: number, bx: number, bz: number, walls: Box[], unitRadius = UNIT_RADIUS_DEFAULT): Vec2[] {
  if (walls.every((w) => !segHitsBox(ax, az, bx, bz, w))) return [{ x: bx, z: bz }];
  const inside = (p: Vec2) => walls.some((w) => p.x > w.x - 0.01 && p.x < w.x + w.w + 0.01 && p.z > w.z - 0.01 && p.z < w.z + w.d + 0.01);
  const nodes: Vec2[] = [{ x: ax, z: az }, ...walls.flatMap((w) => boxCorners(w, unitRadius)).filter((c) => !inside(c)), { x: bx, z: bz }];
  const n = nodes.length;
  const clear = (i: number, j: number) => walls.every((w) => !segHitsBox(nodes[i].x, nodes[i].z, nodes[j].x, nodes[j].z, w));
  const adj: number[][] = nodes.map(() => []);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (clear(i, j)) { adj[i].push(j); adj[j].push(i); }
  const dist = new Array(n).fill(Infinity);
  const prev = new Array(n).fill(-1);
  const done = new Array(n).fill(false);
  dist[0] = 0;
  for (let it = 0; it < n; it++) {
    let u = -1;
    let best = Infinity;
    for (let k = 0; k < n; k++) if (!done[k] && dist[k] < best) { best = dist[k]; u = k; }
    if (u < 0) break;
    done[u] = true;
    for (const v of adj[u]) {
      const d = dist[u] + dist2(nodes[u].x, nodes[u].z, nodes[v].x, nodes[v].z);
      if (d < dist[v]) { dist[v] = d; prev[v] = u; }
    }
  }
  if (dist[n - 1] === Infinity) return [{ x: bx, z: bz }];
  const path: Vec2[] = [];
  for (let cur = n - 1; cur > 0; cur = prev[cur]) path.unshift({ x: nodes[cur].x, z: nodes[cur].z });
  return path;
}

export interface SpotGenOpts {
  walls: Box[];
  softCovers: Box[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  gridSpacing: number;
  unitRadius?: number;
  max: number;
}

/**
 * Generate invisible tactical standing positions the planner evaluates: padded
 * corners + edge-midpoints of every obstacle ("peek the angle" / "tuck behind"),
 * plus a coarse walkable grid. Deterministic and capped so branching stays bounded.
 */
export function generateTacticalSpots(opts: SpotGenOpts): Vec2[] {
  const { walls, softCovers, bounds, gridSpacing, max } = opts;
  const radius = opts.unitRadius ?? UNIT_RADIUS_DEFAULT;
  const obstacles: Box[] = [...walls, ...softCovers];
  const insideWall = (x: number, z: number) => walls.some((w) => x > w.x - 0.3 && x < w.x + w.w + 0.3 && z > w.z - 0.3 && z < w.z + w.d + 0.3);
  const pts: Vec2[] = [];
  const EDGE = radius + 0.7;
  for (const o of obstacles) {
    const cx = o.x + o.w / 2;
    const cz = o.z + o.d / 2;
    const offs: [number, number][] = [
      [-1, -1], [1, -1], [-1, 1], [1, 1],
      [0, -1], [0, 1], [-1, 0], [1, 0],
    ];
    for (const [sx, sz] of offs) {
      const x = cx + sx * (o.w / 2 + EDGE);
      const z = cz + sz * (o.d / 2 + EDGE);
      if (!insideWall(x, z)) pts.push({ x, z });
    }
  }
  for (let x = bounds.minX; x <= bounds.maxX; x += gridSpacing) for (let z = bounds.minZ; z <= bounds.maxZ; z += gridSpacing) if (!insideWall(x, z)) pts.push({ x, z });
  // dedupe with a tight radius so cover-edge spots (corners AND edge-midpoints, which
  // are the directional-cover firing positions) all survive — a coarse radius merges
  // the midpoint into a corner and loses the only covered spot.
  const near = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z) < 1.2;
  const kept: Vec2[] = [];
  for (const p of pts) {
    if (kept.some((k) => near(k, p))) continue;
    kept.push(p);
  }
  return kept.slice(0, max);
}
