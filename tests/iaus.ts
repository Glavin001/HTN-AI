import { test } from "uvu";
import * as assert from "uvu/assert";
import { type Consideration, type ResponseCurve, curve, rankOptions, scoreOption } from "../src/index";

/**
 * IAUS unit tests — response-curve shapes, geometric-mean compensation, weight
 * behavior, and deterministic ranking. These pin the pure scoring primitive the
 * solo-combat scenario uses to make posture/spot selection emerge from data.
 */

// ---------------------------------------------------------------- response curves

test("iaus: curves clamp the input and the output to [0,1]", () => {
  assert.equal(curve({ kind: "linear" }, -5), 0, "negative input clamps to 0");
  assert.equal(curve({ kind: "linear" }, 5), 1, "above-1 input clamps to 1");
  assert.equal(curve({ kind: "linear", m: 10 }, 0.5), 1, "output clamps to 1");
});

test("iaus: linear / poly / step / const evaluate as specified", () => {
  assert.equal(curve({ kind: "linear", m: 1, b: 0 }, 0.4), 0.4);
  assert.equal(curve({ kind: "poly", exp: 2 }, 0.5), 0.25, "quadratic");
  assert.equal(curve({ kind: "step", at: 0.6 }, 0.59), 0, "below the step");
  assert.equal(curve({ kind: "step", at: 0.6 }, 0.6), 1, "at the step");
  assert.equal(curve({ kind: "const", value: 0.3 }, 0.99), 0.3, "const ignores input");
});

test("iaus: logistic is monotonic increasing and centered at x0", () => {
  const c: ResponseCurve = { kind: "logistic", k: 12, x0: 0.5 };
  assert.ok(Math.abs(curve(c, 0.5) - 0.5) < 1e-9, "centered at x0 → 0.5");
  let prev = -1;
  for (let x = 0; x <= 1.0001; x += 0.1) {
    const v = curve(c, x);
    assert.ok(v >= prev - 1e-9, `monotonic increasing at x=${x.toFixed(1)} (${v} >= ${prev})`);
    prev = v;
  }
});

// ---------------------------------------------------------------- scoring

interface Ctx {
  safety: number; // [0,1]
  range: number; // [0,1]
}
const cons: Consideration<Ctx>[] = [
  { name: "safety", read: (c) => c.safety, normalize: (r) => r, curve: { kind: "linear" } },
  { name: "range", read: (c) => c.range, normalize: (r) => r, curve: { kind: "linear" } },
];

test("iaus: a single zero consideration zeros the whole option", () => {
  const s = scoreOption({}, { safety: 0, range: 0.9 }, cons);
  assert.equal(s.score, 0, "one veto kills the option");
});

test("iaus: more equal considerations don't crush a strong option (compensation)", () => {
  // raw geometric product of 0.5×0.5×0.5×0.5 = 0.0625; with make-up compensation
  // the score stays meaningfully above the naive product.
  const four: Consideration<Ctx>[] = [cons[0], cons[1], cons[0], cons[1]];
  const s = scoreOption({}, { safety: 0.5, range: 0.5 }, four);
  assert.ok(s.score > 0.0625, `compensation lifts above the naive product (${s.score})`);
  assert.ok(s.score < 0.5, "but a 0.5 option never scores like a 1.0 one");
});

test("iaus: terms[] reports each consideration's curved factor (telemetry)", () => {
  const s = scoreOption({}, { safety: 0.2, range: 0.8 }, cons);
  assert.equal(s.terms.length, 2);
  assert.equal(s.terms[0].name, "safety");
  assert.ok(Math.abs(s.terms[0].value - 0.2) < 1e-9, "safety factor reflects the curve");
  assert.ok(Math.abs(s.terms[1].value - 0.8) < 1e-9, "range factor reflects the curve");
});

test("iaus: a lower weight reduces a consideration's power to drag the score down", () => {
  const ctx = { safety: 0.0, range: 0.9 };
  const full = scoreOption({}, ctx, [{ ...cons[0], weight: 1 }, cons[1]]);
  const muted = scoreOption({}, ctx, [{ ...cons[0], weight: 0.2 }, cons[1]]);
  assert.ok(muted.score > full.score, `muting the safety veto raises the score (${muted.score} > ${full.score})`);
});

// ---------------------------------------------------------------- ranking

test("iaus: rankOptions sorts by score desc and is stable on ties", () => {
  const options = [
    { id: "a", safety: 0.5, range: 0.5 },
    { id: "b", safety: 0.9, range: 0.9 },
    { id: "c", safety: 0.5, range: 0.5 }, // tie with a
  ];
  const ranked = rankOptions(options, (o) => o, cons);
  assert.equal(ranked[0].option.id, "b", "the strongest option wins");
  assert.equal(ranked[1].option.id, "a", "ties keep input order (a before c)");
  assert.equal(ranked[2].option.id, "c");
});

test("iaus: ranking is deterministic across repeated runs", () => {
  const options = Array.from({ length: 8 }, (_, i) => ({ id: i, safety: (i % 3) / 2, range: (i % 2) / 1 }));
  const a = rankOptions(options, (o) => o, cons).map((r) => r.option.id);
  const b = rankOptions(options, (o) => o, cons).map((r) => r.option.id);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test.run();
