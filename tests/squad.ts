import { test } from "uvu";
import * as assert from "uvu/assert";
import { type TraceEvent, F, N, explainFailure, goal, planOnce } from "../src/index";
import {
  COVER_HIT_MULT,
  type SquadInstance,
  SquadSim,
  SquadWorld,
  breachInstance,
  coverFootprint,
  isSoftCover,
  squadModel,
} from "../scenarios/index";

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
  return labels.some((l) => /^(advanceTo|flankTo|climbTo|moveToBreach|retreatTo|moveToSpot|moveFree)/.test(l));
}

// a unit "fired" if it took a shot or ran an engage-from-position burst (the macro)
function fired(labels: string[]): boolean {
  return labels.some((l) => /^(takeShot|engageFrom)/.test(l));
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
  assert.ok(fired(stepStarts(sim, "E")), "the NPC fired");
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
  // the reservation pushed the NPCs to split across distinct firing positions rather
  // than piling onto the single nearest one (they claimed ≥2 different slots)
  const claimedEver = new Set<string>();
  for (const f of frames) for (const [c, owner] of Object.entries(f.reservations)) if (owner) claimedEver.add(c);
  assert.ok(claimedEver.size >= 2, "the NPCs split across at least two distinct cover/firing slots");
  // and both reached a line of fire — the target took fire from the flanking positions
  assert.ok(sim.world.actors.get("player")!.hp < 100, "the split NPCs earned a line of fire and engaged");
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
  assert.ok(fired(stepStarts(sim, "ally")), "the ally engaged");
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
  assert.not.ok(fired(stepStarts(sim, "ally")), "the ally never fired");
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
  assert.ok(fired(stepStarts(sim, "ally")), "the ally was engaging before the order");

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
  const frames = sim.run(500);

  for (const u of ["R1", "R2"]) {
    const scopes = sim.trace.filter((t) => t.unit === u && t.e.t === "scope.enter");
    assert.ok(
      scopes.some((t) => (t.e as { label: string }).label.includes("breach-window")),
      `${u} entered the timed breach window`,
    );
    assert.ok(stepStarts(sim, u).some((l) => l.startsWith("moveToBreach")), `${u} stacked on the door`);
  }
  // the breachers used DISTINCT door slots (no piling onto one spot)
  const claimedEver = new Set<string>();
  for (const f of frames) for (const [c, o] of Object.entries(f.reservations)) if (o) claimedEver.add(c);
  assert.ok(claimedEver.has("stackL") && claimedEver.has("stackR"), "the breachers stacked on distinct door slots");
  // the door was breached (one kick opens it for the team)
  assert.ok(sim.world.doorBroken, "the door was breached open");
  assert.ok(sim.trace.some((t) => t.e.t === "step.start" && (t.e as { label: string }).label.startsWith("breach")), "a breach action fired");
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

// ---------------------------------------------------------------- F: tactical model — directional cover

test("squad: a crate gives cover against a shooter behind it, but not one on your own side (directional)", () => {
  // a plain crate at the origin; foe to the NORTH. Standing just SOUTH of the crate
  // puts it on the incoming line → in cover. A foe to the SOUTH (your side) is not blocked.
  const inst: SquadInstance = {
    units: [{ name: "E", side: "enemy", x: 0, z: -1.4 }],
    covers: [{ name: "crate", x: 0, z: 0 }],
  };
  const world = new SquadWorld(inst);
  assert.ok(isSoftCover(inst.covers[0]), "a plain crate is soft cover");
  assert.equal(world.softCovers.length, 1, "the crate produced a soft-cover footprint");
  assert.ok(world.inCoverVs(0, -1.4, 0, 6), "the crate shields against a shooter to the north");
  assert.not.ok(world.inCoverVs(0, -1.4, 0, -6), "it does NOT shield against a shooter on your own side");
  // step to the OTHER side of the crate and the cover flips to the other shooter
  assert.ok(world.inCoverVs(0, 1.4, 0, -6), "moving around the crate shields the opposite angle");
});

test("squad: maneuver anchors (flank/rally) are open ground, not crates", () => {
  const inst: SquadInstance = {
    units: [{ name: "E", side: "enemy", x: 0, z: 0 }],
    covers: [
      { name: "f", x: 5, z: 5, flank: true },
      { name: "r", x: -5, z: 0, rally: true },
      { name: "crate", x: 0, z: 3 },
    ],
  };
  const world = new SquadWorld(inst);
  assert.equal(world.softCovers.length, 1, "only the plain crate is soft cover — flank/rally are open");
  assert.ok(coverFootprint(inst.covers[2]).w > 0, "a footprint has a real extent");
});

test("squad: hit chance falls with range and is cut by the target's cover", () => {
  const inst: SquadInstance = {
    units: [
      { name: "E", side: "enemy", x: 0, z: 0 },
      { name: "P", side: "player", x: 0, z: 4 },
    ],
    covers: [{ name: "crate", x: 0, z: 0 }],
  };
  const world = new SquadWorld(inst);
  const shooter = world.actors.get("E")!;
  const near = world.actors.get("P")!;
  const close = world.hitChance(shooter, near);
  near.z = 18; // farther away
  const far = world.hitChance(shooter, near);
  assert.ok(close > far, "closing the distance improves accuracy");
  // now the target is in cover relative to the shooter
  near.x = 0;
  near.z = 6;
  const open = world.hitChance(shooter, near); // shooter at crate, no cover for target here
  const coveredWorld = new SquadWorld({
    units: [
      { name: "E", side: "enemy", x: 0, z: -6 },
      { name: "P", side: "player", x: 0, z: 1.4 }, // hugging the crate, crate between it and E
    ],
    covers: [{ name: "crate", x: 0, z: 0 }],
  });
  const covered = coveredWorld.hitChance(coveredWorld.actors.get("E")!, coveredWorld.actors.get("P")!);
  assert.ok(covered < open * COVER_HIT_MULT * 2, "a target in cover is much harder to hit");
});

test("squad: exposure counts the foes with a clear line of fire, cover and walls reduce it", () => {
  const inst: SquadInstance = {
    units: [
      { name: "E", side: "enemy", x: 0, z: 0 },
      { name: "P1", side: "player", x: -6, z: 0 },
      { name: "P2", side: "player", x: 6, z: 0 },
    ],
    covers: [{ name: "crate", x: 0, z: 0 }],
  };
  const world = new SquadWorld(inst);
  const foes = [{ x: -6, z: 0 }, { x: 6, z: 0 }];
  // standing in the open between them → exposed to both
  assert.equal(world.exposureAt(0, -4, foes), 2, "open ground is exposed to both foes");
  // hug the crate so it blocks the foe to the north... both foes are to the sides here,
  // so place foes north/south to exercise cover directionality
  const ns = [{ x: 0, z: -10 }, { x: 0, z: 10 }];
  assert.equal(world.coverCountAt(0, 1.4, ns), 1, "the crate covers exactly one of the two opposed foes");
  assert.equal(world.exposureAt(0, 1.4, ns), 1, "so exposure drops to the single uncovered foe");
});

// ---------------------------------------------------------------- F: probabilistic hits in the sim

test("squad: a target in cover takes far fewer hits than the same target in the open (probabilistic)", () => {
  // identical lone shooter + stationary target + seed; the only difference is a crate
  // between them. Cover must measurably reduce the damage that lands over time.
  const mk = (crate: boolean): SquadInstance => ({
    units: [
      { name: "E", side: "enemy", x: 0, z: -6, role: "assault" },
      { name: "P", side: "player", x: 0, z: 0 },
    ],
    covers: crate ? [{ name: "shield", x: 0, z: -2 }, { name: "post", x: 0, z: -6 }] : [{ name: "post", x: 0, z: -6 }],
  });
  const run = (crate: boolean): number => {
    const sim = new SquadSim(mk(crate), { seed: 5 });
    for (let i = 0; i < 45 && sim.world.actors.get("P")!.alive; i++) sim.step();
    return sim.world.actors.get("P")!.hp;
  };
  const openHp = run(false);
  const coverHp = run(true);
  assert.ok(openHp < 100, "the exposed target actually took fire");
  assert.ok(coverHp > openHp + 20, `cover kept the target alive longer (cover=${coverHp} vs open=${openHp})`);
});

// ---------------------------------------------------------------- F: reads-the-room positioning

test("squad: a unit relocates to fight FROM cover instead of trading shots in the open", () => {
  // a lone shooter, a stationary target, and a crate the shooter can tuck behind to
  // deny the target its line. The unit should move into cover and fire from exposure 0.
  const inst: SquadInstance = {
    units: [
      { name: "E", side: "enemy", x: 0, z: -8, role: "assault" },
      { name: "P", side: "player", x: 0, z: 8 },
    ],
    covers: [{ name: "crate", x: 0, z: -3 }],
  };
  const sim = new SquadSim(inst, { seed: 3 });
  const world = sim.world as SquadWorld;
  let coveredShots = 0;
  let exposedShots = 0;
  for (let i = 0; i < 120 && sim.world.actors.get("P")!.alive; i++) {
    const f = sim.step();
    const e = f.units.find((u) => u.name === "E")!;
    if (e.action.startsWith("firing")) {
      const a = world.actors.get("E")!;
      if (world.exposureAt(a.x, a.z, [{ x: 8 * 0, z: 8 }]) === 0) coveredShots++;
      else exposedShots++;
    }
  }
  assert.ok(moved(stepStarts(sim, "E")), "the unit repositioned rather than firing from spawn");
  assert.ok(coveredShots > exposedShots, `it fought mostly from cover (covered=${coveredShots} exposed=${exposedShots})`);
});

test("squad: with NO cover available the unit still engages and resolves the fight", () => {
  // contrast: drop the crate. With nothing to tuck behind the unit can't fight from
  // cover, but it still closes in / engages and neutralizes — positioning is a
  // preference layered on top of a reliable engagement, not a way to stall.
  const inst: SquadInstance = {
    units: [
      { name: "E", side: "enemy", x: 0, z: -8, role: "assault" },
      { name: "P", side: "player", x: 0, z: 8 },
    ],
    covers: [{ name: "post", x: 0, z: -8, flank: true }], // an open anchor, not a crate
  };
  const sim = new SquadSim(inst, { seed: 3 });
  sim.run(400);
  assert.ok(fired(stepStarts(sim, "E")), "it engaged the target");
  assert.equal(sim.world.actors.get("P")!.alive, false, "and neutralized it without any cover to use");
});

// ---------------------------------------------------------------- F: engine custom-heuristic hook

test("squad: the engine consults a domain customHeuristic on a numeric goal (potential-field hook)", () => {
  // a numeric goal (threatHp ≤ 0) yields no symbolic atoms, so the relaxation heuristic
  // is 0 (uninformed). The engine must instead consult the domain-supplied heuristic.
  const inst: SquadInstance = {
    units: [
      { name: "E", side: "enemy", x: 0, z: 0 },
      { name: "player", side: "player", x: 5, z: 0 },
    ],
    covers: [{ name: "c", x: 0, z: 0 }],
  };
  const model = squadModel(inst, "E");
  const state = model.createExecState();
  state.set(model.slotOf("hasThreat"), 1);
  state.buffer[model.slotOf("threatPos")] = 5; // player at (5,0): E has a clear shot
  let calls = 0;
  const result = planOnce(model, state, {
    goals: [goal(F.lte(N.fl("threatHp"), N.c(0)))],
    customHeuristic: (s) => {
      calls++;
      void s;
      return 0;
    },
    maxNodes: 5000,
  });
  assert.ok(calls > 0, "the engine consulted the domain heuristic");
  assert.equal(result.status, "success", "and found a plan for the numeric goal");
});

test("squad: spatialDedup makes a spatial kill-goal tractable (vs clock-polluted blowup)", () => {
  // E already has a clear shot, so the optimal plan is a single engageFrom. But the
  // move space is fine and every move advances the clock, so WITHOUT spatialDedup the
  // uniform-cost search treats each position-at-a-different-time as a fresh node and
  // never settles — it can't even find the 1-step plan inside a generous budget. WITH
  // spatialDedup those time-equivalent positions collapse and it solves it at once.
  const inst: SquadInstance = {
    units: [
      { name: "E", side: "enemy", x: -8, z: 0 },
      { name: "player", side: "player", x: 8, z: 0 },
    ],
    covers: [
      { name: "a", x: 0, z: 3 },
      { name: "b", x: 0, z: -3 },
      { name: "c", x: 4, z: 2 },
      { name: "d", x: -4, z: 2 },
    ],
  };
  const model = squadModel(inst, "E");
  const mkState = () => {
    const s = model.createExecState();
    s.set(model.slotOf("hasThreat"), 1);
    s.buffer[model.slotOf("threatPos")] = 8; // player at (8,0): E has a clear shot
    s.set(model.slotOf("useGoap"), 1);
    return s;
  };
  const plan = (spatialDedup: boolean) =>
    planOnce(model, mkState(), {
      goals: [goal(F.lte(N.fl("threatHp"), N.c(0)))],
      customHeuristic: () => 0, // uniform-cost: isolates the dedup effect
      spatialDedup,
      weight: 1,
      maxNodes: 20000,
    });
  const on = plan(true);
  assert.equal(on.status, "success", "spatialDedup solves the spatial goal");
  assert.equal(on.plan!.steps.length, 1, "and finds the optimum: engage from here (already has a line of fire)");
  const off = plan(false);
  assert.equal(off.status, "failure", "without it, the clock-polluted state space exhausts the budget");
  assert.ok(off.stats.expansions > on.stats.expansions * 4, `dedup explores far less (off=${off.stats.expansions} on=${on.stats.expansions})`);
});

// ---------------------------------------------------------------- F: GOAP positioning mode (engine search)

test("squad: GOAP positioning (generic search + potential-field heuristic) also fights from cover", () => {
  // the SAME 1v1-with-a-crate fight, but positioning is decided by the generic planner
  // search guided by the spatial heuristic instead of the bespoke spot-graph route.
  // The heuristic is what keeps it from wandering — it reaches cover and neutralizes.
  const inst: SquadInstance = {
    units: [
      { name: "E", side: "enemy", x: 0, z: -8, role: "assault" },
      { name: "P", side: "player", x: 0, z: 8 },
    ],
    covers: [{ name: "crate", x: 0, z: -3 }],
  };
  const sim = new SquadSim(inst, { seed: 3, positioning: "goap" });
  const world = sim.world as SquadWorld;
  let covered = 0;
  let exposed = 0;
  for (let i = 0; i < 140 && sim.world.actors.get("P")!.alive; i++) {
    const f = sim.step();
    const e = f.units.find((u) => u.name === "E")!;
    if (e.action.startsWith("firing")) {
      const a = world.actors.get("E")!;
      if (world.exposureAt(a.x, a.z, [{ x: 0, z: 8 }]) === 0) covered++;
      else exposed++;
    }
  }
  assert.equal(sim.positioning, "goap", "running the GOAP positioning engine");
  assert.ok(moved(stepStarts(sim, "E")), "the search relocated the unit (move op fired)");
  assert.ok(covered > exposed, `it fought mostly from cover (covered=${covered} exposed=${exposed})`);
  assert.equal(sim.world.actors.get("P")!.alive, false, "and neutralized the target");
});

// ---------------------------------------------------------------- F: spot-graph multi-hop routing

test("squad: the spot-graph route composes a multi-hop path around a barricade to earn a line of fire", () => {
  // a wall sits between E and P; no single straight hop reaches a firing angle, so the
  // route must STAGE through an intermediate spot then push to the spot that sees P.
  const inst: SquadInstance = {
    units: [
      { name: "E", side: "enemy", x: 0, z: 0, role: "assault" },
      { name: "P", side: "player", x: 0, z: 12 },
    ],
    covers: [
      { name: "cNear", x: 0, z: 2 },
      { name: "fSide", x: 8, z: 8, flank: true },
    ],
    walls: [{ x: -3, z: 5, w: 6, d: 1 }],
  };
  const sim = new SquadSim(inst, { seed: 3 });
  const hops = new Set<string>();
  for (let i = 0; i < 300 && sim.world.actors.get("P")!.alive; i++) {
    const f = sim.step();
    const e = f.units.find((u) => u.name === "E")!;
    if (e.step.startsWith("moveToSpot")) hops.add(e.step);
  }
  assert.ok(hops.size >= 2, `the route staged through ≥2 distinct spots around the wall (saw ${hops.size}: ${[...hops]})`);
  assert.equal(sim.world.actors.get("P")!.alive, false, "and reached a firing angle to neutralize the target");
});

// --------------------------------------------------- F: survival / attrition model (push vs flee)

/** A flank scenario whose open approaches are dangerous to cross. */
function attritionFlankInstance(): SquadInstance {
  return {
    units: [
      { name: "R1", side: "enemy", x: -10, z: -1, role: "suppressor" },
      { name: "R2", side: "enemy", x: -10, z: 2, role: "flanker" },
      { name: "B1", side: "ally", x: 10, z: 1, role: "suppressor" },
      { name: "B2", side: "ally", x: 10, z: -2, role: "flanker" },
    ],
    covers: [
      { name: "cW", x: -5, z: 0 }, { name: "cE", x: 5, z: 0 },
      { name: "crNW", x: -3.5, z: -7 }, { name: "crNE", x: 3.5, z: -7 },
      { name: "crSW", x: -3.5, z: 7 }, { name: "crSE", x: 3.5, z: 7 },
      { name: "fNW", x: -3, z: -9.5, flank: true }, { name: "fSW", x: -3, z: 9.5, flank: true },
      { name: "fNE", x: 3, z: -9.5, flank: true }, { name: "fSE", x: 3, z: 9.5, flank: true },
    ],
    walls: [{ x: -2, z: -5, w: 4, d: 10 }],
  };
}

test("squad: the attrition model stops suicidal advances — nobody dies charging into fire", () => {
  // With myHp projected onto move + engage and the survival gates, a unit no longer
  // commits to a reposition-to-fight whose crossing/engagement kills it. We assert the
  // turnaround from the old behaviour: deaths while ADVANCING to fight (moveFree /
  // moveToSpot / flankTo) are essentially gone — casualties now occur firing or while
  // breaking contact (caught fleeing a fight already judged lost), not charging in.
  const advanceMove = (s: string) => /^(moveFree|moveToSpot|flankTo|advanceTo)/.test(s);
  let total = 0;
  let advanceDeaths = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const sim = new SquadSim(attritionFlankInstance(), { seed, positioning: "goap" });
    const lastStep = new Map<string, string>();
    const alive = new Map<string, boolean>();
    for (const u of sim.snapshot().units) alive.set(u.name, true);
    for (let i = 0; i < 600 && !sim.engagementOver(); i++) {
      for (const u of sim.step().units) {
        if (alive.get(u.name) && !u.alive) {
          total++;
          if (advanceMove(lastStep.get(u.name) ?? "")) advanceDeaths++;
          alive.set(u.name, false);
        }
        if (u.alive && u.step && u.step !== "—") lastStep.set(u.name, u.step);
      }
    }
  }
  assert.ok(total > 0, "the engagements produced casualties");
  assert.equal(advanceDeaths, 0, `no unit died advancing into fire (saw ${advanceDeaths}/${total}) — the survival model prunes lethal crossings`);
});

