"use client";
/**
 * Glass-box AI director (E3). For a selected NPC it shows, in plain language, what
 * the planner is trying to do and how: the GOAL (and how the library expresses it),
 * what it's doing right now, the current PLAN (humanized, live step highlighted, with
 * a clear "replanning" state), and — when a branch was rejected — the readable
 * "why not X" reasons from collectRejections/explainFailure.
 */
import type { SquadFrame, SquadInstance, UnitFrame } from "@scenarios/squad-combat";
import { tacticalRead } from "../lib/tacticalView";

const SIDE_COLOR: Record<string, string> = { enemy: "#ef4444", ally: "#3b82f6", player: "#3b82f6" };

/** Turn a raw plan step ("0. flankTo(fNE) [t=…]") into a readable instruction. */
function humanize(raw: string): string {
  const s = raw.replace(/^\d+\.\s*/, "").replace(/\s*\[t=.*$/, "");
  if (s.startsWith("flankTo")) return "flank to a covered angle";
  if (s.startsWith("advanceTo")) return "move up to cover";
  if (s.startsWith("climbTo")) return "take the high ground";
  if (s.startsWith("moveToBreach")) return "stack on the door";
  if (s.startsWith("breach")) return "breach the door";
  if (s.startsWith("takeShot")) return "fire on the enemy";
  if (s.startsWith("suppress")) return "lay down suppressing fire";
  if (s.startsWith("reload")) return "reload";
  if (s.startsWith("retreatTo")) return "fall back to cover";
  if (s.startsWith("enter:")) return `▸ begin ${s.slice(6).replace(/-/g, " ")}`;
  if (s.startsWith("exit:")) return `◂ end ${s.slice(5).replace(/-/g, " ")}`;
  if (s.startsWith("wait") || s.startsWith("hold")) return "hold position";
  return s;
}

const tacticWord: Record<string, string> = {
  flank: "flank — one pins while one swings wide",
  breach: "breach — stack the door, enter together",
  hold: "hold — fight from cover",
  regroup: "regroup",
};

export default function SquadDirector({
  frame,
  instance,
  spots,
  heatMode = "belief",
  units,
  selected,
  onSelect,
}: {
  frame: SquadFrame;
  instance: SquadInstance;
  spots: { name: string; x: number; z: number }[];
  heatMode?: "belief" | "truth";
  units: string[];
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  const u: UnitFrame | undefined = frame.units.find((x) => x.name === selected);
  const read = tacticalRead(instance, frame, spots, selected ?? null, heatMode);
  const best = read?.best ?? null;
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
          {u.posture && u.posture !== "—" && (
            <div className="mono" style={{ color: u.posture.includes("cover") || u.posture.includes("shielded") ? "var(--accent)" : "#fca5a5", marginTop: 3, fontSize: 11 }}>
              ◈ reading the room: {u.posture}
            </div>
          )}

          {u.alive && read && read.here && (
            <>
              <h3 className="dir-h" style={{ marginTop: 12 }}>
                POSITION READ <span style={{ color: "var(--muted)", fontWeight: 400 }}>· scoring vs {heatMode === "belief" ? "what it knows" : "ground truth"}</span>
              </h3>
              <div className="risk-row">
                <span className="risk-tag">here</span>
                <span className="mono" style={{ color: read.here.exposure > 0 ? "#fca5a5" : "var(--accent)" }}>
                  {read.cover > 0 ? `🛡 covered vs ${read.cover}` : read.here.exposure > 0 ? "exposed" : "no contact"}
                </span>
                <span className="mono" style={{ color: "var(--muted)" }}>
                  {read.here.exposure} gun{read.here.exposure === 1 ? "" : "s"} on me{read.range != null ? ` · ${Math.round(read.range)}m` : ""}
                </span>
                <span className="pill" style={{ color: read.here.firing ? "var(--good)" : "var(--muted)" }}>{read.here.firing ? "has shot" : "no shot"}</span>
              </div>
              {best && (
                <div className="risk-row">
                  <span className="risk-tag good">best</span>
                  <span className="mono" style={{ color: "var(--good)" }}>{best.name.startsWith("spot") ? "a covered angle" : best.name}</span>
                  <span className="mono" style={{ color: "var(--muted)" }}>
                    {best.eval.exposure > 0 ? `exposed ${best.eval.exposure}` : "safe"} · cost {best.eval.cost.toFixed(1)} · {Math.round(best.travel)}m away
                  </span>
                </div>
              )}
              <div className="mono" style={{ color: "var(--muted)", marginTop: 4, fontSize: 10.5 }}>
                {read.firingCount} firing position{read.firingCount === 1 ? "" : "s"} scored · select on the map to see the heat overlay
              </div>
            </>
          )}

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
