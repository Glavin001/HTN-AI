import { test } from "uvu";
import * as assert from "uvu/assert";
import {
  DomainDoc,
  E,
  F,
  N,
  PlanningSession,
  Planner,
  Scheduler,
  TraceEvent,
  createModel,
  goal,
  planOnce,
  task,
} from "../src/index";

// ---------------------------------------------------------------- suffix repair from the failure point

test("repair: a step failing at execution replans from the failure point, not from scratch", () => {
  const doc: DomainDoc = {
    name: "corridor",
    types: [{ name: "room" }],
    fluents: [
      { name: "at", kind: "entity", entityType: "room" },
      {
        name: "open",
        params: [
          { name: "a", type: "room" },
          { name: "b", type: "room" },
        ],
        kind: "boolean",
      },
    ],
    operators: [
      {
        name: "move",
        params: [
          { name: "a", type: "room" },
          { name: "b", type: "room" },
        ],
        pre: F.and(F.lit("at", [], "?a"), F.lit("open", ["?a", "?b"])),
        eff: [E.set("at", [], "?b")],
      },
    ],
  };
  const model = createModel(doc, {
    entities: { r1: "room", r2: "room", r3: "room", r6: "room" },
    init: (w) => {
      w.set("at", [], "r1");
      w.set("open", ["r1", "r2"], true);
      w.set("open", ["r2", "r3"], true); // direct edge (will jam)
      w.set("open", ["r2", "r6"], true); // detour
      w.set("open", ["r6", "r3"], true);
    },
  });
  const events: TraceEvent[] = [];
  let t = 0;
  const planner = new Planner(model, { goals: [goal(F.lit("at", [], "r3"))], now: () => t, weight: 1, trace: (e) => events.push(e) });

  planner.tick({ nodes: 100000 }); // plan r1→r2→r3, execute move(r1,r2)
  assert.equal(model.read(planner.state, "at"), "r2");

  // jam the direct door WITHOUT notifying the planner (buffer write bypasses dirty-tracking,
  // simulating a surprise discovered only when the step's precondition is re-checked)
  planner.state.buffer[model.slotOf("open", model.entityId("r2"), model.entityId("r3"))] = 0;

  t = 1;
  planner.tick({ nodes: 100000 }); // pre re-check fails → suffix repair
  for (let i = 0; i < 6 && planner.getStatus() !== "succeeded"; i++) {
    t += 1;
    planner.tick({ nodes: 100000 });
  }
  assert.equal(planner.getStatus(), "succeeded");
  assert.equal(model.read(planner.state, "at"), "r3", "reached the goal via the detour");
  assert.ok(events.some((e) => e.t === "repair.attempt"), "suffix repair attempted");
  assert.ok(events.some((e) => e.t === "repair.success"), "suffix repair succeeded (no full replan needed)");
});

// ---------------------------------------------------------------- reactive replace (replan-only-if-better)

test("reactive: relevant world changes replace the plan; irrelevant ones do not", () => {
  const doc: DomainDoc = {
    name: "react",
    fluents: [
      { name: "alarm", kind: "boolean" },
      { name: "chored", kind: "boolean" },
      { name: "hidden", kind: "boolean" },
      { name: "weather", kind: "int" }, // irrelevant to any plan condition
    ],
    operators: [
      { name: "chores", eff: [E.set("chored", [], true)], executor: "slow" },
      { name: "hide", pre: F.lit("alarm"), eff: [E.set("hidden", [], true)] },
    ],
    methods: [
      { name: "panic", task: "Day", pre: F.lit("alarm"), subtasks: [{ do: "hide" }] },
      { name: "normal", task: "Day", subtasks: [{ do: "chores" }] },
    ],
  };
  let ticks = 0;
  const model = createModel(doc, {}, { executors: { slow: () => (++ticks >= 10 ? "success" : "continue") } });
  const events: TraceEvent[] = [];
  const t = 0;
  const planner = new Planner(model, { goals: [task("Day")], now: () => t, trace: (e) => events.push(e) });

  planner.tick({ nodes: 100000 });
  assert.equal(planner.getStatus(), "running", "doing chores");

  // irrelevant change: no replan session at all
  planner.state.set(model.slotOf("weather"), 7);
  planner.tick({ nodes: 100000 });
  assert.ok(!events.some((e) => e.t === "replan.dirty"), "irrelevant fluent ignored (fluent-precise triggers)");

  // relevant change: alarm! the higher-priority method now beats the running plan (MTR)
  planner.state.set(model.slotOf("alarm"), 1);
  planner.tick({ nodes: 100000 });
  assert.ok(events.some((e) => e.t === "replan.dirty"), "relevant fluent triggers replanning");
  for (let i = 0; i < 5 && planner.getStatus() !== "succeeded"; i++) planner.tick({ nodes: 100000 });
  assert.equal(model.read(planner.state, "hidden"), true, "switched to the better branch");
  assert.equal(model.read(planner.state, "chored"), false, "chores were abandoned");
});