test("squad: outnumbered ⇒ break contact (2-on-1, I won't survive — run)", () => {
  // One unit alone against two shooters: the attrition race says it loses, and no
  // reachable spot flips that, so it breaks contact instead of trading and dying.
  const inst: SquadInstance = {
    units: [
      { name: "E", side: "enemy", x: 0, z: -9, role: "assault" },
      { name: "P1", side: "player", x: -3, z: 8 },
      { name: "P2", side: "player", x: 3, z: 8 },
    ],
    covers: [{ name: "cBack", x: 0, z: -12 }, { name: "cMid", x: 0, z: -3 }],
  };
  const sim = new SquadSim(inst, { seed: 2, positioning: "goap" });
  let brokeContact = false;
  for (let i = 0; i < 120 && sim.world.actors.get("E")!.alive; i++) {
    const e = sim.step().units.find((u) => u.name === "E")!;
    if (e.step.startsWith("breakTo")) brokeContact = true;
  }
  assert.ok(brokeContact, "the outnumbered unit chose to break contact rather than fight a fight it loses");
});

test("squad: outnumbering ⇒ push (2-on-1 in our favour, we'll win — move in)", () => {
  // Two units against one: friendly guns shorten the kill, so the attrition race is
  // winnable — they engage and take the target rather than flee. Same geometry as the
  // flee case, only the numbers are reversed, so the difference is the squad math.
  const inst: SquadInstance = {
    units: [
      { name: "E1", side: "enemy", x: -2, z: -9, role: "assault" },
      { name: "E2", side: "enemy", x: 2, z: -9, role: "assault" },
      { name: "P", side: "player", x: 0, z: 8 },
    ],
    covers: [{ name: "cMid", x: 0, z: -3 }],
  };
  const sim = new SquadSim(inst, { seed: 2, positioning: "goap" });
  let anyFled = false;
  for (let i = 0; i < 200 && sim.world.actors.get("P")!.alive; i++) {
    for (const u of sim.step().units) if ((u.name === "E1" || u.name === "E2") && u.step.startsWith("breakTo")) anyFled = true;
  }
  assert.equal(sim.world.actors.get("P")!.alive, false, "the outnumbering pair pushed in and neutralized the target");
  assert.ok(!anyFled, "neither attacker broke contact — the squad math made it a winnable push");
});

