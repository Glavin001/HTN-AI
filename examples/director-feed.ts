/**
 * Runnable integration example: the structured plan-event stream (the
 * "director feed") — how a game/agent host consumes plan lifecycle events.
 *
 *   Run it:            npm run demo:director
 *   In your project:   import { Planner, PlanEventStream, task } from "htn-ai";
 *
 * The integration is three lines:
 *
 *   const stream = new PlanEventStream();
 *   stream.attach(planner, "alpha");            // one stream, many planners
 *   ...
 *   planner.tick({ ms: 0.5 });                  // every frame, in your game loop
 *   for (const e of stream.drain()) director.observe(e);
 *
 * Every event is plain JSON data — `plan.created` / `step.started` /
 * `step.completed` / `plan.completed` / `plan.invalidated` / `plan.failed` —
 * stamped with { agent, planId, seq, at } and carrying a machine-readable
 * reason, so a director system (or an LLM) can react to *why* a plan died,
 * not just that it did.
 *
 * The script runs one mission over the ~6-operator demo domain in
 * scenarios/director.ts (GoTo / Breach / TakeCover / Suppress / Regroup /
 * Idle) and injects the three kinds of surprise a live game produces:
 *
 *   1. a SILENT world change  — the doorway collapses in the nav mesh; the
 *      planner discovers it when the step's precondition re-check fails
 *      → plan.invalidated { step-failed, cause: "precondition" } → repair
 *   2. an ANNOUNCED change    — the traversal oracle re-weights the flank and
 *      the host bumps the version fluent → plan.invalidated { world-changed }
 *      → a cheaper plan is installed (via: "improve")
 *   3. an IMPOSSIBLE tasking  — a second agent whose goal is unreachable
 *      → plan.failed { search-exhausted } with the search's rejection log
 */

import { PlanEvent, PlanEventStream, Planner, task } from "../src/index";
import { directorModel, directorWorld, edgeKey } from "../scenarios/director";

// ---------------------------------------------------------------- rendering

const opChain = (steps: { label: string; kind: string }[]): string =>
  steps.filter((s) => s.kind === "op").map((s) => s.label).join(" → ");

function describeReason(r: Extract<PlanEvent, { t: "plan.invalidated" }>["reason"]): string {
  switch (r.kind) {
    case "world-changed":
      return `world changed (${r.fluents.join(", ")}) — a better plan exists`;
    case "step-failed":
      return `step ${r.step} failed [cause: ${r.cause}]${r.scope ? ` [scope: ${r.scope.label}/${r.scope.violated}]` : ""} — ${r.detail}`;
    case "search-exhausted": {
      const top = r.rejections.slice(0, 3).map((x) => `${x.at}: ${x.reason}`);
      return `no plan exists — ${r.rejections.length} rejections${top.length ? ` (e.g. ${top.join("; ")})` : ""}`;
    }
  }
}

function render(e: PlanEvent): string {
  const stamp = `t=${e.at.toFixed(1).padStart(5)}s  ${e.agent}·plan#${e.planId}`;
  switch (e.t) {
    case "plan.created":
      return `[${stamp}] ■ PLAN CREATED via ${e.via}  (cost ${e.cost})\n${" ".repeat(24)}${opChain(e.steps)}`;
    case "step.started":
      return `[${stamp}]   ▶ ${e.label}`;
    case "step.completed":
      return `[${stamp}]   ✔ ${e.label}`;
    case "plan.completed":
      return `[${stamp}] ★ PLAN COMPLETED`;
    case "plan.invalidated":
      return `[${stamp}] ✖ PLAN INVALIDATED — ${describeReason(e.reason)}`;
    case "plan.failed":
      return `[${stamp}] ☠ PLANNING FAILED — ${describeReason(e.reason)}`;
  }
}

const world = (msg: string): void => console.log(`\n        🌍 ${msg}\n`);

// ---------------------------------------------------------------- act 1: one mission, two surprises

console.log("=".repeat(78));
console.log("director feed — one agent, one mission, two mid-mission surprises");
console.log("=".repeat(78));

const w = directorWorld(); // live host stubs: nav mesh, traversal oracle, cover system
const model = directorModel(w); // compile once; reuse across agents/missions
const clock = { t: 0 }; // injected clock → deterministic transcript

const stream = new PlanEventStream();
const alpha = new Planner(model, {
  goals: [task("Directive")],
  now: () => clock.t,
  weight: 1,
  collectRejections: true, // so plan.failed carries WHY
});
stream.attach(alpha, "alpha");

let doorCollapsed = false;
let oracleShifted = false;
const invalidations: PlanEvent[] = [];

for (let tick = 0; alpha.getStatus() !== "succeeded" && tick < 40; tick++) {
  // in a real game this is your frame loop, budgeted: alpha.tick({ ms: 0.5 })
  alpha.tick({ nodes: 200_000 });

  // the director consumes the feed wherever it likes — here, once per tick
  for (const e of stream.drain()) {
    console.log(render(e));
    if (e.t === "plan.invalidated") invalidations.push(e);

    // surprise #1 — right after the breach, the doorway collapses. The nav
    // mesh (a live JS object the preconditions query) changes SILENTLY: the
    // planner finds out when GoTo(room)'s precondition re-check fails.
    if (e.t === "step.completed" && e.label === "Breach()" && !doorCollapsed) {
      doorCollapsed = true;
      w.nav.blocked.add(edgeKey("doorstep", "room"));
      world("the breached doorway collapses — nav mesh changed, nothing announced");
    }

    // surprise #2 — mid-reroute, the traversal oracle re-weights the flank.
    // The host ANNOUNCES it by bumping the version fluent the preconditions
    // declare in their reads; the planner reacts and swaps in a cheaper plan.
    if (e.t === "step.completed" && e.label === "GoTo(start)" && !oracleShifted) {
      oracleShifted = true;
      w.oracle.set(edgeKey("start", "flank"), 0.5);
      w.oracle.set(edgeKey("flank", "cover1"), 0.5);
      alpha.state.set(model.slotOf("navVersion"), 1);
      world("traversal oracle re-weights: the flank is suddenly cheap (announced via navVersion)");
    }
  }
  clock.t += 1.2; // demo time-step; suppressing fire takes ~1s of sim time
}

console.log(`\nmission status: ${alpha.getStatus()}`);

// ---------------------------------------------------------------- act 2: impossible tasking (same stream, second agent)

console.log("\n" + "=".repeat(78));
console.log("second agent, impossible tasking — failure arrives as data, not a string");
console.log("=".repeat(78));

const w2 = directorWorld();
w2.nav.blocked.add(edgeKey("doorstep", "room")); // every approach to cover
w2.nav.blocked.add(edgeKey("flank", "cover1")); //  is blocked, so the goal
w2.nav.blocked.add(edgeKey("rally", "cover1")); //  is unreachable
const bravo = new Planner(directorModel(w2), { goals: [task("Directive")], now: () => clock.t, weight: 1, collectRejections: true });
stream.attach(bravo, "bravo"); // same stream — the feed merges agents

bravo.tick({ nodes: 200_000 });
const bravoEvents = stream.drain();
for (const e of bravoEvents) console.log(render(e));

// ---------------------------------------------------------------- the payload IS the API

console.log("\n" + "=".repeat(78));
console.log("every event is plain JSON — hand it to your director/telemetry/LLM as-is");
console.log("=".repeat(78));
console.log(JSON.stringify(invalidations[0], null, 2));
