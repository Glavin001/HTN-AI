# Benchmarks

Micro-benchmarks for the planning core. Run with:

```bash
npm run bench
```

- `bench.ts` — wall-clock + engine counters (decompositions / expansions /
  heuristicEvals) across the heaviest GOAP/HTN workloads, including
  scalable blocks-world and Towers-of-Hanoi instances. The
  `ms/iter ÷ expansions` ratio is the headline number: it is the *per-node*
  cost, which is what determines whether a domain fits a frame budget.
- `profile.ts` — focused driver for the quarry search, for use under a CPU
  profiler:

  ```bash
  NODE_OPTIONS="--cpu-prof --cpu-prof-dir=/tmp/prof --cpu-prof-interval=200" \
    ITERS=300 npx tsx --tsconfig tsconfig.tests.json bench/profile.ts
  ```

  (tsx runs the workload in a worker thread, so pick the largest
  `.cpuprofile` — the others are the loader/main process.)

See [`../PERFORMANCE.md`](../PERFORMANCE.md) for the analysis these drive.
