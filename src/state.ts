/**
 * Packed state runtime (SPEC §6).
 *
 * All state lives in numeric slots (one flat Float64 address space):
 *   slot 0           — the clock (seconds; projected during planning, actual during execution)
 *   slots 1..N       — fluent tables laid out by the compiler
 * Values are encoded numerically: boolean 0/1, enum value-index, entity gid+1 (0 = null),
 * int/float identity, vec components in consecutive slots.
 *
 * Planning rolls out over copy-on-write StateViews (delta chains over a base
 * snapshot) with incremental Zobrist-style hashing for O(1) visited keys.
 */

export const CLOCK_SLOT = 0;

/** Read-only view of a state. */
export interface Snap {
  get(slot: number): number;
}

// ---------------------------------------------------------------- hashing

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Hash contribution of (slot, value); xor-composable so writes update incrementally. */
function slotValueHash(slot: number, value: number): number {
  f64[0] = value;
  const v = mix32(u32[0] ^ Math.imul(u32[1], 0x9e3779b1));
  return mix32((slot + 0x517cc1b7) ^ Math.imul(v, 0x85ebca77)) >>> 0;
}

export function hashBase(base: Float64Array): number {
  let h = 0x811c9dc5;
  for (let slot = 0; slot < base.length; slot++) {
    if (base[slot] !== 0) h = (h ^ slotValueHash(slot, base[slot])) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------- copy-on-write views

const MAX_CHAIN_DEPTH = 24;

/**
 * Immutable-after-build copy-on-write state. Create children with `child()`,
 * write into a child while building it, then treat it as frozen.
 */
export class StateView implements Snap {
  private readonly base: Float64Array;
  private readonly parent: StateView | null;
  private readonly deltas: Map<number, number>;
  private readonly depth: number;
  /** xor-composed hash over all (slot,value≠0) pairs */
  public hash: number;

  private constructor(base: Float64Array, parent: StateView | null, hash: number, depth: number) {
    this.base = base;
    this.parent = parent;
    this.deltas = new Map();
    this.depth = depth;
    this.hash = hash;
  }

  static fromBase(base: Float64Array): StateView {
    return new StateView(base, null, hashBase(base), 0);
  }

  /** Create a writable child view. */
  child(): StateView {
    if (this.depth >= MAX_CHAIN_DEPTH) {
      // collapse the chain into a fresh base copy
      const flat = this.materialize();
      return new StateView(flat, null, this.hash, 1);
    }
    return new StateView(this.base, this, this.hash, this.depth + 1);
  }

  get(slot: number): number {
    const own = this.deltas.get(slot);
    if (own !== undefined) return own;
    let p = this.parent;
    while (p !== null) {
      const v = p.deltas.get(slot);
      if (v !== undefined) return v;
      p = p.parent;
    }
    return this.base[slot];
  }

  set(slot: number, value: number): void {
    const old = this.get(slot);
    if (old === value) return;
    if (old !== 0) this.hash = (this.hash ^ slotValueHash(slot, old)) >>> 0;
    if (value !== 0) this.hash = (this.hash ^ slotValueHash(slot, value)) >>> 0;
    this.deltas.set(slot, value);
  }

  materialize(): Float64Array {
    const flat = this.base.slice();
    const chain: StateView[] = [];
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let v: StateView | null = this;
    while (v !== null) {
      chain.push(v);
      v = v.parent;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      for (const [slot, value] of chain[i].deltas) flat[slot] = value;
    }
    return flat;
  }

  get clock(): number {
    return this.get(CLOCK_SLOT);
  }

  key(): number {
    return this.hash;
  }
}

// ---------------------------------------------------------------- executing (live) state

/**
 * The live world state during execution: a single mutable buffer with
 * fluent-level dirty tracking for precise replan triggers (SPEC §6).
 */
export class ExecState implements Snap {
  public readonly buffer: Float64Array;
  /** fluent ids written since the last plan was installed */
  public readonly dirtyFluents = new Set<number>();
  public version = 0;
  /** maps slot → owning fluent id (filled by the compiler) */
  private readonly slotOwner: Int32Array;
  private suppressDirty = false;

  constructor(buffer: Float64Array, slotOwner: Int32Array) {
    this.buffer = buffer;
    this.slotOwner = slotOwner;
  }

  get(slot: number): number {
    return this.buffer[slot];
  }

  set(slot: number, value: number): void {
    if (this.buffer[slot] === value) return;
    this.buffer[slot] = value;
    this.version++;
    if (this.suppressDirty) return;
    const owner = this.slotOwner[slot];
    if (owner >= 0) this.dirtyFluents.add(owner);
  }

  /**
   * Apply writes the active plan *expects* (operator effects) without marking
   * the world dirty — only un-anticipated changes should trigger replanning.
   */
  withPlannedWrites<T>(fn: () => T): T {
    const prev = this.suppressDirty;
    this.suppressDirty = true;
    try {
      return fn();
    } finally {
      this.suppressDirty = prev;
    }
  }

  /** Write without dirty-tracking (used for the clock and internal bookkeeping). */
  setSilent(slot: number, value: number): void {
    this.buffer[slot] = value;
  }

  clearDirty(): void {
    this.dirtyFluents.clear();
  }

  view(): StateView {
    return StateView.fromBase(this.buffer.slice());
  }

  get clock(): number {
    return this.buffer[CLOCK_SLOT];
  }
}
