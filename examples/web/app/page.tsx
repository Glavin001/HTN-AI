"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { runScenario, scenarioHeavyMs, traceSummary, type RunResult } from "../lib/run";
import { runBlocks, type BlocksRun } from "../lib/runBlocks";
import { runWall, type WallRun } from "../lib/runWall";
import {
  runSquad,
  squadNarration,
  squadTraceSummary,
  teamColor,
  teamHint,
  teamName,
  whatToWatch,
  type SquadRun,
  type SquadScenarioId,
} from "../lib/runSquad";
import { useLiveSquad, type Order } from "../lib/useLiveSquad";
import type { SquadFrame, SquadInstance } from "@scenarios/squad-combat";
import type { TraceEvent } from "htn-ai";

const StaircaseScene = dynamic(() => import("../components/StaircaseScene"), { ssr: false });
const BlocksScene = dynamic(() => import("../components/BlocksScene"), { ssr: false });
const WallScene = dynamic(() => import("../components/WallScene"), { ssr: false });
const SquadScene = dynamic(() => import("../components/SquadScene"), { ssr: false });
import SquadDirector from "../components/SquadDirector";

type GridId = "staircase" | "ledge" | "quarry" | "scavenger" | "scavengerBig" | "scavengerHuge";
type ScenarioId = GridId | "blocks" | "wall" | SquadScenarioId;
type Kind = "grid" | "blocks" | "wall" | "squad";

type Run =
  | { kind: "grid"; data: RunResult }
  | { kind: "blocks"; data: BlocksRun }
  | { kind: "wall"; data: WallRun }
  | { kind: "squad"; data: SquadRun };

const SCENARIOS: Record<ScenarioId, { name: string; blurb: string; kind: Kind }> = {
  skirmish: { name: "★ Skirmish: Red vs Blue", kind: "squad", blurb: "Two AI squads fight autonomously. Each unit plans from its OWN belief (no shared memory across teams) and reactively readjusts as it discovers the other's moves." },
  blockedFlank: { name: "★ Emergent flank: Red vs Blue", kind: "squad", blurb: "A barricade blocks every direct shot. No flank is scripted — each squad DISCOVERS it must reach a cover that can see the enemy, and they contest the same flanks." },
  breach: { name: "★ Timed breach: Red vs Blue", kind: "squad", blurb: "A Red fire-team breaches a door a Blue team holds — stacking and breaching in sync inside a deadline window enforced inside the planner's search." },
  companion: { name: "★ Command your squad (LIVE)", kind: "squad", blurb: "A LIVE battle: your Blue squad fights Red autonomously. Issue an order to a unit and watch it replan in real time — the order hits the running planner, it isn't a re-baked recording." },
  staircase: { name: "Staircase", kind: "grid", blurb: "Goal: stand at a coordinate in the air. The only way up is to stack boxes — so the planner discovers it must build a staircase and climb it." },
  ledge: { name: "Climb the ledge", kind: "grid", blurb: "A 2-high wall the agent can't climb directly. The planner builds a single step, then walks up and over." },
  quarry: { name: "Quarry (advanced)", kind: "grid", blurb: "Reach a height-4 pillar. Blocks are scattered across two depots and a wall blocks the way — solved from a position-only goal." },
  scavenger: { name: "Scavenger", kind: "grid", blurb: "Blocks lie scattered — no depots. Take only the top of a stack, and only if high enough; the planner builds a step to harvest a pillar." },
  scavengerBig: { name: "Scavenger XL", kind: "grid", blurb: "A bigger 4×3 grid, a height-3 goal, seven scattered blocks. The planner harvests a pillar and stacks a 3-level structure." },
  scavengerHuge: { name: "Scavenger HUGE (~9s)", kind: "grid", blurb: "A 6×4 grid (24 cells) — a deliberate stress test (~9s to plan). Search is hard-capped so it can't run away." },
  blocks: { name: "Blocks World (Sussman)", kind: "blocks", blurb: "The classic Sussman anomaly: goal A-on-B-on-C. The naive order deadlocks, so the planner interleaves subgoals." },
  wall: { name: "Build a wall (structure goal)", kind: "wall", blurb: "The goal isn't a position to stand at — and it isn't a recipe either. It's one DECLARATIVE end-state: 'every cell of this octagonal ring ends up two blocks tall.' The domain has only goto / grab / place; nothing tells the agent to pick up or place anything. The planner DISCOVERS pickup-and-place by search. A single search over all 12 cells blows up, so the planner runs in goal-agenda mode: it splits the conjunction into per-cell subgoals and commits to them one at a time. Blocks come only from the scattered pile, so a laid block is never cannibalised — which is what makes serialising sound." },
};

