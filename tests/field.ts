import { test } from "uvu";
import * as assert from "uvu/assert";
import { type Box, exposureAt, inCoverVs, losClear, segHitsBox } from "../scenarios/lib/geometry";
import { type ThreatSnapshot, buildField } from "../scenarios/lib/field";

/**
 * Spatial geometry + field tests (C6). The headline assertion is the
 * rollout-correctness invariant: a field is keyed to a threat SNAPSHOT and never
 * reads the live world, so mutating the source after building leaves its answers
 * unchanged. Plus oracle checks that exposure/LOS/cover behave, including 2.5D
 * high-ground lapse.
 */

const cfg = { reach: 1.8, sight: 22, integralStep: 1.0 };

// ---------------------------------------------------------------- geometry oracle

test("geometry: LOS is blocked by a wall on the line and clear otherwise", () => {
  const wall: Box = { x: -2, z: 4, w: 4, d: 1 };
  assert.not.ok(losClear(0, 0, 0, 10, [wall]), "the wall blocks the straight line");
  assert.ok(losClear(0, 0, 8, 0, [wall]), "a line that misses the wall is clear");
});

test("geometry: soft cover is directional", () => {
  const crate: Box = { x: -0.6, z: -0.4, w: 1.2, d: 0.8 }; // footprint centered at origin
  // standing just south of the crate, shooter to the north → covered
  assert.ok(inCoverVs(0, -1.4, 0, 0, 6, 0, [crate], cfg.reach), "crate shields a northern shooter");
  // a shooter on your own (south) side is not blocked
  assert.not.ok(inCoverVs(0, -1.4, 0, 0, -6, 0, [crate], cfg.reach), "no shield against a southern shooter");
});

test("geometry (2.5D): a shooter on high ground sees over low cover (lapse)", () => {
  const crate: Box = { x: -0.6, z: -0.4, w: 1.2, d: 0.8, height: 1.0 };
  // ground-level shooter is blocked; an elevated shooter sees over the crate
  assert.ok(inCoverVs(0, -1.4, 0, 0, 6, 0, [crate], cfg.reach), "ground shooter is blocked");
  assert.not.ok(inCoverVs(0, -1.4, 0, 0, 6, 2.0, [crate], cfg.reach), "high-ground shooter sees over the crate");
});

test("geometry: exposure counts foes with a clear shot, cover/walls reduce it", () => {
  const foes = [{ x: -6, z: 0, elev: 0 }, { x: 6, z: 0, elev: 0 }];
  assert.equal(exposureAt(0, -4, 0, foes, [], [], cfg.reach, cfg.sight), 2, "open between both → exposed to both");
  const ns = [{ x: 0, z: -10, elev: 0 }, { x: 0, z: 10, elev: 0 }];
  const crate: Box = { x: -0.6, z: -0.4, w: 1.2, d: 0.8 };
  assert.equal(exposureAt(0, 1.4, 0, ns, [], [crate], cfg.reach, cfg.sight), 1, "crate covers one of the opposed foes");
});

test("geometry: segHitsBox detects a crossing segment", () => {
  assert.ok(segHitsBox(0, 0, 0, 10, { x: -1, z: 4, w: 2, d: 1 }));
  assert.not.ok(segHitsBox(0, 0, 0, 10, { x: 5, z: 4, w: 2, d: 1 }));
});

// ---------------------------------------------------------------- field

test("field: exposureAt matches the geometry oracle", () => {
  const threats: ThreatSnapshot[] = [
    { pos: { x: -6, z: 0 }, elev: 0, alive: true },
    { pos: { x: 6, z: 0 }, elev: 0, alive: true },
  ];
  const f = buildField(threats, [], [], cfg);
  const foes = threats.map((t) => ({ x: t.pos.x, z: t.pos.z, elev: t.elev }));
  for (const [x, z] of [[0, -4], [3, 3], [-5, 1]] as [number, number][]) {
    assert.equal(f.exposureAt(x, z, 0), exposureAt(x, z, 0, foes, [], [], cfg.reach, cfg.sight), `oracle match at (${x},${z})`);
  }
});

test("field: dead threats don't contribute exposure", () => {
  const threats: ThreatSnapshot[] = [{ pos: { x: 6, z: 0 }, elev: 0, alive: false }];
  const f = buildField(threats, [], [], cfg);
  assert.equal(f.exposureAt(0, 0, 0), 0, "a dead threat can't shoot you");
});

test("field: exposureIntegral is zero when the whole path is shielded by a wall", () => {
  const threats: ThreatSnapshot[] = [{ pos: { x: 0, z: 20 }, elev: 0, alive: true }];
  const wall: Box = { x: -10, z: 10, w: 20, d: 1 }; // between the path and the threat
  const f = buildField(threats, [wall], [], cfg);
  assert.equal(f.exposureIntegral(-5, 0, 5, 0, 0), 0, "a wall shields the whole crossing");
});

test("field: a longer exposed crossing integrates to a larger cost", () => {
  const threats: ThreatSnapshot[] = [{ pos: { x: 0, z: 20 }, elev: 0, alive: true }];
  const f = buildField(threats, [], [], cfg);
  const short = f.exposureIntegral(-1, 0, 1, 0, 0);
  const long = f.exposureIntegral(-6, 0, 6, 0, 0);
  assert.ok(long > short, `longer exposed path costs more (${long} > ${short})`);
});

// ---------------------------------------------------------------- rollout-correctness invariant

test("field: ROLLOUT-CORRECT — mutating the source world after build does not change answers", () => {
  const live: ThreatSnapshot[] = [{ pos: { x: 6, z: 0 }, elev: 0, alive: true }];
  const f = buildField(live, [], [], cfg);
  const before = f.exposureAt(0, 0, 0);
  // simulate the world moving / the threat dying AFTER the replan snapshot was taken
  live[0].pos.x = 999;
  live[0].alive = false;
  const after = f.exposureAt(0, 0, 0);
  assert.equal(before, after, "the field reflects the snapshot, not the live world");
  assert.equal(f.threats[0].pos.x, 6, "the field kept its own snapshot copy");
});

test.run();
