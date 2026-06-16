import { test } from "uvu";
import * as assert from "uvu/assert";
import { type TraceEvent, F, N, explainFailure, goal, planOnce } from "../src/index";
import { type SquadInstance, SquadSim, breachInstance, squadModel } from "../scenarios/index";

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

// ---------------------------------------------------------------- B: suppress-while-flank coordination

test("squad: two NPCs coordinate — one suppresses while the other flanks (scoped, reactive)", () => {
  const inst: SquadInstance = {
    units: [
      { name: "E1", side: "enemy", x: -7, z: -2 },
      { name: "E2", side: "enemy", x: -7, z: 2 },
      { name: "player", side: "player", x: 7, z: 0 },
    ],
    covers: [
      { name: "cA", x: -3, z: -2 },
      { name: "cB", x: -3, z: 2 },
      { name: "fN", x: 2, z: 7, flank: true },
      { name: "fS", x: 2, z: -7, flank: true },
      { name: "rally", x: -10, z: 0, rally: true },
    ],
  };
  const sim = new SquadSim(inst, { seed: 9 });
  const frames = sim.run(600);

  // coordinator promoted the enemy team to the flank tactic
  assert.equal(sim.world.team("enemy").tactic, "flank", "≥2 in contact ⇒ coordinated flank");
  // the suppressor opened a suppress-cover scope (cover fire)
  const e1Scopes = sim.trace.filter((t) => t.unit === "E1" && t.e.t === "scope.enter");
  assert.ok(
    e1Scopes.some((t) => (t.e as { label: string }).label.includes("suppress")),
    "the suppressor laid down covering fire inside a scope",
  );
  // the flanker actually flanked, and reaching position flipped the squad flag
  assert.ok(stepStarts(sim, "E2").some((l) => l.startsWith("flankTo")), "the flanker moved to a flank cover");
  assert.ok(frames.some((f) => f.teams.find((t) => t.side === "enemy")?.flankerReady), "the flanker reached position (squad flag set)");
});

// ---------------------------------------------------------------- B: cover reservation under contention

test("squad: cover reservation — two NPCs never share a slot and split to distinct cover", () => {
  // both spawns are blocked from the target; the only cover with a line of fire is
  // contested, so the reservation must push the loser to the other LOS cover.
  const inst: SquadInstance = {
    units: [
      { name: "E1", side: "enemy", x: -1, z: -1 },
      { name: "E2", side: "enemy", x: -1, z: 1 },
      { name: "player", side: "player", x: 0, z: 11 },
    ],
    covers: [
      { name: "cBlocked", x: 0, z: 2 }, // still behind the wall — useless
      { name: "cL", x: -5, z: 7 }, // LOS, nearest to both
      { name: "cR", x: 5, z: 7 }, // LOS, the fallback
    ],
    walls: [{ x: -3, z: 4, w: 6, d: 1 }],
  };
  const sim = new SquadSim(inst, { seed: 4 });
  const frames = sim.run(700);

  // invariant: at no frame do two alive units hold the same claimed cover
  for (const f of frames) {
    const claimed = f.units.filter((u) => u.alive && u.cover).map((u) => u.cover);
    assert.equal(new Set(claimed).size, claimed.length, `distinct covers @ t=${f.clock}`);
  }
  // the reservation pushed the two NPCs onto BOTH line-of-fire covers (they would
  // both have greedily taken the nearer one)
  const claimedEver = new Set<string>();
  for (const f of frames) for (const [c, owner] of Object.entries(f.reservations)) if (owner) claimedEver.add(c);
  assert.ok(claimedEver.has("cL") && claimedEver.has("cR"), "the NPCs split across both line-of-fire covers");
  // the loser reacted to the slot being taken (fluent-precise replan)
  assert.ok(
    sim.trace.some((t) => t.e.t === "replan.dirty"),
    "contention triggered reactive replanning",
  );
});

// ---------------------------------------------------------------- C: ally companion

test("squad: an allied companion auto-assists — engages the enemy, never a friendly", () => {
  const inst: SquadInstance = {
    units: [
      { name: "ally", side: "ally", x: 0, z: 0 },
      { name: "enemy", side: "enemy", x: 8, z: 0 },
    ],
    covers: [{ name: "c", x: 0, z: 0 }],
  };
  const sim = new SquadSim(inst, { seed: 6 });
  sim.run(400);
  assert.equal(sim.world.actors.get("enemy")!.alive, false, "the ally neutralized the enemy");
  assert.ok(stepStarts(sim, "ally").some((l) => l.startsWith("takeShot")), "the ally engaged");
});

