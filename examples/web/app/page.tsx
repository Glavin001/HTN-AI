"use client";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { runScenario, scenarioHeavyMs, traceSummary, type RunResult } from "../lib/run";
import { runBlocks, type BlocksRun } from "../lib/runBlocks";
import { runSquad, squadTraceSummary, type SquadRun, type SquadScenarioId } from "../lib/runSquad";

const StaircaseScene = dynamic(() => import("../components/StaircaseScene"), { ssr: false });
const BlocksScene = dynamic(() => import("../components/BlocksScene"), { ssr: false });
const SquadScene = dynamic(() => import("../components/SquadScene"), { ssr: false });
import SquadDirector from "../components/SquadDirector";

type GridId = "staircase" | "ledge" | "quarry" | "scavenger" | "scavengerBig" | "scavengerHuge";
type ScenarioId = GridId | "blocks" | SquadScenarioId;
type Kind = "grid" | "blocks" | "squad";

type Run =
  | { kind: "grid"; data: RunResult }
  | { kind: "blocks"; data: BlocksRun }
  | { kind: "squad"; data: SquadRun };

const SCENARIOS: Record<ScenarioId, { name: string; blurb: string; kind: Kind }> = {
  skirmish: {
    name: "★ Squad: Skirmish",
    kind: "squad",
    blurb:
      "Two NPCs flush a crossing target with coordinated suppress-and-flank, reserve distinct cover, and call their tactics — F.E.A.R.-style squad AI, every decision from the real reactive planner.",
  },
  blockedFlank: {
    name: "★ Squad: Emergent flank",
    kind: "squad",
    blurb:
      "A barricade blocks the direct line of fire. No flank route is scripted — the GOAP planner DISCOVERS it must move to a cover that can see the target (the library's staircase emergence, turned on combat).",
  },
  breach: {
    name: "★ Squad: Timed breach",
    kind: "squad",
    blurb:
      "A fire-team stacks on a door and breaches in sync inside a deadline window. The projected-clock deadline prunes anyone who can't make it — temporal coordination F.E.A.R. never had.",
  },
  companion: {
    name: "★ Squad: Companion + orders",
    kind: "squad",
    blurb:
      "An allied companion fights beside the player and takes orders (Engage / Regroup / Hold fire) routed through Planner.setGoals — the seam an LLM later drives. Issue an order, watch the plan change.",
  },
  staircase: {
    name: "Staircase",
    kind: "grid",
    blurb:
      "Goal: stand at a coordinate up in the air. The only way to gain height is to stack boxes — so the planner discovers it must carry blocks from the depot, build a staircase, and climb it.",
  },
  ledge: {
    name: "Climb the ledge",
    kind: "grid",
    blurb: "A 2-high wall the agent can't climb directly. The planner figures out it must build a single step, then walk up and over.",
  },
  quarry: {
    name: "Quarry (advanced)",
    kind: "grid",
    blurb:
      "A grid world: reach the top of a height-4 pillar. Blocks are scattered across two depots and a wall blocks the way. The planner finds the optimal route to collect and build a 3-step staircase — from a position-only goal.",
  },
  scavenger: {
    name: "Scavenger (collect & harvest)",
    kind: "grid",
    blurb:
      "Blocks lie scattered — no depots. You can only take the TOP of a stack, and only if you're high enough. So the planner grabs a loose block, builds a step, climbs it, harvests a pillar's top, and reaches a spot in the air.",
  },
  scavengerBig: {
    name: "Scavenger XL (taller, harder)",
    kind: "grid",
    blurb: "A bigger 4×3 grid, a height-3 goal and seven scattered blocks. Loose blocks alone aren't enough, so the planner must harvest the pillar and stack a 3-level structure.",
  },
  scavengerHuge: {
    name: "Scavenger HUGE (stress · ~9s)",
    kind: "grid",
    blurb: "A 6×4 grid (24 cells) littered with blocks — a deliberate stress test (~9s to plan). Search is hard-capped so it can't run away.",
  },
  blocks: {
    name: "Blocks World (Sussman)",
    kind: "blocks",
    blurb: "The classic Sussman anomaly: C on A; goal A-on-B-on-C. The naive order deadlocks, so the planner must interleave subgoals.",
  },
};

