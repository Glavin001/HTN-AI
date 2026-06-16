"use client";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { runScenario, scenarioHeavyMs, traceSummary, type RunResult } from "../lib/run";
import { runBlocks, type BlocksRun } from "../lib/runBlocks";
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
import { useLiveDive } from "../lib/useLiveDive";
import type { SquadFrame, SquadInstance } from "@scenarios/squad-combat";
import type { TraceEvent } from "htn-ai";

const StaircaseScene = dynamic(() => import("../components/StaircaseScene"), { ssr: false });
const BlocksScene = dynamic(() => import("../components/BlocksScene"), { ssr: false });
const SquadScene = dynamic(() => import("../components/SquadScene"), { ssr: false });
const DiveScene = dynamic(() => import("../components/DiveScene"), { ssr: false });
import SquadDirector from "../components/SquadDirector";

type GridId = "staircase" | "ledge" | "quarry" | "scavenger" | "scavengerBig" | "scavengerHuge";
type ScenarioId = GridId | "blocks" | SquadScenarioId | "dive";
type Kind = "grid" | "blocks" | "squad" | "dive";

type Run = { kind: "grid"; data: RunResult } | { kind: "blocks"; data: BlocksRun } | { kind: "squad"; data: SquadRun };

const SCENARIOS: Record<ScenarioId, { name: string; blurb: string; kind: Kind }> = {
  dive: { name: "★ Deathmatch arena (LIVE)", kind: "dive", blurb: "A LIVE 4-bot free-for-all à la the 'Dive' shooter — but every bot is an htn-ai planner. Each arbitrates attack / get-health / get-weapon / explore from its own belief, hunts your last-seen position, picks weapons by range and respawns. Take over a bot (WASD + Space/click to fire) and fight them yourself." },
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
};

function buildRun(id: ScenarioId): Run {
  const kind = SCENARIOS[id].kind;
  if (kind === "blocks") return { kind: "blocks", data: runBlocks() };
  if (kind === "squad") return { kind: "squad", data: runSquad(id as SquadScenarioId) };
  return { kind: "grid", data: runScenario(id as GridId) };
}

interface SquadView {
  frame: SquadFrame;
  trace: { unit: string; e: TraceEvent }[];
  units: string[];
  instance: SquadInstance;
  spots: { name: string; x: number; z: number }[];
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
  const [heatMode, setHeatMode] = useState<"belief" | "truth">("belief");

  const isLive = scenario === "companion";
  const isDive = scenario === "dive";
  const live = useLiveSquad(isLive ? "companion" : null, liveStepMs);
  const dive = useLiveDive(isDive, liveStepMs);

