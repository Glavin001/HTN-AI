import { test } from "uvu";
import * as assert from "uvu/assert";
import { DomainDoc, E, F, type ExtQuery, createModel, goal, planOnce } from "../src/index";

/**
 * Symbolic relaxation hints (`relax` over-approximations on external/opaque
 * predicates). A predicate the heuristic can't see through (opaque) or chooses
 * to (external) is normally invisible to the delete-relaxation — so h can't
 * account for what it gates. Attaching a *sound necessary condition* lets the
 * relaxation fold those atoms in, making h informative again, while the real
 * applicability check still runs unchanged.
 */

// K independent subgoals: finish(x) needs prepared(x), but that requirement is
// behind an opaque/external `ready` predicate. `fiddle` is an always-applicable
// decoy that looks like progress to a blind heuristic.
function prepDomain(predicate: "opaque" | "external", withHint: boolean): DomainDoc {
  const hint = F.lit("prepared", ["?x"]);
  const ready =
    predicate === "opaque"
      ? F.opaque("ready", withHint ? hint : undefined)
      : // reads are the *contract* (ready reads prepared) — independent of the
        // optional `relax` hint, which only feeds the heuristic
        F.ext("ready", ["?x"], ["prepared"], withHint ? hint : undefined);
  return {
    name: "prep",
    types: [{ name: "item" }],
    fluents: [
      { name: "prepared", params: [{ name: "x", type: "item" }], kind: "boolean", initial: false },
      { name: "done", params: [{ name: "x", type: "item" }], kind: "boolean", initial: false },
      { name: "noise", params: [{ name: "x", type: "item" }], kind: "int", initial: 0 },
    ],
    operators: [
      { name: "prepare", params: [{ name: "x", type: "item" }], pre: F.not(F.lit("prepared", ["?x"])), eff: [E.set("prepared", ["?x"], true)] },
      { name: "finish", params: [{ name: "x", type: "item" }], pre: F.and(F.not(F.lit("done", ["?x"])), ready), eff: [E.set("done", ["?x"], true)] },
      { name: "fiddle", params: [{ name: "x", type: "item" }], eff: [E.inc("noise", ["?x"], 1)] }, // decoy
    ],
    methods: [],
  };
}

function solve(predicate: "opaque" | "external", withHint: boolean, k: number) {
  const ents = Object.fromEntries(Array.from({ length: k }, (_, i) => [`i${i}`, "item"]));
  const reg = { predicates: { ready: (q: ExtQuery) => q.get("prepared", q.args[0]) === 1 } };
  const model = createModel(prepDomain(predicate, withHint), { entities: ents }, reg);
  const goalF = F.and(...Array.from({ length: k }, (_, i) => F.lit("done", [`i${i}`])));
  return planOnce(model, model.createExecState(), { goals: [goal(goalF)], weight: 1, heuristic: "hadd" });
}

test("relax hint: an over-approximation makes an opaque-gated heuristic informative", () => {
  const k = 5;
  const no = solve("opaque", false, k);
  const yes = solve("opaque", true, k);

  assert.equal(no.status, "success");
  assert.equal(yes.status, "success");
  // identical optimal plan length — the hint only informs h, not the result
  assert.equal(yes.plan!.steps.length, 2 * k, "prepare+finish per item");
  assert.equal(no.plan!.steps.length, yes.plan!.steps.length, "same optimal length with or without the hint");
  // the heuristic is no longer blind to the opaque gate ⇒ far less search
  assert.ok(no.stats.expansions > 500, `blind search should flail (got ${no.stats.expansions})`);
  assert.ok(yes.stats.expansions < 100, `hinted search should be tight (got ${yes.stats.expansions})`);
  assert.ok(yes.stats.expansions * 10 < no.stats.expansions, "hint cuts expansions by >10x");
});

test("relax hint: works on external predicates too (declared reads + relax)", () => {
  const k = 5;
  const no = solve("external", false, k);
  const yes = solve("external", true, k);
  assert.equal(yes.status, "success");
  assert.equal(yes.plan!.steps.length, no.plan!.steps.length);
  assert.ok(yes.stats.expansions * 10 < no.stats.expansions, `external hint should cut search (got ${yes.stats.expansions} vs ${no.stats.expansions})`);
});

test("relax hint: stays admissible — hmax + weight 1 still optimal", () => {
  // a sound necessary condition only raises h toward the true cost, so an
  // admissible search keeps finding the optimum (just faster).
  const k = 4;
  const ents = Object.fromEntries(Array.from({ length: k }, (_, i) => [`i${i}`, "item"]));
  const reg = { predicates: { ready: (q: ExtQuery) => q.get("prepared", q.args[0]) === 1 } };
  const model = createModel(prepDomain("opaque", true), { entities: ents }, reg);
  const goalF = F.and(...Array.from({ length: k }, (_, i) => F.lit("done", [`i${i}`])));
  const r = planOnce(model, model.createExecState(), { goals: [goal(goalF)], weight: 1, heuristic: "hmax" });
  assert.equal(r.status, "success");
  assert.equal(r.plan!.steps.length, 2 * k, "still the optimal prepare+finish-per-item plan");
});

test.run();