// ---------------------------------------------------------------- budgeted, resumable planning sessions

test("budgeted sessions: planning pauses on a node budget and resumes to the same answer", () => {
  // numeric water-jug variant (7L & 11L, measure 6L): numeric goals get no
  // h_add guidance → uniform-cost search with a real frontier to slice up
  const doc: DomainDoc = {
    name: "budget",
    fluents: [
      { name: "j7", kind: "int", initial: 0 },
      { name: "j11", kind: "int", initial: 0 },
      { name: "tmp", kind: "int" },
    ],
    operators: [
      { name: "fill7", eff: [E.set("j7", [], N.c(7))] },
      { name: "fill11", eff: [E.set("j11", [], N.c(11))] },
      { name: "empty7", eff: [E.set("j7", [], N.c(0))] },
      { name: "empty11", eff: [E.set("j11", [], N.c(0))] },
      {
        name: "pour7to11",
        eff: [
          E.set("tmp", [], N.min(N.fl("j7"), N.sub(11, N.fl("j11")))),
          E.dec("j7", [], N.fl("tmp")),
          E.inc("j11", [], N.fl("tmp")),
        ],
      },
      {
        name: "pour11to7",
        eff: [
          E.set("tmp", [], N.min(N.fl("j11"), N.sub(7, N.fl("j7")))),
          E.dec("j11", [], N.fl("tmp")),
          E.inc("j7", [], N.fl("tmp")),
        ],
      },
    ],
  };
  const model = createModel(doc, {});

  const session = new PlanningSession(model, model.createExecState(), {
    goals: [goal(F.eq(N.fl("j11"), 6))],
    weight: 1,
  });
  let pauses = 0;
  let result = session.step({ nodes: 8 });
  while (result === null) {
    pauses++;
    result = session.step({ nodes: 8 });
  }
  assert.ok(pauses >= 1, `search paused and resumed across budget slices (${pauses} pauses)`);
  assert.equal(result.status, "success");
  const oneShot = planOnce(model, model.createExecState(), {
    goals: [goal(F.eq(N.fl("j11"), 6))],
    weight: 1,
  });
  assert.equal(
    result.plan!.steps.map((s) => (s.k === "op" ? model.describeGroundOp(s.g) : "?")),
    oneShot.plan!.steps.map((s) => (s.k === "op" ? model.describeGroundOp(s.g) : "?")),
    "budgeted and unbudgeted searches find the identical plan",
  );
});

// ---------------------------------------------------------------- determinism

