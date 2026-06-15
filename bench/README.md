# Benchmarks

```bash
npm run bench          # representative set, robust stats
npm run bench:scale    # scaling sweeps across axes
# lowest noise: prefix either with NODE_OPTIONS=--expose-gc
```

## Methodology (signal over noise)

`measure()` in `workloads.ts`:

- **warms up** so the JIT has settled before timing;
- **auto-calibrates** the inner loop so each timed trial runs ≳ `targetMs`
  (timer resolution & per-batch overhead become negligible);
- runs **several independent trials** and reports the **min ms/iter** as the
  headline — all interference (GC, scheduler preemption, CPU-freq dips) only
  *adds* time, so the minimum is the sample least contaminated by it;
- also prints **median** and **spread% = (median−min)/min** so the noise is
  visible rather than hidden (tiny sub-0.1 ms workloads show large spread —
  trust the min);
- calls `global.gc()` between trials when run with `--expose-gc`, so GC pauses
  fall outside the timed window.

The number that matters for a frame budget is **µs/node = min ÷ expansions** —
per-node cost, independent of problem size.

## Files

- `workloads.ts` — shared, parametric workload builders + `measure()`.
- `bench.ts` — representative set with min/median/spread/µs-node columns.
- `scale.ts` — sweeps each workload along one axis (`×prev` = growth factor of
  min-ms vs the previous size, so super-linear scaling is obvious):
  - **hanoi disks** — exponential search depth + external predicate per node
  - **blocks** — grounding O(n³) + state size, shallow search
  - **nav grid** — relational adjacency: candidates/node grow with cells
  - **htn tour** — HTN decomposition width (free-variable binding)
  - **scheduler** — multi-agent round-robin
  - **weight** — heuristic informativeness → expansions (fixed problem)
- `profile.ts` — single-scenario driver for `--cpu-prof` (set `SCEN`, `ITERS`).

See [`../PERFORMANCE.md`](../PERFORMANCE.md) for the analysis.
