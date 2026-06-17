"use client";
import { useEffect, useMemo, useRef } from "react";
import type { WallRun, WallSubgoal } from "../lib/runWall";

const VERB = {
  goto: { color: "#38bdf8", icon: "→", label: "walk" },
  grab: { color: "#f59e0b", icon: "✋", label: "pick up" },
  place: { color: "#34d399", icon: "▮", label: "place" },
  start: { color: "var(--muted)", icon: "•", label: "start" },
} as const;

function phaseText(verb: string, holding: boolean): string {
  if (verb === "grab") return "picking up a block from the pile";
  if (verb === "place") return "laying a block on the wall";
  if (verb === "goto") return holding ? "carrying a block to the wall" : "walking to a block";
  if (verb === "start") return "planning the first subgoal";
  return "wall complete";
}

/** A small status dot for an agenda item. */
function Dot({ state }: { state: "done" | "active" | "pending" }) {
  const map = { done: "#34d399", active: "#38bdf8", pending: "#3a4763" } as const;
  return (
    <span
      style={{
        display: "inline-block",
        width: 12,
        height: 12,
        borderRadius: state === "active" ? 3 : 7,
        background: map[state],
        boxShadow: state === "active" ? "0 0 8px #38bdf8" : "none",
        flexShrink: 0,
      }}
    />
  );
}

