"use client";
/**
 * Glass-box AI director (E3). For a selected NPC it shows, in plain language, what
 * the planner is trying to do and how: the GOAL (and how the library expresses it),
 * what it's doing right now, the current PLAN (humanized, live step highlighted, with
 * a clear "replanning" state), and — when a branch was rejected — the readable
 * "why not X" reasons from collectRejections/explainFailure.
 */
import type { SquadFrame, UnitFrame } from "@scenarios/squad-combat";

const SIDE_COLOR: Record<string, string> = { enemy: "#ef4444", ally: "#3b82f6", player: "#3b82f6" };

/** Turn a raw plan step ("3. step(k2_4, k3_5) [t=…]") into a readable instruction. */
function humanize(raw: string): string {
  const s = raw.replace(/^\d+\.\s*/, "").replace(/\s*\[t=.*$/, "");
  if (s.startsWith("step")) return "move to the next covered cell";
  if (s.startsWith("breach")) return "breach the door";
  if (s.startsWith("takeShot")) return "fire on the enemy";
  if (s.startsWith("reload")) return "reload";
  if (s.startsWith("enter:")) return `▸ begin ${s.slice(6).replace(/-/g, " ")}`;
  if (s.startsWith("exit:")) return `◂ end ${s.slice(5).replace(/-/g, " ")}`;
  if (s.startsWith("wait") || s.startsWith("hold")) return "hold position";
  return s;
}

const tacticWord: Record<string, string> = {
  breach: "breach — stack the door, enter together",
  hold: "hold — search a route, fight from cover",
  flank: "flank",
  regroup: "regroup",
};

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
            <button key={name} onClick={() => onSelect(name)} className={selected === name ? "primary" : ""} style={{ borderColor: color, color: selected === name ? undefined : color }}>
              {name}
              {unit && !unit.alive ? " ✕" : ""}
            </button>
          );
        })}
      </div>

      {!u && <div className="mono" style={{ color: "var(--muted)", marginTop: 10 }}>select a unit (click it, or a button above)</div>}

      {u && (
        <div style={{ marginTop: 10 }}>
          <h3 className="dir-h">GOAL <span style={{ color: "var(--muted)", fontWeight: 400 }}>· what it wants</span></h3>
          <div style={{ fontSize: 13, color: "var(--text)" }}>{u.goalText}</div>
          {u.goalExpr && <div className="mono" style={{ color: "var(--accent-2)", marginTop: 2 }}>{u.goalExpr}</div>}

          <h3 className="dir-h" style={{ marginTop: 12 }}>DOING NOW</h3>
          <div className="row spread">
            <span style={{ fontSize: 13 }}>{u.action}</span>
            {u.replanning ? <span className="pill busy">⟳ replanning…</span> : <span className="pill" style={{ color: "var(--muted)" }}>{tacticWord[u.tactic]?.split(" — ")[0] ?? u.tactic}</span>}
          </div>
          <div className="mono" style={{ color: "var(--muted)", marginTop: 3, fontSize: 11 }}>{u.role} · {tacticWord[u.tactic] ?? u.tactic} · hp {Math.round(u.hp)} · ammo {u.ammo}</div>

          <h3 className="dir-h" style={{ marginTop: 12 }}>
            PLAN <span style={{ color: "var(--muted)", fontWeight: 400 }}>· discovered by search</span>
            {u.replanning && <span style={{ color: "var(--accent-2)", marginLeft: 6 }}>⟳</span>}
          </h3>
          <div className="steps">
            {u.plan.length === 0 && <div className="step">{u.replanning ? "recomputing a plan…" : u.status === "failed" ? "no plan — see rejections" : "—"}</div>}
            {u.plan.map((s, i) => {
              const active = u.step !== "—" && s.includes(u.step.replace(/\[t=.*$/, "").trim());
              return (
                <div className={`step ${active ? "active" : ""}`} key={i}>
                  <span>{active ? "▶ " : ""}{humanize(s)}</span>
                </div>
              );
            })}
          </div>

          {u.why.length > 0 && (
            <>
              <h3 className="dir-h" style={{ marginTop: 12 }}>WHY NOT <span style={{ color: "var(--muted)", fontWeight: 400 }}>· rejected branches</span></h3>
              <div className="steps">
                {u.why.map((w, i) => <div className="step" key={i} style={{ color: "#fca5a5" }}>{w}</div>)}
              </div>
            </>
          )}

          <h3 className="dir-h" style={{ marginTop: 12 }}>RECENT EVENTS</h3>
          <div className="legend">
            {u.events.length === 0 && <span className="mono" style={{ color: "var(--muted)" }}>—</span>}
            {u.events.map((e, i) => (
              <span key={i} className="mono" style={{ color: /fail|violated/.test(e) ? "#fca5a5" : /replan|repair|scope/.test(e) ? "var(--accent-2)" : "var(--muted)" }}>{e}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
