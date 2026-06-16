import { test } from "uvu";
import * as assert from "uvu/assert";
import { type ExchangeInput, exchangeCost } from "../src/index";

/**
 * Expected-HP currency unit tests — the multi-objective cost (C4). These pin the
 * monotonicity the planner relies on: more reward is cheaper, more risk is dearer,
 * the risk-aversion knob only bites when there is risk, and high ground helps.
 */

const base: ExchangeInput = {
  outgoing: { pHit: 0.7, damage: 24 },
  incoming: { pHit: 0.5, damage: 24 },
  exposedEnemies: 1,
  shotsToResolve: 5,
  riskAversion: 1,
};

test("combat: reward rises with outgoing pHit and damage", () => {
  const lo = exchangeCost(base).reward;
  const hi = exchangeCost({ ...base, outgoing: { pHit: 0.95, damage: 24 } }).reward;
  const hiD = exchangeCost({ ...base, outgoing: { pHit: 0.7, damage: 40 } }).reward;
  assert.ok(hi > lo, "more accuracy → more expected damage dealt");
  assert.ok(hiD > lo, "more damage → more expected damage dealt");
});

test("combat: risk rises with exposed enemies and incoming accuracy", () => {
  const one = exchangeCost(base).risk;
  const two = exchangeCost({ ...base, exposedEnemies: 2 }).risk;
  const acc = exchangeCost({ ...base, incoming: { pHit: 0.9, damage: 24 } }).risk;
  assert.ok(two > one, "two shooters → more expected damage taken");
  assert.ok(acc > one, "more accurate incoming fire → more risk");
});

test("combat: net is strictly increasing in riskAversion WHEN there is risk", () => {
  const a = exchangeCost({ ...base, riskAversion: 0.5 }).net;
  const b = exchangeCost({ ...base, riskAversion: 1.5 }).net;
  assert.ok(b > a, `more cautious ⇒ exposed engagement costs more (${b} > ${a})`);
});

test("combat: net is INDEPENDENT of riskAversion when there is no risk (knob isolation)", () => {
  const safe: ExchangeInput = { ...base, exposedEnemies: 0 };
  const a = exchangeCost({ ...safe, riskAversion: 0.2 }).net;
  const b = exchangeCost({ ...safe, riskAversion: 5 }).net;
  assert.ok(Math.abs(a - b) < 1e-9, "with zero exposure, caution doesn't change the cost");
});

test("combat: net increases with shots-to-resolve", () => {
  const few = exchangeCost({ ...base, shotsToResolve: 2 }).net;
  const many = exchangeCost({ ...base, shotsToResolve: 8 }).net;
  assert.ok(many > few, "a longer firefight costs more");
});

test("combat: height advantage raises reward and lowers risk", () => {
  const flat = exchangeCost(base);
  const high = exchangeCost({ ...base, heightAdvantage: 1 });
  assert.ok(high.reward > flat.reward, "high ground deals more");
  assert.ok(high.risk < flat.risk, "high ground takes less");
  assert.ok(high.net < flat.net, "so fighting from high ground is cheaper");
});

test.run();
