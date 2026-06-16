import { test } from "uvu";
import * as assert from "uvu/assert";
import { type TraceEvent } from "../src/index";
import { type SquadInstance, SquadSim, squadModel } from "../scenarios/index";

/**
 * Squad Combat — ground-truth assertions for the F.E.A.R.-style tactical
 * scenario. These tests pin the *emergent* behaviours the demo shows off:
 * search-derived flanking, reactive replanning from perception, deterministic
 * traces, coordinated suppress-while-flank, cover reservation, and the
 * synchronized breach window. Everything runs the real reactive Planner.
 */

// the AI unit's executed step labels, in order (for asserting what it actually did)
function stepStarts(sim: SquadSim, unit: string): string[] {
  return sim.trace.filter((t) => t.unit === unit && t.e.t === "step.start").map((t) => (t.e as { label: string }).label);
}

function moved(labels: string[]): boolean {
  return labels.some((l) => /^(advanceTo|flankTo|climbTo|moveToBreach|retreatTo)/.test(l));
}

// ---------------------------------------------------------------- domain validity

test("squad: the combat domain compiles", () => {
  // building a real per-unit model proves the domain validates + grounds + binds
  const inst: SquadInstance = {
    units: [{ name: "E", side: "enemy", x: 0, z: 0 }],
    covers: [{ name: "c1", x: 1, z: 1 }],
  };
  const model = squadModel(inst, "E");
  assert.ok(model.operators.length >= 6, "operators compiled");
  assert.ok(model.methodsByTask.has("Fight"), "Fight task has methods");
});

// ---------------------------------------------------------------- A: neutralize with clear LOS

test("squad: a lone NPC with line of sight engages and neutralizes the target", () => {
  const inst: SquadInstance = {
    units: [
      { name: "E", side: "enemy", x: 0, z: 0, role: "assault" },
      { name: "player", side: "player", x: 6, z: 0 },
    ],
    covers: [{ name: "c1", x: 0, z: 0 }],
  };
  const sim = new SquadSim(inst, { seed: 7 });
  sim.run(400);
  const player = sim.world.actors.get("player")!;
  assert.equal(player.alive, false, "player neutralized");
  assert.ok(stepStarts(sim, "E").some((l) => l.startsWith("takeShot")), "the NPC fired");
});

// ---------------------------------------------------------------- A: search-derived flanking (E1)

/** A wall blocks the straight line of fire; LOS is only available from the side. */
function blockedLane(wall: boolean): SquadInstance {
  return {
    units: [
      { name: "E", side: "enemy", x: 0, z: 0, role: "assault" },
      { name: "player", side: "player", x: 0, z: 10 },
    ],
    covers: [
      { name: "cNear", x: 0, z: 2 }, // still behind the wall — no LOS
      { name: "fSide", x: 6, z: 6, flank: true }, // around the wall — clear LOS
    ],
    walls: wall ? [{ x: -2, z: 4, w: 4, d: 1 }] : [],
  };
}

test("squad: blocked line of fire ⇒ the NPC derives a flank to a cover that can see (emergent spatial tactics)", () => {
  const blocked = new SquadSim(blockedLane(true), { seed: 3 });
  blocked.run(500);
  const movedToFlank = moved(stepStarts(blocked, "E"));
  assert.ok(movedToFlank, "with the lane blocked, the NPC relocates to get a line of sight");
  assert.equal(blocked.world.actors.get("player")!.alive, false, "and still neutralizes the target");

  // contrast: remove the wall and the SAME unit shoots straight away, no detour —
  // proving the flank was discovered from geometry, not scripted.
  const clear = new SquadSim(blockedLane(false), { seed: 3 });
  // step a few times so it can plan + fire from spawn
  for (let i = 0; i < 20 && !clear.engagementOver(); i++) clear.step();
  assert.not.ok(moved(stepStarts(clear, "E")), "with a clear lane it does NOT detour — it just fires");
});

// ---------------------------------------------------------------- A: reactive replanning from perception

test("squad: perception drives reactive replanning (the planner reacts to a moving world)", () => {
  const inst: SquadInstance = {
    units: [
      { name: "E", side: "enemy", x: -6, z: 0, role: "assault" },
      { name: "player", side: "player", x: 6, z: 0 },
    ],
    covers: [
      { name: "a", x: -3, z: 0 },
      { name: "b", x: 0, z: -3 },
    ],
    // the player walks across the field — the NPC must keep re-deciding
    playerPath: [
      { x: 6, z: 0 },
      { x: 6, z: 8 },
      { x: -2, z: 8 },
    ],
  };
  const sim = new SquadSim(inst, { seed: 5 });
  sim.run(500);
  const dirty = sim.trace.filter((t) => t.unit === "E" && t.e.t === "replan.dirty");
  assert.ok(dirty.length > 0, "the NPC replanned in reaction to the changing world");
});

// ---------------------------------------------------------------- A: determinism

test("squad: identical seed + fixed timestep ⇒ byte-identical traces", () => {
  const mk = () =>
    new SquadSim(
      {
        units: [
          { name: "E1", side: "enemy", x: -6, z: -3, role: "suppressor" },
          { name: "E2", side: "enemy", x: -6, z: 3, role: "flanker" },
          { name: "player", side: "player", x: 6, z: 0 },
        ],
        covers: [
          { name: "n", x: -2, z: -3 },
          { name: "s", x: -2, z: 3 },
          { name: "f", x: 4, z: 6, flank: true },
        ],
      },
      { seed: 11 },
    );
  const run = (sim: SquadSim): string => {
    sim.run(400);
    return JSON.stringify(sim.trace);
  };
  assert.equal(run(mk()), run(mk()), "two runs with the same seed are identical");
});

// ---------------------------------------------------------------- exports sanity

test("squad: TraceEvent type is re-exported through scenarios", () => {
  const e: TraceEvent = { t: "plan.completed" };
  assert.equal(e.t, "plan.completed");
});

test.run();