test("determinism: identical inputs produce byte-identical plans and traces", () => {
  const doc: DomainDoc = {
    name: "det",
    fluents: [
      { name: "a", kind: "boolean" },
      { name: "b", kind: "boolean" },
      { name: "c", kind: "boolean" },
    ],
    operators: [
      { name: "doA", eff: [E.set("a", [], true)] },
      { name: "doB", pre: F.lit("a"), eff: [E.set("b", [], true)] },
      { name: "doC", pre: F.lit("b"), eff: [E.set("c", [], true)] },
    ],
  };
  const run = (): string => {
    const model = createModel(doc, {});
    const events: string[] = [];
    let t = 0;
    const planner = new Planner(model, {
      goals: [goal(F.lit("c"))],
      now: () => t,
      seed: 42,
      weight: 1,
      trace: (e) => events.push(JSON.stringify(e)),
    });
    for (let i = 0; i < 10 && planner.getStatus() !== "succeeded"; i++) {
      t += 0.1;
      planner.tick({ nodes: 100000 });
    }
    assert.equal(planner.getStatus(), "succeeded");
    return events.join("\n");
  };
  assert.equal(run(), run(), "two runs with the same seed and clock are identical");
});

// ---------------------------------------------------------------- multi-agent scheduler

test("scheduler: many agents share a planning budget and all complete", () => {
  const doc: DomainDoc = {
    name: "many",
    fluents: [{ name: "done", kind: "boolean" }],
    operators: [{ name: "work", eff: [E.set("done", [], true)] }],
  };
  const scheduler = new Scheduler();
  const planners: Planner[] = [];
  for (let i = 0; i < 25; i++) {
    const model = createModel(doc, {});
    const p = new Planner(model, { goals: [goal(F.lit("done"))], now: () => i });
    planners.push(p);
    scheduler.add(p);
  }
  for (let round = 0; round < 6; round++) scheduler.tick(4);
  for (const p of planners) {
    assert.equal(p.getStatus(), "succeeded");
    assert.equal(p.model.read(p.state, "done"), true);
  }
});

// ---------------------------------------------------------------- goal-agenda serialization

test("goalAgenda: a conjunction of independent sub-goals is solved one at a time, with commitment", () => {
  // five lamps, each toggled on by its own operator. Handed as a goal agenda, the
  // planner should achieve them in order and only report success after the last.
  const ids = [0, 1, 2, 3, 4];
  const doc: DomainDoc = {
    name: "lamps",
    fluents: ids.map((i) => ({ name: `on${i}`, kind: "boolean" as const, initial: false })),
    operators: ids.map((i) => ({ name: `flip${i}`, eff: [E.set(`on${i}`, [], true)] })),
  };
  const model = createModel(doc, {});
  const planner = new Planner(model, {
    goals: ids.map((i) => goal(F.lit(`on${i}`))),
    goalAgenda: true,
    now: () => 0,
    seed: 1,
  });
  assert.equal(planner.goalCount(), 5);

  const seen: number[] = [];
  for (let i = 0; i < 200 && planner.getStatus() !== "succeeded" && planner.getStatus() !== "failed"; i++) {
    planner.tick({ ms: 5 });
    seen.push(planner.activeGoalIndex());
  }
  assert.equal(planner.getStatus(), "succeeded");
  // the cursor marched all the way to the final sub-goal
  assert.equal(Math.max(...seen), 4);
  // every sub-goal achieved
  for (const i of ids) assert.equal(model.read(planner.state, `on${i}`), true);
});

test("goalAgenda off (default): the same goals are pursued as one joint plan", () => {
  const ids = [0, 1, 2];
  const doc: DomainDoc = {
    name: "lamps2",
    fluents: ids.map((i) => ({ name: `on${i}`, kind: "boolean" as const, initial: false })),
    operators: ids.map((i) => ({ name: `flip${i}`, eff: [E.set(`on${i}`, [], true)] })),
  };
  const model = createModel(doc, {});
  const planner = new Planner(model, { goals: ids.map((i) => goal(F.lit(`on${i}`))), now: () => 0, seed: 1 });
  for (let i = 0; i < 200 && planner.getStatus() !== "succeeded" && planner.getStatus() !== "failed"; i++) planner.tick({ ms: 5 });
  assert.equal(planner.getStatus(), "succeeded");
  // without goal-agenda the cursor never advances (it's not in serialization mode)
  assert.equal(planner.activeGoalIndex(), 0);
  for (const i of ids) assert.equal(model.read(planner.state, `on${i}`), true);
});

test.run();
