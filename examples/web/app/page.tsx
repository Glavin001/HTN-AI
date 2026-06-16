"use client";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { runScenario, scenarioHeavyMs, traceSummary, type RunResult } from "../lib/run";
import { runBlocks, type BlocksRun } from "../lib/runBlocks";
import {
  runSquad,
  squadNarration,
  squadTacticBanner,
  squadTraceSummary,
  whatToWatch,
  type SquadRun,
  type SquadScenarioId,
} from "../lib/runSquad";

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
  skirmish: { name: "★ Squad: Skirmish", kind: "squad", blurb: "Two NPCs flush a target with coordinated suppress-and-flank — F.E.A.R.-style squad AI, every decision from the real reactive planner." },
  blockedFlank: { name: "★ Squad: Emergent flank", kind: "squad", blurb: "A barricade blocks the direct shot. No flank is scripted — the planner DISCOVERS it must reach a cover that can see the target." },
  breach: { name: "★ Squad: Timed breach", kind: "squad", blurb: "A fire-team stacks and breaches in sync inside a deadline window enforced inside the planner's search." },
  companion: { name: "★ Squad: Companion + orders", kind: "squad", blurb: "An allied companion fights beside you and takes orders routed through Planner.setGoals — the LLM seam." },
  staircase: { name: "Staircase", kind: "grid", blurb: "Goal: stand at a coordinate in the air. The only way up is to stack boxes — so the planner discovers it must build a staircase and climb it." },
  ledge: { name: "Climb the ledge", kind: "grid", blurb: "A 2-high wall the agent can't climb directly. The planner builds a single step, then walks up and over." },
  quarry: { name: "Quarry (advanced)", kind: "grid", blurb: "Reach a height-4 pillar. Blocks are scattered across two depots and a wall blocks the way — solved from a position-only goal." },
  scavenger: { name: "Scavenger", kind: "grid", blurb: "Blocks lie scattered — no depots. Take only the top of a stack, and only if high enough; the planner builds a step to harvest a pillar." },
  scavengerBig: { name: "Scavenger XL", kind: "grid", blurb: "A bigger 4×3 grid, a height-3 goal, seven scattered blocks. The planner harvests a pillar and stacks a 3-level structure." },
  scavengerHuge: { name: "Scavenger HUGE (~9s)", kind: "grid", blurb: "A 6×4 grid (24 cells) — a deliberate stress test (~9s to plan). Search is hard-capped so it can't run away." },
  blocks: { name: "Blocks World (Sussman)", kind: "blocks", blurb: "The classic Sussman anomaly: goal A-on-B-on-C. The naive order deadlocks, so the planner interleaves subgoals." },
};

type SquadOrder = "engage" | "regroup" | "holdFire";

