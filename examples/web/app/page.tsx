"use client";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { runScenario, traceSummary, type RunResult, type ScenarioId } from "../lib/run";

const StaircaseScene = dynamic(() => import("../components/StaircaseScene"), { ssr: false });

const SCENARIO_LABELS: Record<ScenarioId, { name: string; blurb: string }> = {
  staircase: {
    name: "Staircase",
    blurb:
      "Goal: stand at a coordinate up in the air. The only way to gain height is to stack boxes — so the planner discovers it must carry blocks from the depot and build a staircase, then climb it.",
  },
  ledge: {
    name: "Climb the ledge",
    blurb:
      "A 2-high wall the agent can't climb directly (you ascend one level at a time). The planner figures out it must build a single step, then walk up and over.",
  },
};

export default function Page() {
  const [scenario, setScenario] = useState<ScenarioId>("staircase");
  const [run, setRun] = useState<RunResult | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(750);

  useEffect(() => {
    const r = runScenario(scenario);
    setRun(r);
    setStep(0);
    setPlaying(true);
  }, [scenario]);

  useEffect(() => {
    if (!playing || !run) return;
    if (step >= run.frames.length - 1) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(() => setStep((s) => s + 1), speed);
    return () => clearTimeout(id);
  }, [playing, step, run, speed]);

  const frame = run?.frames[step] ?? null;
  const lastStep = run ? run.frames.length - 1 : 0;
  const reached = run != null && step === lastStep && run.status === "succeeded";
  const summary = useMemo(() => (run ? traceSummary(run.trace) : []), [run]);
  const interesting = useMemo(
    () => summary.filter((s) => /repair|replan|fail|scope|drift/.test(s.label)),
    [summary],
  );

  return (
    <div className="app">
      <div className="stage">
        <div className="title">
          <h1>htn-ai · Staircase World</h1>
          <p>{SCENARIO_LABELS[scenario].blurb}</p>
        </div>
        {run && frame && (
          <StaircaseScene frame={frame} instance={run.instance} target={run.target} reached={reached} />
        )}
      </div>

      <aside className="panel">
        <div className="card">
          <h2>Scenario</h2>
          <div className="row spread">
            <select value={scenario} onChange={(e) => setScenario(e.target.value as ScenarioId)}>
              {(Object.keys(SCENARIO_LABELS) as ScenarioId[]).map((id) => (
                <option key={id} value={id}>
                  {SCENARIO_LABELS[id].name}
                </option>
              ))}
            </select>
            <StatusPill status={run?.status ?? "…"} />
          </div>
        </div>

        <div className="card">
          <h2>Playback</h2>
          <div className="row">
            <button className="primary" onClick={() => setPlaying((p) => !p)} disabled={!run}>
              {playing ? "⏸ Pause" : "▶ Play"}
            </button>
            <button onClick={() => setStep((s) => Math.min(s + 1, lastStep))} disabled={!run || step >= lastStep}>
              Step ⟩
            </button>
            <button
              onClick={() => {
                setStep(0);
                setPlaying(true);
              }}
              disabled={!run}
            >
              ⟲ Reset
            </button>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className="k mono" style={{ color: "var(--muted)" }}>
              speed
            </span>
            <input
              type="range"
              min={120}
              max={1400}
              step={20}
              value={1520 - speed}
              onChange={(e) => setSpeed(1520 - Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span className="mono">
              {step}/{lastStep}
            </span>
          </div>
        </div>

        <div className="card">
          <h2>Goal · 3D position</h2>
          {run && (
            <div className="mono">
              reach&nbsp;
              <span style={{ color: "var(--accent-2)" }}>
                ({run.target.x}, {run.target.y}, {run.target.z})
              </span>
              <div style={{ color: "var(--muted)", marginTop: 4 }}>x, y(up), z — y &gt; 0 means in the air</div>
            </div>
          )}
        </div>

        <div className="card">
          <h2>World state</h2>
          {frame && (
            <>
              <div className="kv">
                <span className="k">agent at</span>
                <span className="mono">
                  {frame.agentCell} · y={frame.agentY}
                </span>
              </div>
              <div className="kv">
                <span className="k">holding block</span>
                <span className={`pill ${frame.holding ? "busy" : ""}`}>{frame.holding ? "yes" : "no"}</span>
              </div>
              {run!.instance.cells.map((c) => (
                <div className="kv" key={c.name}>
                  <span className="k">{c.name}</span>
                  <span className="mono">
                    height {frame.heights[c.name] ?? 0}
                    {(frame.supplies[c.name] ?? 0) > 0 ? `  ·  supply ${frame.supplies[c.name]}` : ""}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="card">
          <h2>Plan · discovered by search</h2>
          <div className="steps">
            {run?.frames.slice(1).map((f, i) => {
              const idx = i + 1;
              const cls = idx === step ? "active" : idx < step ? "done" : "";
              return (
                <div className={`step ${cls}`} key={idx}>
                  <span className="idx">{idx}</span>
                  <span>{f.action}</span>
                </div>
              );
            })}
            {run && run.frames.length <= 1 && <div className="step">no actions</div>}
          </div>
        </div>

        <div className="card">
          <h2>Trace events</h2>
          <div className="legend" style={{ marginBottom: 8 }}>
            {summary.map((s) => (
              <span key={s.label} className="mono">
                {s.label}:{s.count}
              </span>
            ))}
          </div>
          {interesting.length > 0 ? (
            <div className="mono" style={{ color: "var(--accent-2)" }}>
              reactive events: {interesting.map((s) => `${s.label}×${s.count}`).join(", ")}
            </div>
          ) : (
            <div className="mono" style={{ color: "var(--muted)" }}>
              clean run — no repair/replan needed
            </div>
          )}
        </div>

        <div className="card">
          <h2>Legend</h2>
          <div className="legend">
            <span>
              <span className="swatch" style={{ background: "#38bdf8" }} />
              agent
            </span>
            <span>
              <span className="swatch" style={{ background: "#f59e0b" }} />
              block / supply
            </span>
            <span>
              <span className="swatch" style={{ background: "#3f7cc4" }} />
              placed block
            </span>
            <span>
              <span className="swatch" style={{ background: "#fbbf24" }} />
              target coord
            </span>
          </div>
        </div>
      </aside>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls = status === "succeeded" ? "good" : status === "failed" ? "bad" : "busy";
  return <span className={`pill ${cls}`}>{status}</span>;
}
