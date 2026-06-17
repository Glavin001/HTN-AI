"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  bunkerPhase,
  describeAction,
  runBunker,
  traceSummaryFor,
  type BunkerGoalId,
  type BunkerRun,
} from "../../lib/runBunker";

const BunkerScene = dynamic(() => import("../../components/BunkerScene"), { ssr: false });

const GOALS: { id: BunkerGoalId; name: string; blurb: string }[] = [
  { id: "star", name: "Steal the star", blurb: "hasStar — the full mission. The star is sealed inside the bunker, so the planner must work all the way back to the key." },
  { id: "breach", name: "Breach the bunker", blurb: "bunkerBreached — stop one step short of the star: fetch the key, get the C4, plant it, fall back, detonate." },
  { id: "c4", name: "Grab the C4", blurb: "hasC4 — the shortest gated chain: the C4 is locked in storage, so you still need the key first." },
];

const CHECKLIST: { key: keyof BunkerRun["frames"][number]["flags"]; label: string; want: boolean }[] = [
  { key: "hasKey", label: "key acquired", want: true },
  { key: "storageUnlocked", label: "storage unlocked", want: true },
  { key: "hasC4", label: "C4 in hand", want: true },
  { key: "c4Placed", label: "C4 planted", want: true },
  { key: "bunkerBreached", label: "bunker breached", want: true },
  { key: "hasStar", label: "★ star collected", want: true },
];

export default function BunkerPage() {
  const [goalId, setGoalId] = useState<BunkerGoalId>("star");
  const [run, setRun] = useState<BunkerRun | null>(null);
  const [computing, setComputing] = useState(true);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(620);

  useEffect(() => {
    setComputing(true);
    setRun(null);
    setStep(0);
    const id = setTimeout(() => {
      setRun(runBunker(goalId));
      setComputing(false);
      setPlaying(true);
    }, 30);
    return () => clearTimeout(id);
  }, [goalId]);

  const frameCount = run ? run.frames.length : 0;
  const lastStep = Math.max(frameCount - 1, 0);

  useEffect(() => {
    if (!playing || !run) return;
    if (step >= lastStep) { setPlaying(false); return; }
    const id = setTimeout(() => setStep((s) => s + 1), speed);
    return () => clearTimeout(id);
  }, [playing, step, run, speed, lastStep]);

  const frame = run ? run.frames[Math.min(step, lastStep)] : null;
  const summary = useMemo(() => (run ? traceSummaryFor(run.trace) : []), [run]);
  const reached = !!run && step === lastStep && run.status === "succeeded";
  const phase = frame ? bunkerPhase(frame.action, frame.flags) : null;
  // which discovered action is "current": frame[step] was produced by plan[step-1]
  const planCursor = step - 1;

  return (
    <div className="app">
      <div className="stage">
        <div className="title">
          <h1>htn-ai · Bunker Heist</h1>
          <p>
            The goal is one declarative fact — <b style={{ color: "var(--accent-2)" }}>{run?.goalText ?? "hasStar"}</b>. The domain has only primitive
            actions (goto · pickup_key · unlock_storage · pickup_c4 · place_c4 · detonate · pickup_star) and two real gates: a locked storage door and a
            sealed bunker. Nothing says <i>how</i> — the planner <b style={{ color: "var(--accent)" }}>discovers</b> the whole key → C4 → breach → star
            chain by search, walking the route one edge at a time.
          </p>
        </div>

        {frame && <BunkerScene key={goalId} frame={frame} reached={reached} />}

        {phase && (
          <div className="hud-narration">
            <span style={{ color: phase.color }}>{phase.icon} {phase.text}</span>
          </div>
        )}

        {computing && (
          <div className="overlay">
            <div style={{ fontSize: 16, color: "var(--text)" }}>⏳ Planning…</div>
            <div style={{ fontSize: 12 }}>searching over the actions from just the goal</div>
          </div>
        )}
      </div>

      <aside className="panel">
        <div className="card">
          <h2>Mission</h2>
          <div className="row spread">
            <select value={goalId} onChange={(e) => setGoalId(e.target.value as BunkerGoalId)}>
              {GOALS.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <span className={`pill ${run?.status === "succeeded" ? "good" : run?.status === "failed" ? "bad" : "busy"}`}>{run?.status ?? "…"}</span>
          </div>
          <div className="mono" style={{ color: "var(--muted)", marginTop: 8, fontSize: 11, lineHeight: 1.6 }}>
            {GOALS.find((g) => g.id === goalId)?.blurb}
          </div>
        </div>

        <div className="card">
          <h2>Playback · deterministic replay</h2>
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
            <input type="range" min={150} max={1200} step={20} value={1350 - speed} onChange={(e) => setSpeed(1350 - Number(e.target.value))} style={{ flex: 1 }} />
          </div>
        </div>

        {frame && (
          <div className="card watch">
            <h2>Mission progress</h2>
            <ol style={{ marginTop: 4 }}>
              {CHECKLIST.map((c) => {
                const done = frame.flags[c.key] === c.want;
                return (
                  <li key={c.key} style={{ color: done ? "#34d399" : "var(--muted)" }}>
                    {done ? "✓" : "○"} {c.label}
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {run && (
          <div className="card">
            <h2>Discovered plan · {run.plan.length} actions</h2>
            <div className="mono" style={{ color: "var(--muted)", fontSize: 11, marginBottom: 8 }}>
              found by search over the operators — not authored. Optimal route, gates respected.
            </div>
            <ol className="mono" style={{ fontSize: 11, lineHeight: 1.7, maxHeight: 240, overflowY: "auto", paddingLeft: 20 }}>
              {run.plan.map((label, i) => {
                const active = i === planCursor;
                const done = i < planCursor;
                return (
                  <li key={i} style={{ color: active ? "var(--accent)" : done ? "#34d399" : "var(--muted)", fontWeight: active ? 700 : 400 }}>
                    {describeAction(label)}
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        <div className="card">
          <h2>How the planner solves it</h2>
          <div className="mono" style={{ fontSize: 11, lineHeight: 1.7 }}>
            <div><span style={{ color: "var(--muted)" }}>goal (declarative):</span> <span style={{ color: "var(--accent-2)" }}>{run?.goalText ?? "hasStar"}</span></div>
            <div><span style={{ color: "var(--muted)" }}>domain ops:</span> <span style={{ color: "var(--accent)" }}>goto · pickup · unlock · place · detonate</span></div>
            <div style={{ marginTop: 4 }}>the star is behind a <b style={{ color: "var(--accent-2)" }}>breach</b> ← needs <b>C4 placed</b> + <b>detonation</b> ← needs <b>C4</b> ← behind a <b style={{ color: "var(--accent-2)" }}>locked door</b> ← needs the <b>key</b>. The planner derives that backward chain itself from the preconditions.</div>
          </div>
        </div>

        <div className="card">
          <h2>Trace events</h2>
          <div className="legend">{summary.map((s) => <span key={s.label} className="mono">{s.label}:{s.count}</span>)}</div>
        </div>

        <div className="card">
          <Link href="/" className="mono" style={{ color: "var(--accent)" }}>← all htn-ai scenarios</Link>
        </div>
      </aside>
    </div>
  );
}