test("squad: with only friendlies present the ally holds fire (no friendly targeting)", () => {
  const inst: SquadInstance = {
    units: [
      { name: "ally", side: "ally", x: 0, z: 0 },
      { name: "player", side: "player", x: 3, z: 0 },
    ],
    covers: [{ name: "c", x: 0, z: 0 }],
  };
  const sim = new SquadSim(inst, { seed: 6 });
  for (let i = 0; i < 60; i++) sim.step();
  assert.equal(sim.world.actors.get("player")!.hp, 100, "the friendly is untouched");
  assert.not.ok(stepStarts(sim, "ally").some((l) => l.startsWith("takeShot")), "the ally never fired");
  assert.not.equal(sim.units[0].planner.getStatus(), "failed", "no fight to pick ⇒ the ally idles, it doesn't fail-loop");
});

// ---------------------------------------------------------------- E2: player command via setGoals

test("squad: a player 'regroup' order swaps the ally's goal and it obeys (setGoals seam)", () => {
  const inst: SquadInstance = {
    units: [
      { name: "ally", side: "ally", x: 0, z: 0 },
      { name: "enemy", side: "enemy", x: 10, z: 0, hp: 30 }, // a brief contact the ally wins
    ],
    covers: [
      { name: "post", x: 1, z: 0 },
      { name: "rally", x: -9, z: 0, rally: true },
    ],
  };
  const sim = new SquadSim(inst, { seed: 2 });
  for (let i = 0; i < 25; i++) sim.step();
  assert.ok(stepStarts(sim, "ally").some((l) => l.startsWith("takeShot")), "the ally was engaging before the order");

  const before = sim.trace.length;
  sim.command("ally", "regroup"); // ← player order, routed through setGoals
  for (let i = 0; i < 150 && sim.world.actors.get("ally")!.cover !== "rally"; i++) sim.step();

  assert.equal(sim.world.actors.get("ally")!.cover, "rally", "the ally fell back to the rally point on command");
  assert.ok(
    sim.trace.slice(before).some((t) => t.unit === "ally" && (t.e.t === "plan.new" || t.e.t === "step.start")),
    "the order triggered a fresh plan",
  );
});

// ---------------------------------------------------------------- E4: timed synchronized breach

test("squad: a fire-team breaches in sync inside a deadline window (temporal-lite)", () => {
  const sim = new SquadSim(breachInstance(), { seed: 8 });
  sim.run(500);

  for (const u of ["R1", "R2"]) {
    const scopes = sim.trace.filter((t) => t.unit === u && t.e.t === "scope.enter");
    assert.ok(
      scopes.some((t) => (t.e as { label: string }).label.includes("breach-window")),
      `${u} entered the timed breach window`,
    );
    assert.ok(stepStarts(sim, u).some((l) => l.startsWith("moveToBreach")), `${u} stacked on the door`);
    assert.ok(stepStarts(sim, u).some((l) => l.startsWith("breach")), `${u} breached`);
  }
  // nobody blew the deadline — the window was met
  const blown = sim.trace.filter((t) => t.e.t === "scope.violated" && (t.e as { reason: string }).reason === "deadline");
  assert.equal(blown.length, 0, "the breach completed within the window (no deadline violation)");
  // the breach made contact with the defenders holding the room
  assert.ok([sim.world.actors.get("B1")!, sim.world.actors.get("B2")!].some((b) => b.hp < 100), "the breach hit the defenders");
});

// ---------------------------------------------------------------- E3: glass-box — explain why a branch was rejected

test("squad: the planner can explain why an impossible engagement fails (glass-box)", () => {
  // a unit boxed in with no line of fire and nowhere with one ⇒ neutralize is
  // unreachable; explainFailure surfaces readable rejection reasons.
  const inst: SquadInstance = {
    units: [
      { name: "E", side: "enemy", x: 0, z: 0, role: "assault" },
      { name: "player", side: "player", x: 0, z: 6 },
    ],
    covers: [{ name: "c", x: 0, z: 1 }], // also boxed in
    // fully enclose the target so no cover anywhere has a line of fire
    walls: [{ x: -3, z: 3, w: 6, d: 1 }],
  };
  const model = squadModel(inst, "E");
  const state = model.createExecState();
  // seed a believed threat the unit cannot see (boxed behind the wall)
  state.set(model.slotOf("hasThreat"), 1);
  state.buffer[model.slotOf("threatPos")] = 0;
  state.buffer[model.slotOf("threatPos") + 1] = 6;
  const result = planOnce(model, state, {
    goals: [goal(F.lte(N.fl("threatHp"), N.c(0)))],
    collectRejections: true,
    maxNodes: 4000,
  });
  assert.equal(result.status, "failure", "no line of fire exists ⇒ planning fails");
  const reasons = explainFailure(result);
  assert.ok(reasons.length > 0, "explainFailure produced human-readable rejection reasons");
});

// ---------------------------------------------------------------- exports sanity

test("squad: TraceEvent type is re-exported through scenarios", () => {
  const e: TraceEvent = { t: "plan.completed" };
  assert.equal(e.t, "plan.completed");
});

test.run();