  // build the deterministic replay for everything EXCEPT the live battles (dive + companion)
  useEffect(() => {
    if (isLive || isDive) { setRun(null); setComputing(false); return; }
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
      ? { frame: live.frame, trace: live.trace, units: live.units, instance: live.instance, spots: live.spots }
      : null
    : run?.kind === "squad"
      ? { frame: run.data.frames[Math.min(step, lastStep)], trace: run.data.trace, units: run.data.units, instance: run.data.instance, spots: run.data.spots }
      : null;

  const trace = squad ? squad.trace.map((t) => t.e) : run && run.kind !== "squad" ? run.data.trace : [];
  const summary = useMemo(() => (squad ? squadTraceSummary(squad.trace) : traceSummary(trace)), [squad, trace]);
  const interesting = useMemo(() => summary.filter((s) => /repair|replan|fail|scope|drift/.test(s.label)), [summary]);

  const narration = squad ? squadNarration(squad.frame) : "";
  const watch = SCENARIOS[scenario].kind === "squad" ? whatToWatch(scenario as SquadScenarioId) : [];
  const status = run?.kind === "grid" ? run.data.status : squad ? outcome(squad.frame) : isDive && dive.frame ? diveStatus(dive.frame) : "—";

  // a unified "live" controller so the playback card drives the squad OR dive sim
  const liveCtl = isDive
    ? { playing: dive.playing, setPlaying: dive.setPlaying, stepOnce: dive.stepOnce, reset: dive.reset }
    : isLive
      ? { playing: live.playing, setPlaying: live.setPlaying, stepOnce: live.stepOnce, reset: live.reset }
      : null;

  // default the inspector to the first combatant in the live deathmatch
  useEffect(() => {
    if (isDive && dive.frame && !selected) setSelected(dive.frame.bots[0]?.name ?? null);
  }, [isDive, dive.frame, selected]);

  return (
    <div className="app">
      <div className="stage">
        <div className="title">
          <h1>htn-ai · {SCENARIOS[scenario].name}</h1>
          <p>{SCENARIOS[scenario].blurb}</p>
        </div>

        {run?.kind === "grid" && <StaircaseScene key="grid" frame={run.data.frames[step]} instance={run.data.instance} target={run.data.target} reached={step === lastStep && status === "succeeded"} />}
        {run?.kind === "blocks" && <BlocksScene key="blocks" frame={run.data.frames[step]} blocks={run.data.blocks} reached={step === lastStep} />}
        {squad && <SquadScene key="squad" frame={squad.frame} instance={squad.instance} spots={squad.spots} heatMode={heatMode} selected={selected} onSelect={(n) => setSelected(n || null)} />}
        {isDive && dive.frame && (
          <DiveScene
            key="dive"
            frame={dive.frame}
            halfWidth={dive.frame.halfWidth}
            halfDepth={dive.frame.halfDepth}
            selected={selected}
            onSelect={(n) => setSelected(n || null)}
            humanName={dive.humanName}
            onInput={dive.setInput}
          />
        )}
        {isDive && dive.frame && (
          <div className="hud-top">
            {dive.frame.scoreboard.map((s) => (
              <span key={s.name} className="team-chip">
                <i className="dot" style={{ background: s.color }} />
                <b style={{ color: s.color }}>{s.name}</b>
                <span className="mono">{s.frags} frags · {s.deaths} deaths{dive.humanName === s.name ? " · YOU" : ""}</span>
              </span>
            ))}
          </div>
        )}
        {isDive && dive.humanName && (
          <div className="hud-narration">You are <b>{dive.humanName}</b> — WASD / arrows to move · Space or click to fire</div>
        )}

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
        {squad && (
          <div className="hud-heat mono" style={{ position: "absolute", left: 12, bottom: 12, display: "flex", gap: 8, alignItems: "center", fontSize: 11, background: "rgba(11,14,20,0.7)", padding: "5px 9px", borderRadius: 6, color: "#9fb0c8" }}>
            <span>spot field:</span>
            {(["belief", "truth"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setHeatMode(m)}
                style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, cursor: "pointer", border: "1px solid " + (heatMode === m ? "#38bdf8" : "#2a3650"), background: heatMode === m ? "rgba(56,189,248,0.18)" : "transparent", color: heatMode === m ? "#7dd3fc" : "#7c8aa3" }}
              >
                {m === "belief" ? "what it knows" : "ground truth"}
              </button>
            ))}
            <span style={{ opacity: 0.7 }}>· select a unit · 🟢 safe → 🔴 exposed · grey = no shot</span>
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
              <optgroup label="Game AI">
                {(Object.keys(SCENARIOS) as ScenarioId[]).filter((id) => SCENARIOS[id].kind === "squad" || SCENARIOS[id].kind === "dive").map((id) => <option key={id} value={id}>{SCENARIOS[id].name}</option>)}
              </optgroup>
              <optgroup label="Spatial planning">
                {(Object.keys(SCENARIOS) as ScenarioId[]).filter((id) => SCENARIOS[id].kind !== "squad" && SCENARIOS[id].kind !== "dive").map((id) => <option key={id} value={id}>{SCENARIOS[id].name}</option>)}
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

        {isDive && dive.frame && (
          <div className="card">
            <h2>Take control — live</h2>
            <div className="mono" style={{ color: "var(--muted)", marginBottom: 8 }}>
              swap a bot between the <span style={{ color: "var(--accent-2)" }}>htn-ai planner</span> and <span style={{ color: "var(--accent-2)" }}>you</span> on the running sim — no reset. WASD/arrows move · Space/click fires.
            </div>
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {dive.frame.bots.map((b) => (
                <button
                  key={b.name}
                  onClick={() => { setSelected(b.name); dive.takeOver(dive.humanName === b.name ? null : b.name); }}
                  style={{ border: "1px solid " + (dive.humanName === b.name ? "#fde047" : "#2a3650"), color: dive.humanName === b.name ? "#fde047" : b.color, fontWeight: 700 }}
                >
                  {dive.humanName === b.name ? `🎮 ${b.name} (release)` : `take ${b.name}`}
                </button>
              ))}
            </div>
          </div>
        )}

        {isDive && dive.frame && selected && (() => {
          const b = dive.frame.bots.find((x) => x.name === selected);
          if (!b) return null;
          return (
            <div className="card">
              <h2>Bot · <span style={{ color: b.color }}>{b.name}</span> {b.control === "human" ? "(you)" : "· glass-box"}</h2>
              <div className="mono" style={{ color: "var(--muted)" }}>{b.goalText}</div>
              <div className="mono" style={{ marginTop: 4 }}>action: <span style={{ color: "var(--accent-2)" }}>{b.action}</span> · {b.hp} hp · {b.weapon}{b.ammo >= 0 ? ` (${b.ammo})` : ""}</div>
              {b.control === "ai" && b.plan.length > 0 && (
                <div className="mono" style={{ marginTop: 6, color: "var(--muted)" }}>plan: {b.plan.join(" → ")}</div>
              )}
              {b.control === "ai" && (
                <div className="legend" style={{ marginTop: 6 }}>{b.events.map((e, i) => <span key={i} className="mono">{e}</span>)}</div>
              )}
            </div>
          );
        })()}

        <div className="card">
          <h2>{liveCtl ? "Live battle" : "Playback · deterministic replay"}</h2>
          <div className="row">
            <button className="primary" onClick={() => (liveCtl ? liveCtl.setPlaying(!liveCtl.playing) : setPlaying((p) => !p))} disabled={!liveCtl && !run}>
              {(liveCtl ? liveCtl.playing : playing) ? "⏸ Pause" : "▶ Play"}
            </button>
            <button onClick={() => (liveCtl ? liveCtl.stepOnce() : setStep((s) => Math.min(s + 1, lastStep)))} disabled={liveCtl ? false : !run || step >= lastStep}>Step ⟩</button>
            <button onClick={() => (liveCtl ? liveCtl.reset() : (setStep(0), setPlaying(true)))} disabled={!liveCtl && !run}>⟲ {liveCtl ? "Restart" : "Reset"}</button>
          </div>
          {!liveCtl && (
            <div className="row" style={{ marginTop: 10 }}>
              <span className="mono" style={{ color: "var(--muted)" }}>t</span>
              <input type="range" min={0} max={lastStep} step={1} value={Math.min(step, lastStep)} onChange={(e) => { setPlaying(false); setStep(Number(e.target.value)); }} style={{ flex: 1 }} />
              <span className="mono">{step}/{lastStep}</span>
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <span className="mono" style={{ color: "var(--muted)" }}>speed</span>
            {liveCtl ? (
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

function diveStatus(f: import("@scenarios/dive").DiveFrame): string {
  const leader = f.scoreboard[0];
  return leader && leader.frags > 0 ? `${leader.name} leads ${leader.frags}` : "deathmatch";
}
