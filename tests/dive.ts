import { test } from "uvu";
import * as assert from "uvu/assert";
import {
  type DiveInstance,
  DiveSim,
  DiveWorld,
  MAX_HEALTH,
  WEAPONS,
  arenaInstance,
  diveModel,
} from "../scenarios/dive";

/**
 * Dive — ground-truth assertions for the htn-ai deathmatch bot brain. These pin the
 * behaviours the demo shows off, all driven by the real reactive Planner per bot:
 * goal arbitration (attack / get-health / get-weapon / explore via method utility),
 * fight-from-sight, hunt-the-last-seen, item pickups, weapon selection, death +
 * respawn, and deterministic (seed + fixed timestep) replay.
 */

// the bot's executed step labels, in order
function stepStarts(sim: DiveSim, unit: string): string[] {
  return sim.trace.filter((t) => t.unit === unit && t.e.t === "step.start").map((t) => (t.e as { label: string }).label);
}
function ran(labels: string[], op: string): boolean {
  return labels.some((l) => l.startsWith(op));
}

// ---------------------------------------------------------------- domain validity

test("dive: the deathmatch domain compiles, grounds and binds", () => {
  const inst: DiveInstance = {
    halfWidth: 8,
    halfDepth: 8,
    bots: [{ name: "A", x: 0, z: 0 }],
    items: [{ name: "h", x: 2, z: 2, kind: "health" }],
    obstacles: [],
    spawns: [{ x: 0, z: 0 }],
  };
  const model = diveModel(inst, "A");
  assert.ok(model.operators.length >= 4, "operators compiled");
  assert.ok(model.methodsByTask.has("Compete"), "root Compete task has methods");
  assert.ok(model.methodsByTask.has("Attack"), "Attack compound has methods");
});

// ---------------------------------------------------------------- A: attack with line of sight

test("dive: a bot with a visible enemy arbitrates to ATTACK and fires", () => {
  // two bots in an empty arena with clear sight → both should pick the attack goal
  const inst: DiveInstance = {
    halfWidth: 10,
    halfDepth: 10,
    bots: [
      { name: "A", x: -5, z: 0 },
      { name: "B", x: 5, z: 0 },
    ],
    items: [],
    obstacles: [],
    spawns: [{ x: -9, z: -9 }, { x: 9, z: 9 }],
  };
  const sim = new DiveSim(inst, { seed: 3 });
  for (let i = 0; i < 40; i++) sim.step();
  assert.ok(ran(stepStarts(sim, "A"), "fight"), "A fired on the enemy it can see");
});

// ---------------------------------------------------------------- B: hunt the last-seen position

test("dive: losing sight of a target makes the bot HUNT the last-seen position", () => {
  // A sees B, then B is around a wall — A should switch from fight to hunt
  const inst: DiveInstance = {
    halfWidth: 12,
    halfDepth: 12,
    bots: [
      { name: "A", x: -8, z: 0 },
      { name: "B", x: 8, z: 0 },
    ],
    items: [],
    obstacles: [{ x: -1, z: 1, w: 2, d: 8 }], // wall B can duck behind
    spawns: [{ x: -10, z: -10 }, { x: 10, z: 10 }],
  };
  const sim = new DiveSim(inst, { seed: 5 });
  // freeze B (a stationary dummy) so A's reaction is isolated and deterministic
  sim.setControl("B", "human");
  // let A acquire B in the open first (clear sight along z=0, below the wall)
  for (let i = 0; i < 8; i++) sim.step();
  // now move B behind the wall (out of A's sight) and keep stepping
  const B = sim.world.actors.get("B")!;
  B.x = 8;
  B.z = 8;
  for (let i = 0; i < 25; i++) sim.step();
  assert.ok(ran(stepStarts(sim, "A"), "huntTo"), "A hunted B's last-seen position after losing sight");
});

// ---------------------------------------------------------------- C: get-health arbitration

test("dive: a hurt bot near a health pack arbitrates to GET-HEALTH over explore", () => {
  const inst: DiveInstance = {
    halfWidth: 10,
    halfDepth: 10,
    bots: [{ name: "A", x: -4, z: 0 }],
    items: [{ name: "med", x: 0, z: 0, kind: "health" }],
    obstacles: [],
    spawns: [{ x: -9, z: -9 }],
  };
  const sim = new DiveSim(inst, { seed: 1 });
  sim.world.actors.get("A")!.hp = 30; // hurt → health desirability beats explore
  for (let i = 0; i < 40; i++) sim.step();
  assert.ok(ran(stepStarts(sim, "A"), "pickup"), "A went to fetch the health pack");
  assert.ok(sim.world.actors.get("A")!.hp > 30, "A's health increased after pickup");
});

// ---------------------------------------------------------------- D: weapon pickup

