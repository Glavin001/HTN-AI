"use client";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { runScenario, traceSummary, type RunResult } from "../lib/run";
import { runBlocks, type BlocksRun } from "../lib/runBlocks";

const StaircaseScene = dynamic(() => import("../components/StaircaseScene"), { ssr: false });
const BlocksScene = dynamic(() => import("../components/BlocksScene"), { ssr: false });

type ScenarioId = "staircase" | "ledge" | "quarry" | "blocks";

type Run = { kind: "grid"; data: RunResult } | { kind: "blocks"; data: BlocksRun };

const SCENARIOS: Record<ScenarioId, { name: string; blurb: string }> = {
  staircase: {
    name: "Staircase",
    blurb:
      "Goal: stand at a coordinate up in the air. The only way to gain height is to stack boxes — so the planner discovers it must carry blocks from the depot, build a staircase, and climb it.",
  },
  ledge: {
    name: "Climb the ledge",
    blurb:
      "A 2-high wall the agent can't climb directly (you ascend one level at a time). The planner figures out it must build a single step, then walk up and over.",
  },
  quarry: {
    name: "Quarry (advanced)",
    blurb:
      "A grid world: reach the top of a height-4 pillar. Blocks are scattered across two depots and a wall blocks the way. The planner finds the optimal route to collect from both depots and build a 3-step staircase (1→2→3) to climb up — all from a position-only goal.",
  },
  blocks: {
    name: "Blocks World (Sussman)",
    blurb:
      "The classic Sussman anomaly: C on A, A and B on the table; goal A-on-B-on-C. The naive order deadlocks, so the planner must interleave subgoals — unstack C first, then build the tower.",
  },
};

function buildRun(id: ScenarioId): Run {
  if (id === "blocks") return { kind: "blocks", data: runBlocks() };
  return { kind: "grid", data: runScenario(id) };
}

export default function Page() {
  const [scenario, setScenario] = useState<ScenarioId>("staircase");
  const [run, setRun] = useState<Run | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(750);

  useEffect(() => {
    setRun(buildRun(scenario));
    setStep(0);
    setPlaying(true);
  }, [scenario]);

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

  const status = run?.data.status ?? "…";
  const trace = run?.data.trace ?? [];
  const summary = useMemo(() => traceSummary(trace), [trace]);
  const interesting = useMemo(() => summary.filter((s) => /repair|replan|fail|scope|drift/.test(s.label)), [summary]);
  const reached = run != null && step === lastStep && status === "succeeded";

  return (
    <div className="app">
      <div className="stage">
        <div className="title">
          <h1>htn-ai · {SCENARIOS[scenario].name}</h1>
          <p>{SCENARIOS[scenario].blurb}</p>
        </div>
        {run?.kind === "grid" && (
          <StaircaseScene
            key="grid"
            frame={run.data.frames[step]}
            instance={run.data.instance}
            target={run.data.target}
            reached={reached}
          />
        )}
        {run?.kind === "blocks" && (
          <BlocksScene key="blocks" frame={run.data.frames[step]} blocks={run.data.blocks} reached={reached} />
        )}
      </div>

      <aside className="panel">
        <div className="card">
          <h2>Scenario</h2>
          <div className="row spread">
            <select value={scenario} onChange={(e) => setScenario(e.target.value as ScenarioId)}>
              {(Object.keys(SCENARIOS) as ScenarioId[]).map((id) => (
                <option key={id} value={id}>
                  {SCENARIOS[id].name}
                </option>
              ))}
            </select>
            <StatusPill status={status} />
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
            <span className="mono" style={{ color: "var(--muted)" }}>
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
          <h2>Goal</h2>
          {run?.kind === "grid" && (
            <div className="mono">
              be at 3D position&nbsp;
              <span style={{ color: "var(--accent-2)" }}>
                ({run.data.target.x}, {run.data.target.y}, {run.data.target.z})
              </span>
              <div style={{ color: "var(--muted)", marginTop: 4 }}>x, y(up), z — y &gt; 0 means in the air</div>
            </div>
          )}
          {run?.kind === "blocks" && (
            <div className="mono">
              <span style={{ color: "var(--accent-2)" }}>on(A,B) ∧ on(B,C)</span>
              <div style={{ color: "var(--muted)", marginTop: 4 }}>a tower: {run.data.goalText}</div>
            </div>
          )}
        </div>

        <div className="card">
          <h2>World state</h2>
          {run?.kind === "grid" && <GridState run={run.data} step={step} />}
          {run?.kind === "blocks" && <BlocksState run={run.data} step={step} />}
        </div>

        <div className="card">
          <h2>Plan · discovered by search</h2>
          <div className="steps">
            {run?.data.frames.slice(1).map((f, i) => {
              const idx = i + 1;
              const cls = idx === step ? "active" : idx < step ? "done" : "";
              return (
                <div className={`step ${cls}`} key={idx}>
                  <span className="idx">{idx}</span>
                  <span>{f.action}</span>
                </div>
              );
            })}
            {run && frameCount <= 1 && <div className="step">no actions</div>}
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
      </aside>
    </div>
  );
}

function GridState({ run, step }: { run: RunResult; step: number }) {
  const frame = run.frames[step];
  if (!frame) return null;
  return (
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
      {run.instance.cells.map((c) => (
        <div className="kv" key={c.name}>
          <span className="k">{c.name}</span>
          <span className="mono">
            height {frame.heights[c.name] ?? 0}
            {(frame.supplies[c.name] ?? 0) > 0 ? `  ·  supply ${frame.supplies[c.name]}` : ""}
          </span>
        </div>
      ))}
    </>
  );
}

function BlocksState({ run, step }: { run: BlocksRun; step: number }) {
  const frame = run.frames[step];
  if (!frame) return null;
  return (
    <>
      <div className="kv">
        <span className="k">gripper</span>
        <span className={`pill ${frame.held ? "busy" : ""}`}>
          {frame.held ? `holding ${frame.held.toUpperCase()}` : "empty"}
        </span>
      </div>
      {run.blocks.map((b) => (
        <div className="kv" key={b}>
          <span className="k">{b.toUpperCase()}</span>
          <span className="mono">
            {frame.held === b ? "in gripper" : `on ${frame.on[b] === "table" ? "table" : frame.on[b].toUpperCase()}`}
          </span>
        </div>
      ))}
    </>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls = status === "succeeded" ? "good" : status === "failed" ? "bad" : "busy";
  return <span className={`pill ${cls}`}>{status}</span>;
}