// ---------------------------------------------------------------- F: caution (outgunned ⇒ value safety)

test("squad: an outgunned unit becomes more cautious than one fighting even odds", () => {
  const outgunned = new SquadSim(
    {
      units: [
        { name: "E", side: "enemy", x: 0, z: 0, role: "assault" },
        { name: "P1", side: "player", x: 5, z: -2 },
        { name: "P2", side: "player", x: 5, z: 2 },
      ],
      covers: [{ name: "c", x: 0, z: 0 }],
    },
    { seed: 1 },
  );
  outgunned.step();
  const e1 = outgunned.units.find((u) => u.name === "E")!;
  const cautionOutgunned = e1.model.read(e1.planner.state, "caution") as number;

  const even = new SquadSim(
    {
      units: [
        { name: "E", side: "enemy", x: 0, z: 0, role: "assault" },
        { name: "P1", side: "player", x: 5, z: 0 },
      ],
      covers: [{ name: "c", x: 0, z: 0 }],
    },
    { seed: 1 },
  );
  even.step();
  const e2 = even.units.find((u) => u.name === "E")!;
  const cautionEven = e2.model.read(e2.planner.state, "caution") as number;

  assert.ok(cautionOutgunned > cautionEven, `outgunned is more cautious (${cautionOutgunned} > ${cautionEven})`);
  assert.equal(cautionEven, 1, "even odds, healthy ⇒ baseline caution");
});