function buildRun(id: ScenarioId, squadOrder: { at: number; order: SquadOrder } | null): Run {
  const kind = SCENARIOS[id].kind;
  if (kind === "blocks") return { kind: "blocks", data: runBlocks() };
  if (kind === "squad") return { kind: "squad", data: runSquad(id as SquadScenarioId, id === "companion" && squadOrder ? { allyCommand: { ...squadOrder, unit: "ally" } } : {}) };
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
      if (r.kind === "squad") setSelected((s) => s ?? r.data.units[0] ?? null);
    }, 30);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario, squadOrder]);

  const frameCount = run ? run.data.frames.length : 0;
  const lastStep = Math.max(frameCount - 1, 0);

  useEffect(() => {
    if (!playing || !run) return;
    if (step >= lastStep) { setPlaying(false); return; }
    const id = setTimeout(() => setStep((s) => s + 1), speed);
    return () => clearTimeout(id);
  }, [playing, step, run, speed, lastStep]);

  const trace = run ? (run.kind === "squad" ? run.data.trace.map((t) => t.e) : run.data.trace) : [];
  const summary = useMemo(() => (run?.kind === "squad" ? squadTraceSummary(run.data.trace) : traceSummary(trace)), [run, trace]);
  const interesting = useMemo(() => summary.filter((s) => /repair|replan|fail|scope|drift/.test(s.label)), [summary]);

  const squadFrame = run?.kind === "squad" ? run.data.frames[Math.min(step, lastStep)] : null;
  const banner = squadFrame ? squadTacticBanner(squadFrame) : null;
  const narration = squadFrame ? squadNarration(squadFrame) : "";
  const watch = run?.kind === "squad" ? whatToWatch(scenario as SquadScenarioId) : [];
  const status = run?.kind === "grid" ? run.data.status : run?.kind === "squad" ? squadOutcome(run.data, step) : "—";

  const issueOrder = (order: SquadOrder) => setSquadOrder({ at: Math.max(1, step), order });

  return (
    <div className="app">
      <div className="stage">
        <div className="title">
          <h1>htn-ai · {SCENARIOS[scenario].name}</h1>
          <p>{SCENARIOS[scenario].blurb}</p>
        </div>

        {run?.kind === "grid" && <StaircaseScene key="grid" frame={run.data.frames[step]} instance={run.data.instance} target={run.data.target} reached={step === lastStep && status === "succeeded"} />}
        {run?.kind === "blocks" && <BlocksScene key="blocks" frame={run.data.frames[step]} blocks={run.data.blocks} reached={step === lastStep} />}
        {run?.kind === "squad" && <SquadScene key="squad" frame={run.data.frames[Math.min(step, lastStep)]} instance={run.data.instance} selected={selected} onSelect={(n) => setSelected(n || null)} />}

        {banner && (
          <div className="hud-top">
            <span className="banner-tag">SQUAD&nbsp;TACTIC</span>
            <span className={`banner-val tactic-${banner.label.toLowerCase()}`}>{banner.label}</span>
            <span className="banner-hint">{banner.hint}</span>
          </div>
        )}
        {run?.kind === "squad" && (
          <div className="hud-legend mono">
            <span><i className="dot" style={{ background: "#ef4444" }} />enemy</span>
            <span><i className="dot" style={{ background: "#34d399" }} />ally</span>
            <span><i className="dot" style={{ background: "#38bdf8" }} />you</span>
            <span><i className="dash" style={{ background: "#34d399" }} />line of fire</span>
            <span><i className="dash" style={{ background: "#ef4444" }} />blocked</span>
          </div>
        )}
        {narration && <div className="hud-narration">{narration}</div>}

        {computing && (
          <div className="overlay">
            <div style={{ fontSize: 16, color: "var(--text)" }}>⏳ Planning…</div>
            {SCENARIOS[scenario].kind === "grid" && scenarioHeavyMs(scenario as GridId) > 0 && <div style={{ fontSize: 12 }}>heavy stress scenario — searching (~{Math.round(scenarioHeavyMs(scenario as GridId) / 1000)}s)</div>}
          </div>
        )}
      </div>

      <aside className="panel">
        <div className="card">
          <h2>Scenario</h2>
          <div className="row spread">
            <select value={scenario} onChange={(e) => { setScenario(e.target.value as ScenarioId); setSquadOrder(null); setSelected(null); }}>
              <optgroup label="Squad combat (game AI)">
                {(Object.keys(SCENARIOS) as ScenarioId[]).filter((id) => SCENARIOS[id].kind === "squad").map((id) => <option key={id} value={id}>{SCENARIOS[id].name}</option>)}
              </optgroup>
              <optgroup label="Spatial planning">
                {(Object.keys(SCENARIOS) as ScenarioId[]).filter((id) => SCENARIOS[id].kind !== "squad").map((id) => <option key={id} value={id}>{SCENARIOS[id].name}</option>)}
              </optgroup>
            </select>
            <span className={`pill ${/down|succeeded/.test(status) ? "good" : status === "failed" ? "bad" : "busy"}`}>{status}</span>
          </div>
        </div>

        {watch.length > 0 && (
          <div className="card watch">
            <h2>What to watch for</h2>
            <ol>
              {watch.map((w, i) => <li key={i}>{w}</li>)}
            </ol>
          </div>
        )}

        <div className="card">
          <h2>Playback {run?.kind === "squad" ? "· deterministic replay" : ""}</h2>
          <div className="row">
            <button className="primary" onClick={() => setPlaying((p) => !p)} disabled={!run}>{playing ? "⏸ Pause" : "▶ Play"}</button>
            <button onClick={() => setStep((s) => Math.min(s + 1, lastStep))} disabled={!run || step >= lastStep}>Step ⟩</button>
            <button onClick={() => { setStep(0); setPlaying(true); }} disabled={!run}>⟲ Reset</button>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className="mono" style={{ color: "var(--muted)" }}>t</span>
            <input type="range" min={0} max={lastStep} step={1} value={Math.min(step, lastStep)} onChange={(e) => { setPlaying(false); setStep(Number(e.target.value)); }} style={{ flex: 1 }} />
            <span className="mono">{step}/{lastStep}</span>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <span className="mono" style={{ color: "var(--muted)" }}>speed</span>
            <input type="range" min={120} max={1400} step={20} value={1520 - speed} onChange={(e) => setSpeed(1520 - Number(e.target.value))} style={{ flex: 1 }} />
          </div>
        </div>

        {scenario === "companion" && (
          <div className="card">
            <h2>Player orders → ally</h2>
            <div className="mono" style={{ color: "var(--muted)", marginBottom: 8 }}>routed through <span style={{ color: "var(--accent-2)" }}>Planner.setGoals</span> — the LLM seam. Issued at the scrubbed moment, then replayed.</div>
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              <button onClick={() => issueOrder("engage")} className={squadOrder?.order === "engage" ? "primary" : ""}>⚔ Engage</button>
              <button onClick={() => issueOrder("regroup")} className={squadOrder?.order === "regroup" ? "primary" : ""}>⮌ Regroup</button>
              <button onClick={() => issueOrder("holdFire")} className={squadOrder?.order === "holdFire" ? "primary" : ""}>✋ Hold fire</button>
              {squadOrder && <button onClick={() => setSquadOrder(null)}>clear</button>}
            </div>
          </div>
        )}

        {run?.kind === "squad" && <SquadDirector frame={run.data.frames[Math.min(step, lastStep)]} units={run.data.units} selected={selected} onSelect={(n) => setSelected(n || null)} />}

        {run?.kind === "grid" && (
          <div className="card">
            <h2>Goal</h2>
            <div className="mono">be at 3D position <span style={{ color: "var(--accent-2)" }}>({run.data.target.x}, {run.data.target.y}, {run.data.target.z})</span></div>
          </div>
        )}

        <div className="card">
          <h2>Trace events {run?.kind === "squad" ? "· glass-box" : ""}</h2>
          <div className="legend" style={{ marginBottom: 8 }}>{summary.map((s) => <span key={s.label} className="mono">{s.label}:{s.count}</span>)}</div>
          {interesting.length > 0 ? (
            <div className="mono" style={{ color: "var(--accent-2)" }}>reactive: {interesting.map((s) => `${s.label}×${s.count}`).join(", ")}</div>
          ) : (
            <div className="mono" style={{ color: "var(--muted)" }}>clean run so far</div>
          )}
        </div>
      </aside>
    </div>
  );
}

function squadOutcome(run: SquadRun, step: number): string {
  const f = run.frames[Math.min(step, run.frames.length - 1)];
  if (!f) return "—";
  if (f.units.filter((u) => u.side === "enemy").every((u) => !u.alive)) return "enemies down";
  if (f.units.filter((u) => u.side !== "enemy").every((u) => !u.alive)) return "target down";
  return "engaging";
}