test("dive: a bot collects a weapon and refills its ammo (GET-WEAPON)", () => {
  const inst: DiveInstance = {
    halfWidth: 10,
    halfDepth: 10,
    bots: [{ name: "A", x: -3, z: 0 }],
    items: [{ name: "sg", x: 0, z: 0, kind: "weapon", weapon: "shotgun" }],
    obstacles: [],
    spawns: [{ x: -9, z: -9 }],
  };
  const sim = new DiveSim(inst, { seed: 1 });
  assert.is(sim.world.actors.get("A")!.ammo.get("shotgun"), 0, "starts with no shotgun ammo");
  for (let i = 0; i < 40; i++) sim.step();
  assert.is(sim.world.actors.get("A")!.ammo.get("shotgun"), WEAPONS.shotgun.maxAmmo, "shotgun ammo refilled by pickup");
});

// ---------------------------------------------------------------- E: explore when nothing else

test("dive: an idle, healthy, weapon-full bot with no enemy EXPLORES", () => {
  const inst: DiveInstance = {
    halfWidth: 10,
    halfDepth: 10,
    bots: [{ name: "A", x: 0, z: 0 }],
    items: [], // no items wanted → explore is the only positive goal
    obstacles: [],
    spawns: [{ x: -9, z: -9 }],
  };
  const sim = new DiveSim(inst, { seed: 1 });
  for (let i = 0; i < 20; i++) sim.step();
  assert.ok(ran(stepStarts(sim, "A"), "roamTo"), "A roamed the arena");
});

// ---------------------------------------------------------------- F: death + respawn

test("dive: a killed bot respawns at full health after the respawn delay", () => {
  const inst = arenaInstance();
  const sim = new DiveSim(inst, { seed: 2, dt: 0.1 });
  const victim = sim.world.actors.get("Vela")!;
  const killer = sim.world.actors.get("Orion")!;
  victim.hp = 1;
  // force a kill through the world so the death/respawn machinery runs
  killer.x = victim.x + 1;
  killer.z = victim.z;
  sim.world.fire(killer, victim, () => 0); // guaranteed hit
  assert.is(victim.alive, false, "victim died");
  assert.is(killer.frags, 1, "killer scored a frag");
  for (let i = 0; i < 40; i++) sim.step(); // > RESPAWN_DELAY
  assert.is(victim.alive, true, "victim respawned");
  assert.is(victim.hp, MAX_HEALTH, "respawned at full health");
});

// ---------------------------------------------------------------- G: determinism

test("dive: identical seed + fixed timestep ⇒ byte-identical rollouts", () => {
  const run = () => {
    const sim = new DiveSim(arenaInstance(), { seed: 9, dt: 0.1 });
    const tail: string[] = [];
    for (let i = 0; i < 120; i++) {
      const f = sim.step();
      tail.push(f.bots.map((b) => `${b.name}:${b.x},${b.z},${b.hp},${b.frags}`).join("|"));
    }
    return tail.join("\n");
  };
  assert.is(run(), run(), "two rollouts with the same seed match exactly");
});

// ---------------------------------------------------------------- H: a full 4-bot match runs

test("dive: a 4-bot free-for-all runs and produces frags", () => {
  const sim = new DiveSim(arenaInstance(), { seed: 4, dt: 0.1, fragLimit: 3 });
  const frames = sim.run(3000);
  const totalFrags = [...sim.world.actors.values()].reduce((s, a) => s + a.frags, 0);
  assert.ok(frames.length > 1, "the match produced frames");
  assert.ok(totalFrags > 0, "bots actually killed each other in the deathmatch");
});

// ---------------------------------------------------------------- I: human control swap

test("dive: a bot can be swapped to human control and driven by input", () => {
  const sim = new DiveSim(arenaInstance(), { seed: 1 });
  sim.setControl("Vela", "human");
  assert.is(sim.world.actors.get("Vela")!.control, "human");
  assert.is(sim.bots.has("Vela"), false, "human bot has no planner");
  const before = { ...sim.world.actors.get("Vela")! };
  sim.setInput("Vela", { moveX: 1, moveZ: 0 });
  for (let i = 0; i < 5; i++) sim.step();
  assert.ok(sim.world.actors.get("Vela")!.x > before.x, "human input moved the bot");
  // swap back to AI → planner rebuilt
  sim.setControl("Vela", "ai");
  assert.is(sim.bots.has("Vela"), true, "AI control rebuilt the planner");
});

// ---------------------------------------------------------------- J: world line-of-sight

test("dive: obstacles block line of sight", () => {
  const world = new DiveWorld({
    halfWidth: 10,
    halfDepth: 10,
    bots: [],
    items: [],
    obstacles: [{ x: -1, z: -1, w: 2, d: 2 }],
    spawns: [],
  });
  assert.is(world.losClear(-5, 0, 5, 0), false, "a wall on the line blocks sight");
  assert.is(world.losClear(-5, 5, 5, 5), true, "an offset line is clear");
});

test.run();