function buildRun(id: ScenarioId): Run {
  const kind = SCENARIOS[id].kind;
  if (kind === "blocks") return { kind: "blocks", data: runBlocks() };
  if (kind === "wall") return { kind: "wall", data: runWall() };
  if (kind === "squad") return { kind: "squad", data: runSquad(id as SquadScenarioId) };
  return { kind: "grid", data: runScenario(id as GridId) };
}

interface SquadView {
  frame: SquadFrame;
  trace: { unit: string; e: TraceEvent }[];
  units: string[];
  instance: SquadInstance;
}

export default function Page() {
  const [scenario, setScenario] = useState<ScenarioId>("skirmish");
  const [run, setRun] = useState<Run | null>(null);
  const [computing, setComputing] = useState(true);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(450);
  const [liveStepMs, setLiveStepMs] = useState(90);
  const [selected, setSelected] = useState<string | null>(null);

  const isLive = scenario === "companion";
  const live = useLiveSquad(isLive ? "companion" : null, liveStepMs);

  // build the deterministic replay for everything EXCEPT the live companion battle
  useEffect(() => {
    if (isLive) { setRun(null); setComputing(false); return; }
    setComputing(true);
    setRun(null);
    setStep(0);
    const id = setTimeout(() => {
      const r = buildRun(scenario);
      setRun(r);
      setComputing(false);
      setPlaying(true);
      if (r.kind === "squad") setSelected((s) => s ?? r.data.units[0] ?? null);
    }, 30);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario]);

  const frameCount = run ? run.data.frames.length : 0;
  const lastStep = Math.max(frameCount - 1, 0);

  useEffect(() => {
    if (isLive || !playing || !run) return;
    if (step >= lastStep) { setPlaying(false); return; }
    const id = setTimeout(() => setStep((s) => s + 1), speed);
    return () => clearTimeout(id);
  }, [playing, step, run, speed, lastStep, isLive]);

  useEffect(() => {
    if (isLive && live.units.length && !selected) setSelected(live.units[0]);
  }, [isLive, live.units, selected]);

  // unified squad view (live OR replay)
  const squad: SquadView | null = isLive
    ? live.frame && live.instance
      ? { frame: live.frame, trace: live.trace, units: live.units, instance: live.instance }
      : null
    : run?.kind === "squad"
      ? { frame: run.data.frames[Math.min(step, lastStep)], trace: run.data.trace, units: run.data.units, instance: run.data.instance }
      : null;

  const trace = squad ? squad.trace.map((t) => t.e) : run && run.kind !== "squad" ? run.data.trace : [];
  const summary = useMemo(() => (squad ? squadTraceSummary(squad.trace) : traceSummary(trace)), [squad, trace]);
  const interesting = useMemo(() => summary.filter((s) => /repair|replan|fail|scope|drift/.test(s.label)), [summary]);

  const narration = squad ? squadNarration(squad.frame) : "";
  const watch = SCENARIOS[scenario].kind === "squad" ? whatToWatch(scenario as SquadScenarioId) : [];
  const status = run?.kind === "grid" || run?.kind === "wall" ? run.data.status : squad ? outcome(squad.frame) : "—";

  return (
    <div className="app">
      <div className="stage">
        <div className="title">
          <h1>htn-ai · {SCENARIOS[scenario].name}</h1>
          <p>
            {SCENARIOS[scenario].blurb}{" "}
            <Link href="/director" style={{ color: "var(--accent)", whiteSpace: "nowrap" }}>NEW: Director feed demo →</Link>
          </p>
        </div>

        {run?.kind === "grid" && <StaircaseScene key="grid" frame={run.data.frames[step]} instance={run.data.instance} target={run.data.target} reached={step === lastStep && status === "succeeded"} />}
        {run?.kind === "blocks" && <BlocksScene key="blocks" frame={run.data.frames[step]} blocks={run.data.blocks} reached={step === lastStep} />}
        {run?.kind === "wall" && <WallScene key="wall" frame={run.data.frames[step]} cells={run.data.cells} targets={run.data.targets} sources={run.data.sources} core={run.data.core} wantHeight={run.data.wantHeight} reached={step === lastStep && status === "succeeded"} />}
        {squad && <SquadScene key="squad" frame={squad.frame} instance={squad.instance} selected={selected} onSelect={(n) => setSelected(n || null)} />}

        {squad && (
          <div className="hud-top">
            {squad.frame.teams.map((t) => (
              <span key={t.side} className="team-chip">
                <i className="dot" style={{ background: teamColor(t.side) }} />
                <b style={{ color: teamColor(t.side) }}>{teamName(t.side)}</b>
                <span className="mono">{t.alive}/{t.total}</span>
                <span className="team-hint">· {teamHint(t)}</span>
              </span>
            ))}
          </div>
        )}
        {squad && (
          <div className="hud-legend mono">
            <span><i className="dot" style={{ background: "#ef4444" }} />Red team</span>
            <span><i className="dot" style={{ background: "#3b82f6" }} />Blue team</span>
            <span><i className="dash" style={{ background: "#34d399" }} />line of fire</span>
            <span><i className="dash" style={{ background: "#ef4444" }} />blocked</span>
          </div>
        )}
        {narration && <div className="hud-narration">{narration}</div>}
        {isLive && live.lastOrder && <div className="hud-order">order → {live.lastOrder.unit}: <b>{live.lastOrder.order}</b> @ {live.lastOrder.at}s</div>}

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
            <select value={scenario} onChange={(e) => { setScenario(e.target.value as ScenarioId); setSelected(null); }}>
              <optgroup label="Squad combat (game AI)">
                {(Object.keys(SCENARIOS) as ScenarioId[]).filter((id) => SCENARIOS[id].kind === "squad").map((id) => <option key={id} value={id}>{SCENARIOS[id].name}</option>)}
              </optgroup>
              <optgroup label="Spatial planning">
                {(Object.keys(SCENARIOS) as ScenarioId[]).filter((id) => SCENARIOS[id].kind !== "squad").map((id) => <option key={id} value={id}>{SCENARIOS[id].name}</option>)}
              </optgroup>
            </select>
            <span className={`pill ${/eliminated|succeeded/.test(status) ? "good" : status === "failed" ? "bad" : "busy"}`}>{status}</span>
          </div>
        </div>

        {isLive && (
          <div className="card">
            <h2>Order a unit — live</h2>
            <div className="mono" style={{ color: "var(--muted)", marginBottom: 8 }}>
              hits the <span style={{ color: "var(--accent-2)" }}>running</span> planner via <span style={{ color: "var(--accent-2)" }}>setGoals</span> — watch the selected unit replan.
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {live.units.filter((u) => u.startsWith("B")).map((u) => (
                <span key={u} className="row" style={{ gap: 4 }}>
                  <span className="mono" style={{ color: "#3b82f6", fontWeight: 700 }}>{u}</span>
                  <button onClick={() => { setSelected(u); live.command(u, "engage" as Order); }}>⚔</button>
                  <button onClick={() => { setSelected(u); live.command(u, "regroup" as Order); }}>⮌</button>
                  <button onClick={() => { setSelected(u); live.command(u, "holdFire" as Order); }}>✋</button>
                </span>
              ))}
            </div>
            <div className="mono" style={{ color: "var(--muted)", marginTop: 6, fontSize: 11 }}>⚔ engage · ⮌ regroup · ✋ hold fire</div>
          </div>
        )}

        <div className="card">
          <h2>{isLive ? "Live battle" : "Playback · deterministic replay"}</h2>
          <div className="row">
            <button className="primary" onClick={() => (isLive ? live.setPlaying(!live.playing) : setPlaying((p) => !p))} disabled={!isLive && !run}>
              {(isLive ? live.playing : playing) ? "⏸ Pause" : "▶ Play"}
            </button>
            <button onClick={() => (isLive ? live.stepOnce() : setStep((s) => Math.min(s + 1, lastStep)))} disabled={isLive ? false : !run || step >= lastStep}>Step ⟩</button>
            <button onClick={() => (isLive ? live.reset() : (setStep(0), setPlaying(true)))} disabled={!isLive && !run}>⟲ {isLive ? "Restart" : "Reset"}</button>
          </div>
          {!isLive && (
            <div className="row" style={{ marginTop: 10 }}>
              <span className="mono" style={{ color: "var(--muted)" }}>t</span>
              <input type="range" min={0} max={lastStep} step={1} value={Math.min(step, lastStep)} onChange={(e) => { setPlaying(false); setStep(Number(e.target.value)); }} style={{ flex: 1 }} />
              <span className="mono">{step}/{lastStep}</span>
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <span className="mono" style={{ color: "var(--muted)" }}>speed</span>
            {isLive ? (
              <input type="range" min={40} max={260} step={10} value={300 - liveStepMs} onChange={(e) => setLiveStepMs(300 - Number(e.target.value))} style={{ flex: 1 }} />
            ) : (
              <input type="range" min={120} max={1400} step={20} value={1520 - speed} onChange={(e) => setSpeed(1520 - Number(e.target.value))} style={{ flex: 1 }} />
            )}
          </div>
        </div>

        {watch.length > 0 && (
          <div className="card watch">
            <h2>What to watch for</h2>
            <ol>{watch.map((w, i) => <li key={i}>{w}</li>)}</ol>
          </div>
        )}

        {squad && <SquadDirector frame={squad.frame} units={squad.units} selected={selected} onSelect={(n) => setSelected(n || null)} />}

        {run?.kind === "grid" && (
          <div className="card">
            <h2>Goal</h2>
            <div className="mono">be at 3D position <span style={{ color: "var(--accent-2)" }}>({run.data.target.x}, {run.data.target.y}, {run.data.target.z})</span></div>
          </div>
        )}

        {run?.kind === "wall" && (() => {
          const f = run.data.frames[Math.min(step, lastStep)];
          const want = run.data.wantHeight;
          const totalBlocks = run.data.targets.length * want;
          const blocksLaid = run.data.targets.reduce((n, c) => n + Math.min(f?.heights[c] ?? 0, want), 0);
          const activeSlot = Math.min((f?.placed ?? 0) + 1, run.data.targets.length);
          const phase = wallPhase(f?.action ?? "start", f?.holding ?? false);
          return (
            <>
              <div className="card watch">
                <h2>Goal · a structure, not a position</h2>
                <div className="mono">{run.data.goalText}</div>
                <ol style={{ marginTop: 8 }}>
                  <li><b style={{ color: "#fbbf24" }}>amber wireframe</b> = a goal slot, {want} blocks tall, still to build</li>
                  <li><b style={{ color: "#34d399" }}>green blocks</b> = wall laid · <b style={{ color: "#f59e0b" }}>orange</b> = scattered pile · <b style={{ color: "#a78bfa" }}>◆</b> = courtyard core</li>
                </ol>
                <div className="row" style={{ marginTop: 8, gap: 8 }}>
                  <span className="mono" style={{ color: "var(--muted)", minWidth: 70 }}>blocks laid</span>
                  <input type="range" min={0} max={totalBlocks} step={1} value={blocksLaid} readOnly style={{ flex: 1, accentColor: "#34d399" }} />
                  <span className="mono" style={{ color: "#34d399" }}>{blocksLaid}/{totalBlocks}</span>
                </div>
                <div className="row" style={{ marginTop: 6, gap: 8 }}>
                  <span className="mono" style={{ color: "var(--muted)", minWidth: 70 }}>slots done</span>
                  <input type="range" min={0} max={run.data.targets.length} step={1} value={f?.placed ?? 0} readOnly style={{ flex: 1, accentColor: "#34d399" }} />
                  <span className="mono" style={{ color: "#34d399" }}>{f?.placed ?? 0}/{run.data.targets.length}</span>
                </div>
              </div>

              <div className="card">
                <h2>How the planner solves it</h2>
                <div className="mono" style={{ fontSize: 11, lineHeight: 1.7 }}>
                  <div><span style={{ color: "var(--muted)" }}>goal (declarative):</span> <span style={{ color: "var(--accent-2)" }}>∧ height(cell) ≥ {want}</span> over {run.data.targets.length} cells</div>
                  <div><span style={{ color: "var(--muted)" }}>domain ops:</span> <span style={{ color: "var(--accent)" }}>goto · grab · place</span> &nbsp;<span style={{ color: "var(--muted)" }}>// no &quot;build&quot; task</span></div>
                  <div style={{ marginTop: 2 }}>planner <b style={{ color: "var(--accent-2)" }}>discovers</b> grab→carry→place per cell</div>
                </div>
                <div className="mono" style={{ color: "var(--muted)", marginTop: 8, fontSize: 11 }}>
                  <b style={{ color: "var(--accent-2)" }}>goalAgenda</b>: splits the conjunction into {run.data.targets.length} per-cell subgoals and commits to them one at a time. A flat search over all of them blows up; this stays linear.
                </div>
                <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.18)" }}>
                  <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>now · subgoal {activeSlot}/{run.data.targets.length} (height(cell) ≥ {want})</div>
                  <div className="mono" style={{ marginTop: 2 }}><span style={{ color: phase.color }}>{phase.icon} {phase.text}</span></div>
                  <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{f?.action ?? "start"}</div>
                </div>
              </div>
            </>
          );
        })()}

        <div className="card">
          <h2>Trace events {squad ? "· glass-box" : ""}</h2>
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

function outcome(f: SquadFrame): string {
  const dead = f.teams.filter((t) => t.alive === 0);
  if (dead.length) return `${teamName(dead[0].side)} eliminated`;
  return "engaging";
}

/** Map a raw wall action label to a human phase for the "now" readout. */
function wallPhase(action: string, holding: boolean): { icon: string; text: string; color: string } {
  if (action.startsWith("grab")) return { icon: "✋", text: "picking up a block from the pile", color: "#f59e0b" };
  if (action.startsWith("place")) return { icon: "▮", text: "laying a block on the wall", color: "#34d399" };
  if (action.startsWith("goto")) return holding ? { icon: "→", text: "carrying a block to the wall", color: "#38bdf8" } : { icon: "→", text: "walking to a block", color: "#38bdf8" };
  if (action === "start") return { icon: "•", text: "planning the first placement", color: "var(--muted)" };
  return { icon: "✓", text: "wall complete", color: "#34d399" };
}
