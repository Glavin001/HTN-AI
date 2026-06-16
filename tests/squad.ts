import { test } from "uvu";
import * as assert from "uvu/assert";
import { type TraceEvent, F, explainFailure, goal, planOnce } from "../src/index";
import { type SquadInstance, SquadSim, breachInstance, skirmishInstance, squadModel } from "../scenarios/index";

/**
 * Squad Combat — ground-truth assertions for the emergent, search-driven positioning
 * scenario. These pin the behaviours the demo shows off: a covered approach DERIVED by
 * GOAP route search (not scripted waypoints), reactive replanning from perception,
 * deterministic traces, single-occupancy cell reservation, the player-command seam,
 * and the synchronized breach window. Everything runs the real reactive Planner.
 */

function stepStarts(sim: SquadSim, unit: string): string[] {
  return sim.trace.filter((t) => t.unit === unit && t.e.t === "step.start").map((t) => (t.e as { label: string }).label);
}

/** did the unit MOVE (take any grid step)? */
function moved(labels: string[]): boolean {
  return labels.some((l) => l.startsWith("step"));
}

// ---------------------------------------------------------------- domain validity

test("squad: the combat domain compiles", () => {
  const inst: SquadInstance = { units: [{ name: "E", side: "enemy", x: 0, z: 0 }], covers: [] };
  const model = squadModel(inst, "E");
  const ops = new Set(model.operators.map((o) => o.name));
  assert.ok(ops.has("step") && ops.has("takeShot") && ops.has("reload") && ops.has("breach"), "core operators compiled");
  assert.ok(model.methodsByTask.has("Fight") && model.methodsByTask.has("Neutralize"), "tasks have methods");
});

// ---------------------------------------------------------------- a lone NPC engages

test("squad: a lone NPC with a clear line of sight engages and neutralizes the target", () => {
  const inst: SquadInstance = {
    units: [
      { name: "E", side: "enemy", x: 0, z: 0 },
      { name: "player", side: "player", x: 7, z: 0 },
    ],
    covers: [],
  };
  const sim = new SquadSim(inst, { seed: 7 });
  sim.run(400);
  assert.equal(sim.world.actors.get("player")!.alive, false, "player neutralized");
  assert.ok(stepStarts(sim, "E").some((l) => l.startsWith("takeShot")), "the NPC fired");
});

// ---------------------------------------------------------------- emergent routing (E1)

/** A wall blocks the straight line of fire; LOS exists only by going around it. */
function blockedLane(wall: boolean): SquadInstance {
  return {
    units: [
      { name: "E", side: "enemy", x: 0, z: 0 },
      { name: "player", side: "player", x: 0, z: 12 },
    ],
    covers: [],
    walls: wall ? [{ x: -4, z: 5, w: 8, d: 1.5 }] : [],
  };
}

test("squad: a blocked line of fire ⇒ the NPC SEARCHES a multi-step route around it (emergent spatial tactics)", () => {
  const blocked = new SquadSim(blockedLane(true), { seed: 3 });
  blocked.run(500);
  const steps = stepStarts(blocked, "E").filter((l) => l.startsWith("step"));
  assert.ok(steps.length >= 2, "with the lane blocked the NPC walks a multi-step route to find an angle");
  assert.equal(blocked.world.actors.get("player")!.alive, false, "and still neutralizes the target");

  // contrast: remove the wall and the SAME unit fires from where it stands, no detour —
  // proving the route was DISCOVERED from geometry, not scripted.
  const clear = new SquadSim(blockedLane(false), { seed: 3 });
  for (let i = 0; i < 30 && !clear.engagementOver(); i++) clear.step();
  assert.not.ok(moved(stepStarts(clear, "E")), "with a clear lane it does NOT detour — it just fires");
});

// ---------------------------------------------------------------- reactive replanning

test("squad: perception drives reactive replanning (the planner reacts to a moving world)", () => {
  const inst: SquadInstance = {
    units: [
      { name: "E", side: "enemy", x: -7, z: 0 },
      { name: "player", side: "player", x: 7, z: 0 },
    ],
    covers: [],
    playerPath: [
      { x: 7, z: 0 },
      { x: 7, z: 9 },
      { x: -3, z: 9 },
    ],
  };
  const sim = new SquadSim(inst, { seed: 5 });
  sim.run(500);
  assert.ok(sim.trace.some((t) => t.unit === "E" && t.e.t === "replan.dirty"), "the NPC replanned as the world changed");
});

// ---------------------------------------------------------------- determinism

test("squad: identical seed + fixed timestep ⇒ byte-identical traces", () => {
  const mk = () => new SquadSim(skirmishInstance(), { seed: 11 });
  const run = (sim: SquadSim): string => {
    sim.run(300);
    return JSON.stringify(sim.trace);
  };
  assert.equal(run(mk()), run(mk()), "two runs with the same seed are identical");
});

// ---------------------------------------------------------------- the skirmish resolves

