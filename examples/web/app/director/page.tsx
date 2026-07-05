"use client";
/**
 * /director — live demo of the structured plan-event stream (PlanEventStream).
 *
 * A real reactive Planner runs the ~6-operator director domain in your browser
 * (nothing is prerecorded). The buttons mutate the live world the way a game
 * would — silently breaking the nav mesh, announcing an oracle re-weight,
 * changing the agent's belief — and the right panel shows the exact PlanEvent
 * data a director system receives from `stream.drain()`.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { PlanEvent } from "htn-ai";
import DirectorMap from "../../components/DirectorMap";
import { useDirectorFeed } from "../../lib/useDirectorFeed";

type Invalidated = PlanEvent & { t: "plan.invalidated" };

function reasonText(r: Invalidated["reason"]): string {
  switch (r.kind) {
    case "world-changed":
      return `world changed (${r.fluents.join(", ")}) — a better plan exists`;
    case "step-failed":
      return `${r.step} failed · cause: ${r.cause}${r.scope ? ` · scope ${r.scope.label}/${r.scope.violated}` : ""}`;
    case "search-exhausted":
      return `no plan exists — ${r.rejections.length} rejections`;
  }
}

const chipStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid var(--border)",
  background: "var(--panel-2)",
  fontSize: 12,
  marginRight: 6,
  marginBottom: 6,
};

const btnStyle: React.CSSProperties = {
  padding: "7px 12px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--panel-2)",
  color: "var(--text)",
  fontSize: 13,
  cursor: "pointer",
};

function EventRow({ e, raw }: { e: PlanEvent; raw: boolean }) {
  const stamp = `t=${e.at.toFixed(1)}s · ${e.agent} · plan#${e.planId}`;
  let color = "var(--muted)";
  let title = "";
  let body: React.ReactNode = null;
  switch (e.t) {
    case "plan.created":
      color = "var(--good)";
      title = `■ plan.created · via ${e.via} · cost ${e.cost}`;
      body = <div style={{ color: "var(--text)", opacity: 0.9 }}>{e.steps.filter((s) => s.kind === "op").map((s) => s.label).join(" → ")}</div>;
      break;
    case "step.started":
      title = `▶ ${e.label}`;
      break;
    case "step.completed":
      color = "var(--accent)";
      title = `✔ ${e.label}`;
      break;
    case "plan.completed":
      color = "var(--accent-2)";
      title = "★ plan.completed";
      break;
    case "plan.invalidated":
      color = "var(--bad)";
      title = "✖ plan.invalidated";
      body = <div>{reasonText(e.reason)}</div>;
      break;
    case "plan.failed":
      color = "var(--bad)";
      title = "☠ plan.failed";
      body = (
        <div>
          {reasonText(e.reason)}
          {e.reason.kind === "search-exhausted" &&
            e.reason.rejections.slice(0, 3).map((r, i) => (
              <div key={i} style={{ opacity: 0.75 }}>· {r.at}: {r.reason}</div>
            ))}
        </div>
      );
      break;
  }
  return (
    <div style={{ borderLeft: `3px solid ${color}`, padding: "5px 10px", marginBottom: 6, background: "var(--panel-2)", borderRadius: 6, fontSize: 13 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span style={{ color }}>{title}</span>
        <span style={{ color: "var(--muted)", fontSize: 11, whiteSpace: "nowrap" }}>{stamp}</span>
      </div>
      {body && <div style={{ color: "var(--muted)", marginTop: 2 }}>{body}</div>}
      {raw && (
        <pre style={{ margin: "6px 0 0", padding: 8, background: "var(--bg)", borderRadius: 6, fontSize: 11, overflowX: "auto", color: "var(--muted)" }}>
          {JSON.stringify(e, null, 1)}
        </pre>
      )}
    </div>
  );
}

const SNIPPET = `import { Planner, PlanEventStream, task } from "htn-ai";

const stream = new PlanEventStream();          // one stream…
stream.attach(planner, "alpha");               // …any number of planners

// every frame, in your game loop:
planner.tick({ ms: 0.5 });
for (const e of stream.drain()) director.observe(e);

// e = { t: "plan.invalidated", agent: "alpha", planId: 2, seq: 17, at: 6.1,
//       reason: { kind: "step-failed", step: "GoTo(room)",
//                 cause: "precondition", detail: "…" } }`;

export default function DirectorPage() {
  const feed = useDirectorFeed(600);
  const [raw, setRaw] = useState(false);
  const feedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed.events.length, raw]);

  const snap = feed.snapshot;
  const done = snap?.status === "succeeded";
  const failed = snap?.status === "failed";

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "20px 18px 40px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>htn-ai · Director feed</h1>
        <Link href="/" style={{ color: "var(--accent)", fontSize: 13 }}>← all scenarios</Link>
      </div>
      <p style={{ color: "var(--muted)", maxWidth: 900, fontSize: 14 }}>
        A real reactive <code>Planner</code> runs a ~6-operator tactical domain (GoTo · Breach · TakeCover · Suppress · Regroup · Idle)
        live in your browser, with a <code>PlanEventStream</code> attached. Sabotage the world with the buttons and watch the plan
        lifecycle arrive as <b>structured, JSON-serializable events</b> — created / step started / invalidated (with a machine-readable
        reason) / failed — the feed a game director or LLM consumes.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(300px, 420px)", gap: 16, alignItems: "start" }}>
        <div>
          {snap && <DirectorMap snap={snap} />}

          <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button style={{ ...btnStyle, opacity: feed.doorCollapsed ? 0.45 : 1 }} disabled={feed.doorCollapsed} onClick={feed.collapseDoor} title="Silent nav-mesh change: discovered only when a step's precondition re-check fails → plan.invalidated {cause: precondition} → repair">
              💥 Collapse doorway <span style={{ color: "var(--muted)" }}>(silent)</span>
            </button>
            <button style={{ ...btnStyle, opacity: feed.flankCheap ? 0.45 : 1 }} disabled={feed.flankCheap} onClick={feed.reweightFlank} title="Announced oracle change: flank becomes cheap, navVersion bumped → plan.invalidated {world-changed} → cheaper plan via improve">
              🛰 Re-weight flank <span style={{ color: "var(--muted)" }}>(announced)</span>
            </button>
            {snap?.threatKnown && !snap.threatDown ? (
              <button style={btnStyle} onClick={feed.loseThreat} title="Silent belief change: Suppress's executing condition (verify) notices → plan.invalidated {cause: verify}">
                👻 Threat lost <span style={{ color: "var(--muted)" }}>(silent)</span>
              </button>
            ) : (
              !snap?.threatDown && (
                <button style={btnStyle} onClick={feed.spotThreat} title="Announced belief change: dirty write on threatKnown → the planner reacts">
                  🔔 Threat spotted <span style={{ color: "var(--muted)" }}>(announced)</span>
                </button>
              )
            )}
            <button style={btnStyle} onClick={() => feed.setPlaying(!feed.playing)} disabled={done || failed}>
              {feed.playing ? "⏸ Pause" : "▶ Resume"}
            </button>
            <button style={btnStyle} onClick={feed.reset}>⟲ Reset mission</button>
          </div>

          <div style={{ marginTop: 12 }}>
            <span style={chipStyle}>status: <b style={{ color: done ? "var(--good)" : failed ? "var(--bad)" : "var(--accent)" }}>{snap?.status ?? "…"}</b></span>
            <span style={chipStyle}>at: <b>{snap?.at ?? "…"}</b></span>
            <span style={chipStyle}>step: <b>{snap?.currentStep ?? "—"}</b></span>
            <span style={chipStyle}>door: <b>{snap?.sealed ? "sealed" : "breached"}</b></span>
            <span style={chipStyle}>threat: <b>{snap?.threatDown ? "suppressed" : snap?.threatKnown ? "known" : "unknown"}</b></span>
            <span style={chipStyle}>in cover: <b>{snap?.inCover ? "yes" : "no"}</b></span>
            <span style={chipStyle}>t = <b>{snap?.clock.toFixed(1) ?? "0.0"}s</b></span>
          </div>
          {done && <p style={{ color: "var(--good)", fontSize: 13 }}>Mission complete — the agent regrouped. Reset to run it again (try sabotaging earlier or later).</p>}
          {failed && <p style={{ color: "var(--bad)", fontSize: 13 }}>No plan exists for the current world — see the structured rejections in the feed. Reset to try again.</p>}

          <h3 style={{ margin: "18px 0 6px", fontSize: 14 }}>The integration (all of it)</h3>
          <pre style={{ margin: 0, padding: 12, background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12.5, overflowX: "auto", color: "var(--text)" }}>
            {SNIPPET}
          </pre>
          <p style={{ color: "var(--muted)", fontSize: 12.5 }}>
            Full runnable version: <code>examples/director-feed.ts</code> (<code>npm run demo:director</code>) — the domain, the live
            nav/oracle stubs, and this page&apos;s hook (<code>examples/web/lib/useDirectorFeed.ts</code>) are the same wiring a host
            game would write. Domain source: <code>scenarios/director.ts</code>; contract pinned by <code>tests/director.ts</code>.
          </p>
        </div>

        <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, padding: 12, position: "sticky", top: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <b style={{ fontSize: 14 }}>Director feed <span style={{ color: "var(--muted)", fontWeight: 400 }}>· stream.drain()</span></b>
            <label style={{ fontSize: 12, color: "var(--muted)", cursor: "pointer" }}>
              <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} style={{ verticalAlign: "middle", marginRight: 4 }} />
              raw JSON
            </label>
          </div>
          <div ref={feedRef} style={{ maxHeight: "70vh", overflowY: "auto", paddingRight: 4 }}>
            {feed.events.length === 0 && <div style={{ color: "var(--muted)", fontSize: 13 }}>waiting for the first tick…</div>}
            {feed.events.map((e) => (
              <EventRow key={e.seq} e={e} raw={raw} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