type SquadOrder = "engage" | "regroup" | "holdFire";

function buildRun(id: ScenarioId, squadOrder: { at: number; order: SquadOrder } | null): Run {
  const kind = SCENARIOS[id].kind;
  if (kind === "blocks") return { kind: "blocks", data: runBlocks() };
  if (kind === "squad") {
    return {
      kind: "squad",
      data: runSquad(id as SquadScenarioId, id === "companion" && squadOrder ? { allyCommand: { ...squadOrder, unit: "ally" } } : {}),
    };
  }
  return { kind: "grid", data: runScenario(id as GridId) };
}

export default function Page() {
  const [scenario, setScenario] = useState<ScenarioId>("skirmish");
  const [run, setRun] = useState<Run | null>(null);
  const [computing, setComputing] = useState(true);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(450);
  const [selected, setSelected] = useState<string | null>(null);
  const [squadOrder, setSquadOrder] = useState<{ at: number; order: SquadOrder } | null>(null);

  useEffect(() => {
    setComputing(true);
    setRun(null);
    setStep(0);
    const id = setTimeout(() => {
      const r = buildRun(scenario, squadOrder);
      setRun(r);
      setComputing(false);
      setPlaying(true);
      if (r.kind === "squad" && !selected) setSelected(r.data.units[0] ?? null);
    }, 30);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, squadOrder]);

  const frameCount = run ? run.data.frames.length : 0;
  const lastStep = Math.max(frameCount - 1, 0);

  useEffect(() => {
    if (!playing || !run) return;
    if (step >= lastStep) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(() => setStep((s) => s + 1), speed);
    return () => clearTimeout(id);
  }, [playing, step, run, speed, lastStep]);

  const trace = run ? (run.kind === "squad" ? run.data.trace.map((t) => t.e) : run.data.trace) : [];
  const summary = useMemo(
    () => (run?.kind === "squad" ? squadTraceSummary(run.data.trace) : traceSummary(trace)),
    [run, trace],
  );
  const interesting = useMemo(() => summary.filter((s) => /repair|replan|fail|scope|drift/.test(s.label)), [summary]);

  const status = run?.kind === "grid" ? run.data.status : run?.kind === "squad" ? squadOutcome(run.data, step) : "—";

  const issueOrder = (order: SquadOrder) => {
    setSquadOrder({ at: Math.max(1, step), order }); // inject at the scrubbed moment, then replay
  };

  return (
    <div className="app">
      <div className="stage">
        <div className="title">
          <h1>htn-ai · {SCENARIOS[scenario].name}</h1>
          <p>{SCENARIOS[scenario].blurb}</p>
        </div>
        {run?.kind === "grid" && (
          <StaircaseScene key="grid" frame={run.data.frames[step]} instance={run.data.instance} target={run.data.target} reached={step === lastStep && status === "succeeded"} />
        )}
        {run?.kind === "blocks" && <BlocksScene key="blocks" frame={run.data.frames[step]} blocks={run.data.blocks} reached={step === lastStep} />}
        {run?.kind === "squad" && (
          <SquadScene key="squad" frame={run.data.frames[Math.min(step, lastStep)]} instance={run.data.instance} selected={selected} onSelect={(n) => setSelected(n || null)} />
        )}
        {computing && (
          <div style={overlay}>
            <div style={{ fontSize: 16, color: "var(--text)" }}>⏳ Planning…</div>
            {scenario in SCENARIOS && SCENARIOS[scenario].kind === "grid" && scenarioHeavyMs(scenario as GridId) > 0 && (
              <div style={{ fontSize: 12 }}>heavy stress scenario — searching (~{Math.round(scenarioHeavyMs(scenario as GridId) / 1000)}s)</div>
            )}
          </div>
        )}
      </div>

      <aside className="panel">
        <div className="card">
          <h2>Scenario</h2>
          <div className="row spread">
            <select value={scenario} onChange={(e) => { setScenario(e.target.value as ScenarioId); setSquadOrder(null); setSelected(null); }}>
              {(Object.keys(SCENARIOS) as ScenarioId[]).map((id) => (
                <option key={id} value={id}>
                  {SCENARIOS[id].name}
                </option>
              ))}
            </select>
            <span className={`pill ${/clear|succeeded|win/.test(status) ? "good" : status === "failed" ? "bad" : "busy"}`}>{status}</span>
          </div>
        </div>

        <div className="card">
          <h2>Playback {run?.kind === "squad" ? "· replay" : ""}</h2>
          <div className="row">
            <button className="primary" onClick={() => setPlaying((p) => !p)} disabled={!run}>
              {playing ? "⏸ Pause" : "▶ Play"}
            </button>
            <button onClick={() => setStep((s) => Math.min(s + 1, lastStep))} disabled={!run || step >= lastStep}>
              Step ⟩
            </button>
            <button onClick={() => { setStep(0); setPlaying(true); }} disabled={!run}>
              ⟲ Reset
            </button>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className="mono" style={{ color: "var(--muted)" }}>speed</span>
            <input type="range" min={120} max={1400} step={20} value={1520 - speed} onChange={(e) => setSpeed(1520 - Number(e.target.value))} style={{ flex: 1 }} />
            <span className="mono">{step}/{lastStep}</span>
          </div>
        </div>

        {scenario === "companion" && (
          <div className="card">
            <h2>Player orders → ally</h2>
            <div className="mono" style={{ color: "var(--muted)", marginBottom: 8 }}>
              routed through <span style={{ color: "var(--accent-2)" }}>Planner.setGoals</span> — the LLM seam. Issued at the scrubbed moment, then replayed.
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              <button onClick={() => issueOrder("engage")} className={squadOrder?.order === "engage" ? "primary" : ""}>Engage</button>
              <button onClick={() => issueOrder("regroup")} className={squadOrder?.order === "regroup" ? "primary" : ""}>Regroup</button>
              <button onClick={() => issueOrder("holdFire")} className={squadOrder?.order === "holdFire" ? "primary" : ""}>Hold fire</button>
              {squadOrder && <button onClick={() => setSquadOrder(null)}>clear</button>}
            </div>
          </div>
        )}

        {run?.kind === "squad" && <SquadDirector frame={run.data.frames[Math.min(step, lastStep)]} units={run.data.units} selected={selected} onSelect={(n) => setSelected(n || null)} />}

        {run?.kind === "grid" && (
          <div className="card">
            <h2>Goal</h2>
            <div className="mono">
              be at 3D position <span style={{ color: "var(--accent-2)" }}>({run.data.target.x}, {run.data.target.y}, {run.data.target.z})</span>
            </div>
          </div>
        )}

        <div className="card">
          <h2>Trace events</h2>
          <div className="legend" style={{ marginBottom: 8 }}>
            {summary.map((s) => (
              <span key={s.label} className="mono">{s.label}:{s.count}</span>
            ))}
          </div>
          {interesting.length > 0 ? (
            <div className="mono" style={{ color: "var(--accent-2)" }}>reactive events: {interesting.map((s) => `${s.label}×${s.count}`).join(", ")}</div>
          ) : (
            <div className="mono" style={{ color: "var(--muted)" }}>clean run — no repair/replan yet</div>
          )}
        </div>
      </aside>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexDirection: "column",
  gap: 8,
  color: "var(--muted)",
  background: "rgba(11,14,20,0.55)",
  zIndex: 3,
};

function squadOutcome(run: SquadRun, step: number): string {
  const f = run.frames[Math.min(step, run.frames.length - 1)];
  if (!f) return "—";
  const enemies = f.units.filter((u) => u.side === "enemy");
  const friends = f.units.filter((u) => u.side !== "enemy");
  if (enemies.every((u) => !u.alive)) return "enemies down";
  if (friends.every((u) => !u.alive)) return "target down";
  return "engaging";
}