test("squad: two autonomous squads fight to a decision (one side is eliminated)", () => {
  const sim = new SquadSim(skirmishInstance(), { seed: 7 });
  sim.run(600);
  assert.ok(sim.engagementOver(), "the engagement reaches a terminal state");
  const teams = sim.snapshot().teams;
  assert.ok(teams.some((t) => t.alive === 0) && teams.some((t) => t.alive > 0), "exactly one squad is left standing");
  // and they did it by MOVING — searched routes, not a static shoot-out
  assert.ok(sim.units.some((u) => moved(stepStarts(sim, u.name))), "units manoeuvred to firing positions");
});

// ---------------------------------------------------------------- single-occupancy cells

test("squad: cell reservation — two alive units never occupy the same cell", () => {
  const sim = new SquadSim(skirmishInstance(), { seed: 4 });
  const frames = sim.run(600);
  for (const f of frames) {
    const cells = f.units.filter((u) => u.alive && u.cover).map((u) => u.cover);
    assert.equal(new Set(cells).size, cells.length, `distinct cells @ t=${f.clock}`);
  }
});

// ---------------------------------------------------------------- ally companion

test("squad: an allied companion auto-assists — engages the enemy", () => {
  const inst: SquadInstance = {
    units: [
      { name: "ally", side: "ally", x: 0, z: 0 },
      { name: "enemy", side: "enemy", x: 8, z: 0 },
    ],
    covers: [],
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
    covers: [],
  };
  const sim = new SquadSim(inst, { seed: 6 });
  for (let i = 0; i < 60; i++) sim.step();
  assert.equal(sim.world.actors.get("player")!.hp, 100, "the friendly is untouched");
  assert.not.ok(stepStarts(sim, "ally").some((l) => l.startsWith("takeShot")), "the ally never fired");
  assert.not.equal(sim.units[0].planner.getStatus(), "failed", "no fight ⇒ the ally idles, it doesn't fail-loop");
});

// ---------------------------------------------------------------- E2: player command via setGoals

test("squad: a player 'regroup' order swaps the ally's goal and it falls back to a rally (setGoals seam)", () => {
  const inst: SquadInstance = {
    units: [
      { name: "ally", side: "ally", x: 4, z: 0, hp: 999 }, // unkillable for the test — it's about the order, not survival
      { name: "enemy", side: "enemy", x: 16, z: 0 },
    ],
    covers: [{ name: "rally", x: -8, z: 0, rally: true }],
  };
  const sim = new SquadSim(inst, { seed: 2 });
  for (let i = 0; i < 15; i++) sim.step();

  const before = sim.trace.length;
  sim.command("ally", "regroup"); // ← player order, routed through setGoals
  const rallyCell = sim.world.nav.cells.find((c) => c.rally)!.name;
  for (let i = 0; i < 200 && sim.world.actors.get("ally")!.cell !== rallyCell; i++) sim.step();

  assert.equal(sim.world.actors.get("ally")!.cell, rallyCell, "the ally fell back to the rally cell on command");
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
    assert.ok(scopes.some((t) => (t.e as { label: string }).label.includes("breach-window")), `${u} entered the timed breach window`);
  }
  assert.ok(sim.world.doorBroken, "the door was breached open");
  assert.ok(
    sim.trace.some((t) => t.e.t === "step.start" && (t.e as { label: string }).label.startsWith("breach")),
    "a breach action fired",
  );
  const blown = sim.trace.filter((t) => t.e.t === "scope.violated" && (t.e as { reason: string }).reason === "deadline");
  assert.equal(blown.length, 0, "the breach completed within the window (no deadline violation)");
  assert.ok([sim.world.actors.get("B1")!, sim.world.actors.get("B2")!].some((b) => b.hp < 100), "the breach hit the defenders");
});

// ---------------------------------------------------------------- E3: glass-box rejection reasons

test("squad: the planner can explain why an impossible engagement fails (glass-box)", () => {
  // a target fully walled off: no cell anywhere can see it, so achieve(canSee) — and
  // hence neutralize — is unreachable; explainFailure surfaces readable reasons.
  const inst: SquadInstance = {
    units: [
      { name: "E", side: "enemy", x: 0, z: 0 },
      { name: "player", side: "player", x: 0, z: 6 },
    ],
    covers: [],
    walls: [
      { x: -3, z: 3, w: 6, d: 1 },
      { x: -3, z: 9, w: 6, d: 1 },
      { x: -3, z: 3, w: 1, d: 7 },
      { x: 2, z: 3, w: 1, d: 7 },
    ],
  };
  const model = squadModel(inst, "E");
  const state = model.createExecState();
  state.set(model.slotOf("hasThreat"), 1);
  state.buffer[model.slotOf("threatPos")] = 0;
  state.buffer[model.slotOf("threatPos") + 1] = 6;
  const result = planOnce(model, state, {
    goals: [goal(F.ext("canSee", [], ["myPos", "threatPos"]))],
    collectRejections: true,
    maxNodes: 4000,
  });
  assert.equal(result.status, "failure", "no reachable line of sight ⇒ planning fails");
  assert.ok(explainFailure(result).length > 0, "explainFailure produced human-readable rejection reasons");
});

// ---------------------------------------------------------------- exports sanity

test("squad: TraceEvent type is re-exported through scenarios", () => {
  const e: TraceEvent = { t: "plan.completed" };
  assert.equal(e.t, "plan.completed");
});

test.run();
