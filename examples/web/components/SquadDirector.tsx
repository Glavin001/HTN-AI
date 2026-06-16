"use client";
/**
 * Glass-box AI director (E3). For a selected NPC it renders, live, what the
 * planner is doing and why: the current plan (with the executing step), recent
 * trace events, and — when a branch was rejected — the readable "why not X"
 * reasons surfaced by collectRejections/explainFailure. The page's playback
 * slider scrubs the deterministic recording, so this doubles as a replay inspector.
 */
import type { SquadFrame, UnitFrame } from "@scenarios/squad-combat";

const SIDE_COLOR: Record<string, string> = { enemy: "#ef4444", ally: "#34d399", player: "#38bdf8" };

export default function SquadDirector({
  frame,
  units,
  selected,
  onSelect,
}: {
  frame: SquadFrame;
  units: string[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  const u: UnitFrame | undefined = frame.units.find((x) => x.name === selected);
  return (
    <div className="card">
      <h2>AI director · glass-box</h2>
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {units.map((name) => {
          const unit = frame.units.find((x) => x.name === name);
          const color = SIDE_COLOR[unit?.side ?? ""] ?? "#94a3b8";
          return (
            <button
              key={name}
              onClick={() => onSelect(name)}
              className={selected === name ? "primary" : ""}
              style={{ borderColor: color, color: selected === name ? undefined : color }}
            >
              {name}
              {unit && !unit.alive ? " ✕" : ""}
            </button>
          );
        })}
      </div>

      {!u && <div className="mono" style={{ color: "var(--muted)", marginTop: 10 }}>select an NPC (click it, or a button above)</div>}

      {u && (
        <div style={{ marginTop: 10 }}>
          <div className="kv">
            <span className="k">role · tactic</span>
            <span className="mono">{u.role} · {u.tactic}</span>
          </div>
          <div className="kv">
            <span className="k">status</span>
            <span className={`pill ${u.status === "running" ? "busy" : u.status === "succeeded" ? "good" : u.status === "failed" ? "bad" : ""}`}>{u.status}</span>
          </div>
          <div className="kv">
            <span className="k">hp · ammo</span>
            <span className="mono">{Math.round(u.hp)} · {u.ammo}</span>
          </div>

          <h3 style={{ margin: "12px 0 4px", fontSize: 12, color: "var(--muted)" }}>PLAN · discovered by search</h3>
          <div className="steps">
            {u.plan.length === 0 && <div className="step">{u.status === "failed" ? "no plan — see rejections" : "—"}</div>}
            {u.plan.map((s, i) => {
              const active = s.includes(u.step) || u.step.includes(s.replace(/^\d+\.\s*/, "").split(" ")[0] ?? "");
              return (
                <div className={`step ${active ? "active" : ""}`} key={i}>
                  <span>{s}</span>
                </div>
              );
            })}
          </div>

          {u.why.length > 0 && (
            <>
              <h3 style={{ margin: "12px 0 4px", fontSize: 12, color: "var(--muted)" }}>WHY NOT · rejected branches</h3>
              <div className="steps">
                {u.why.map((w, i) => (
                  <div className="step" key={i} style={{ color: "#fca5a5" }}>
                    {w}
                  </div>
                ))}
              </div>
            </>
          )}

          <h3 style={{ margin: "12px 0 4px", fontSize: 12, color: "var(--muted)" }}>RECENT EVENTS</h3>
          <div className="legend">
            {u.events.length === 0 && <span className="mono" style={{ color: "var(--muted)" }}>—</span>}
            {u.events.map((e, i) => (
              <span key={i} className="mono" style={{ color: /fail|violated|failed/.test(e) ? "#fca5a5" : /replan|repair|scope/.test(e) ? "var(--accent-2)" : "var(--muted)" }}>
                {e}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