export default function WallPanel({ run, step }: { run: WallRun; step: number }) {
  const last = run.frames.length - 1;
  const f = run.frames[Math.min(step, last)];
  const want = run.wantHeight;
  const done = run.status === "succeeded" && step >= last;

  // a subgoal is satisfied when the world (this frame) meets its threshold
  const isDone = (s: WallSubgoal) => (s.cell ? (f.heights[s.cell] ?? 0) >= s.level : false);
  const doneCount = run.subgoals.filter(isDone).length;
  const activeIdx = f.goalIndex;
  const activeCell = run.subgoals[activeIdx]?.cell ?? null;

  // group agenda by level (base course / top course); levels appear in order
  const groups = useMemo(() => {
    const byLevel = new Map<number, { idx: number; s: WallSubgoal }[]>();
    run.subgoals.forEach((s, idx) => {
      const arr = byLevel.get(s.level) ?? [];
      arr.push({ idx, s });
      byLevel.set(s.level, arr);
    });
    return [...byLevel.entries()].sort((a, b) => a[0] - b[0]);
  }, [run.subgoals]);

  const blocksLaid = run.targets.reduce((n, c) => n + Math.min(f.heights[c] ?? 0, want), 0);
  const totalBlocks = run.targets.length * want;

  // auto-scroll the active agenda row + current plan row into view
  const agendaActive = useRef<HTMLDivElement>(null);
  const planActive = useRef<HTMLDivElement>(null);
  useEffect(() => { agendaActive.current?.scrollIntoView({ block: "nearest" }); }, [activeIdx]);
  useEffect(() => { planActive.current?.scrollIntoView({ block: "nearest" }); }, [step]);

  const levelName = (level: number) =>
    run.subgoals.some((s) => s.level !== level) ? (level === 1 ? "Base course" : level === 2 ? "Top course" : `Level ${level}`) : "Wall slots";

  return (
    <>
      {/* ---- goal ---- */}
      <div className="card">
        <h2>Goal · a structure, not a position</h2>
        <div className="mono">{run.goalText}</div>
        <div className="row" style={{ marginTop: 8, gap: 8 }}>
          <span className="mono" style={{ color: "var(--muted)", minWidth: 64 }}>blocks</span>
          <div style={{ flex: 1, height: 8, borderRadius: 4, background: "#1a2233", overflow: "hidden" }}>
            <div style={{ width: `${(blocksLaid / totalBlocks) * 100}%`, height: "100%", background: "#34d399", transition: "width .2s" }} />
          </div>
          <span className="mono" style={{ color: "#34d399" }}>{blocksLaid}/{totalBlocks}</span>
        </div>
      </div>

      {/* ---- metrics ---- */}
      <div className="card">
        <h2>Planner · glass box</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 4 }}>
          <Metric label="subgoals" value={`${doneCount}/${run.metrics.subgoals}`} accent="#34d399" />
          <Metric label="actions" value={`${Math.max(step, 0)}/${run.metrics.actions}`} accent="#38bdf8" />
          <Metric label="plans built" value={`${run.metrics.plansBuilt}`} accent="#a78bfa" />
          <Metric label="goto·grab·place" value={`${run.metrics.verbs.goto}·${run.metrics.verbs.grab}·${run.metrics.verbs.place}`} accent="var(--muted)" />
        </div>
        <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 6 }}>
          one declarative goal → {run.metrics.subgoals} {run.hard ? "threshold landmarks" : "per-cell subgoals"}, each its own search ({run.metrics.plansBuilt} plans)
        </div>
      </div>

      {/* ---- subgoal / landmark agenda ---- */}
      <div className="card">
        <h2>{run.hard ? "Landmark agenda" : "Subgoal agenda"}</h2>
        <div style={{ maxHeight: 230, overflowY: "auto", margin: "0 -4px", padding: "0 4px" }}>
          {groups.map(([level, items]) => (
            <div key={level} style={{ marginBottom: 6 }}>
              <div className="mono" style={{ fontSize: 10, letterSpacing: 0.5, textTransform: "uppercase", color: "var(--muted)", padding: "4px 2px 2px" }}>
                {levelName(level)} <span style={{ color: "var(--accent-2)" }}>height ≥ {level}</span> · {items.filter((it) => isDone(it.s)).length}/{items.length}
              </div>
              {items.map(({ idx, s }) => {
                const state = isDone(s) ? "done" : idx === activeIdx && !done ? "active" : "pending";
                return (
                  <div
                    key={idx}
                    ref={state === "active" ? agendaActive : undefined}
                    className="mono"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "3px 6px",
                      borderRadius: 5,
                      fontSize: 11,
                      background: state === "active" ? "rgba(56,189,248,0.12)" : "transparent",
                      color: state === "pending" ? "var(--muted)" : "var(--text)",
                    }}
                  >
                    <Dot state={state} />
                    <span style={{ flex: 1 }}>{s.cell ?? s.text}</span>
                    {state === "done" && s.steps > 0 && <span style={{ color: "var(--muted)" }}>{s.steps} ops</span>}
                    {state === "active" && <span style={{ color: "#38bdf8" }}>building…</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* ---- now ---- */}
      <div className="card">
        <h2>Current step</h2>
        <div style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(56,189,248,0.08)", border: "1px solid rgba(56,189,248,0.18)" }}>
          <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>
            subgoal {Math.min(activeIdx + 1, run.metrics.subgoals)}/{run.metrics.subgoals}
            {activeCell && <> · {activeCell} → height ≥ {run.subgoals[activeIdx]?.level}</>}
          </div>
          <div className="mono" style={{ marginTop: 3, color: (VERB[f.verb as keyof typeof VERB] ?? VERB.start).color }}>
            {(VERB[f.verb as keyof typeof VERB] ?? VERB.start).icon} {done ? "wall complete" : phaseText(f.verb, f.holding)}
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>{f.action}</div>
        </div>
      </div>

      {/* ---- realized plan ---- */}
      <div className="card">
        <h2>Realized plan · {run.metrics.actions} actions <span className="mono" style={{ color: "var(--muted)", fontWeight: 400 }}>(discovered by search)</span></h2>
        <div style={{ maxHeight: 220, overflowY: "auto", margin: "0 -4px", padding: "0 4px" }}>
          {run.frames.slice(1).map((fr, i) => {
            const n = i + 1; // action index (1-based)
            const cur = n === step;
            const v = VERB[fr.verb as keyof typeof VERB] ?? VERB.start;
            return (
              <div
                key={n}
                ref={cur ? planActive : undefined}
                className="mono"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "2px 6px",
                  borderRadius: 5,
                  fontSize: 11,
                  background: cur ? "rgba(56,189,248,0.14)" : "transparent",
                  opacity: n > step ? 0.4 : 1,
                }}
              >
                <span style={{ color: "var(--muted)", minWidth: 22, textAlign: "right" }}>{n}</span>
                <span style={{ color: v.color, minWidth: 16 }}>{v.icon}</span>
                <span style={{ flex: 1, color: cur ? "var(--text)" : "var(--muted)" }}>{fr.action}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ---- how it's solved ---- */}
      <div className="card">
        <h2>How the planner solves it</h2>
        <div className="mono" style={{ fontSize: 11, lineHeight: 1.7 }}>
          <div><span style={{ color: "var(--muted)" }}>goal (declarative):</span> <span style={{ color: "var(--accent-2)" }}>∧ height(cell) ≥ {want}</span></div>
          <div><span style={{ color: "var(--muted)" }}>domain ops:</span> <span style={{ color: "var(--accent)" }}>goto · grab · place</span> <span style={{ color: "var(--muted)" }}>// no &quot;build&quot; task</span></div>
          <div style={{ marginTop: 2 }}>planner <b style={{ color: "var(--accent-2)" }}>discovers</b> grab→carry→place per cell</div>
        </div>
        <div className="mono" style={{ color: "var(--muted)", marginTop: 8, fontSize: 11 }}>
          <b style={{ color: "var(--accent-2)" }}>goalAgenda</b>: splits the conjunction into {run.targets.length} subgoals, committed one at a time — a flat search blows up; this stays linear.
        </div>
        {run.hard && (
          <div className="mono" style={{ color: "#fbbf24", marginTop: 8, fontSize: 11 }}>
            <b>landmarks</b>: realistic physics makes cells interfere — a cell can only be topped from a raised neighbour. The planner derives <span style={{ color: "var(--accent-2)" }}>height ≥ 2</span> passes through <span style={{ color: "var(--accent-2)" }}>height ≥ 1</span> (a threshold landmark) and lays the whole <b>base course before any top course</b>.
          </div>
        )}
      </div>
    </>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={{ padding: "6px 8px", borderRadius: 6, background: "#11192a", border: "1px solid #1c2740" }}>
      <div className="mono" style={{ fontSize: 16, color: accent, lineHeight: 1.1 }}>{value}</div>
      <div className="mono" style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
    </div>
  );
}