test("squad: the frame carries a plain-English tactical posture (glass-box)", () => {
  const sim = new SquadSim(
    {
      units: [
        { name: "E", side: "enemy", x: 0, z: -8, role: "assault" },
        { name: "P", side: "player", x: 0, z: 8 },
      ],
      covers: [{ name: "crate", x: 0, z: -3 }],
    },
    { seed: 3 },
  );
  let frame = sim.snapshot();
  for (let i = 0; i < 40; i++) frame = sim.step();
  const e = frame.units.find((u) => u.name === "E")!;
  assert.type(e.posture, "string", "posture is reported");
  assert.ok(/cover|open|line of fire/.test(e.posture), `posture reads tactically: "${e.posture}"`);
});

// ---------------------------------------------------------------- F: multi-enemy belief

test("squad: perception tracks each known hostile individually (multi-enemy belief)", () => {
  const inst: SquadInstance = {
    units: [
      { name: "E", side: "enemy", x: 0, z: 0, role: "assault" },
      { name: "P1", side: "player", x: 4, z: 0 },
      { name: "P2", side: "player", x: -4, z: 2 },
    ],
    covers: [{ name: "c", x: 0, z: 0 }],
  };
  const sim = new SquadSim(inst, { seed: 1 });
  sim.step();
  const e = sim.units.find((u) => u.name === "E")!;
  const snap = e.planner.state;
  assert.ok(e.foes.includes("P1") && e.foes.includes("P2"), "both players are tracked as foes");
  assert.equal(e.model.read(snap, "foeSeen", "P1"), true, "P1 is currently seen");
  assert.equal(e.model.read(snap, "foeSeen", "P2"), true, "P2 is currently seen");
  const p1 = e.model.read(snap, "foePos", "P1");
  assert.ok(p1 !== null, "P1's believed position was written into belief");
});

test("squad: a hostile hidden behind a wall is not 'seen' (belief is line-of-sight gated)", () => {
  const inst: SquadInstance = {
    units: [
      { name: "E", side: "enemy", x: 0, z: 0, role: "assault" },
      { name: "P", side: "player", x: 0, z: 10 },
    ],
    covers: [{ name: "c", x: 0, z: 0 }],
    walls: [{ x: -3, z: 4, w: 6, d: 1 }], // blocks the line E↔P
  };
  const sim = new SquadSim(inst, { seed: 1 });
  sim.step();
  const e = sim.units.find((u) => u.name === "E")!;
  assert.equal(e.model.read(e.planner.state, "foeSeen", "P"), false, "the hidden player is not seen");
});

// ---------------------------------------------------------------- exports sanity

test("squad: TraceEvent type is re-exported through scenarios", () => {
  const e: TraceEvent = { t: "plan.completed" };
  assert.equal(e.t, "plan.completed");
});

test.run();
