import { test } from "uvu";
import * as assert from "uvu/assert";
import { DomainDoc, E, F, N, createModel, goal, planOnce } from "../src/index";

/**
 * Job scheduling (the PR #14 "scheduling" scenario) as a genuine temporal
 * planning problem: the planner sequences jobs on a single machine so every
 * job finishes before its deadline and precedence is respected — using the
 * projected clock (SPEC §4.13) to prune orderings that miss a deadline inside
 * the search itself.
 */

test("scheduling: sequence jobs to meet deadlines + precedence (projected-clock pruning)", () => {
  const doc: DomainDoc = {
    name: "schedule",
    types: [{ name: "job" }],
    fluents: [
      { name: "done", params: [{ name: "j", type: "job" }], kind: "boolean" },
      { name: "dur", params: [{ name: "j", type: "job" }], kind: "float" },
      { name: "deadline", params: [{ name: "j", type: "job" }], kind: "float" },
      // prereq(a, b): a must finish before b may start
      {
        name: "prereq",
        params: [
          { name: "a", type: "job" },
          { name: "b", type: "job" },
        ],
        kind: "boolean",
      },
    ],
    operators: [
      {
        name: "run",
        params: [{ name: "j", type: "job" }],
        pre: F.and(
          F.not(F.lit("done", ["?j"])),
          // all prerequisites complete (T2: reads done/prereq across all jobs)
          F.ext("prereqsMet", ["?j"], ["done", "prereq"]),
          // must finish before the deadline: clock + duration ≤ deadline
          F.lte(N.add(N.clock(), N.fl("dur", "?j")), N.fl("deadline", "?j")),
        ),
        duration: N.fl("dur", "?j"),
        eff: [E.set("done", ["?j"], true)],
      },
    ],
  };
  const jobs = ["weld", "paint", "inspect", "ship"];
  const durations: Record<string, number> = { weld: 3, paint: 2, inspect: 1, ship: 2 };
  const deadlines: Record<string, number> = { weld: 3, paint: 6, inspect: 7, ship: 8 };
  const model = createModel(
    doc,
    {
      entities: Object.fromEntries(jobs.map((j) => [j, "job"])),
      init: (w) => {
        for (const j of jobs) {
          w.set("dur", [j], durations[j]);
          w.set("deadline", [j], deadlines[j]);
        }
        // paint after weld; inspect after paint; ship after inspect
        w.set("prereq", ["weld", "paint"], true);
        w.set("prereq", ["paint", "inspect"], true);
        w.set("prereq", ["inspect", "ship"], true);
      },
    },
    {
      predicates: {
        prereqsMet: (q) => {
          const j = q.args[0];
          for (const other of jobs) {
            const og = q.gid(other);
            if (q.get("prereq", og, j) === 1 && q.get("done", og) !== 1) return false;
          }
          return true;
        },
      },
    },
  );
  const result = planOnce(model, model.createExecState(), {
    goals: [goal(F.and(...jobs.map((j) => F.lit("done", [j]))))],
    weight: 1,
  });
  assert.equal(result.status, "success");
  const ops = result.plan!.steps.filter((s) => s.k === "op").map((s) => (s.k === "op" ? model.entityName(s.g.b[0]) : "?"));
  // weld's deadline (3) equals its duration (3) → it MUST run first; precedence forces the rest
  assert.equal(ops, ["weld", "paint", "inspect", "ship"], "the unique feasible ordering");
  assert.equal(result.plan!.makespan, 8, "3+2+1+2 = 8, the last job lands exactly on its deadline");

  // tighten ship's deadline below feasibility → search proves it impossible
  const infeasible = createModel(
    doc,
    {
      entities: Object.fromEntries(jobs.map((j) => [j, "job"])),
      init: (w) => {
        for (const j of jobs) {
          w.set("dur", [j], durations[j]);
          w.set("deadline", [j], j === "ship" ? 7 : deadlines[j]); // ship must end ≤7 but can't start before 6
        }
        w.set("prereq", ["weld", "paint"], true);
        w.set("prereq", ["paint", "inspect"], true);
        w.set("prereq", ["inspect", "ship"], true);
      },
    },
    {
      predicates: {
        prereqsMet: (q) => {
          const j = q.args[0];
          for (const other of jobs) {
            const og = q.gid(other);
            if (q.get("prereq", og, j) === 1 && q.get("done", og) !== 1) return false;
          }
          return true;
        },
      },
    },
  );
  const noPlan = planOnce(infeasible, infeasible.createExecState(), {
    goals: [goal(F.and(...jobs.map((j) => F.lit("done", [j]))))],
    weight: 1,
    collectRejections: true,
  });
  assert.equal(noPlan.status, "failure", "ship needs 2 units after t=6 but its deadline is 7 — infeasible");
});

test.run();
