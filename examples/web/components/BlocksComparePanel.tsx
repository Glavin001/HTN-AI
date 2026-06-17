"use client";
import type { BlocksCompare, SearchMetric } from "../lib/runBlocks";

/**
 * Head-to-head search cost for the hard blocks instance: weighted-A* vs BFWS on
 * the SAME world and goal. Bars are normalised to the larger of the two so the
 * gap is read at a glance — fewer expansions, far fewer heuristic evaluations,
 * less wall-clock. (Plan length is shown too: BFWS trades optimality for speed,
 * so its plan can be longer — the honest part of the agile bargain.)
 */
function Row({ m, peak, accent }: { m: SearchMetric; peak: { exp: number; hev: number; ms: number }; accent: string }) {
  const bar = (v: number, max: number) => `${Math.max(2, Math.round((v / Math.max(max, 1)) * 100))}%`;
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="row spread" style={{ marginBottom: 4 }}>
        <b className="mono" style={{ color: accent }}>{m.label}</b>
        <span className="mono" style={{ color: "var(--muted)", fontSize: 11 }}>{m.note}</span>
      </div>
      <Metric name="expansions" value={m.expansions} width={bar(m.expansions, peak.exp)} accent={accent} />
      <Metric name="heuristic evals" value={m.heuristicEvals} width={bar(m.heuristicEvals, peak.hev)} accent={accent} />
      <Metric name="time" value={`${m.ms.toFixed(0)} ms`} width={bar(m.ms, peak.ms)} accent={accent} />
      <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>plan length {m.planLength} · {m.ok ? "solved" : "gave up"}</div>
    </div>
  );
}

function Metric({ name, value, width, accent }: { name: string; value: number | string; width: string; accent: string }) {
  return (
    <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 2 }}>
      <span className="mono" style={{ width: 110, color: "var(--muted)", fontSize: 11 }}>{name}</span>
      <div style={{ flex: 1, height: 8, background: "#0e1422", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width, height: "100%", background: accent, borderRadius: 4, transition: "width .4s" }} />
      </div>
      <span className="mono" style={{ width: 64, textAlign: "right" }}>{value}</span>
    </div>
  );
}

export default function BlocksComparePanel({ compare }: { compare: BlocksCompare }) {
  const peak = {
    exp: Math.max(compare.wastar.expansions, compare.bfws.expansions),
    hev: Math.max(compare.wastar.heuristicEvals, compare.bfws.heuristicEvals),
    ms: Math.max(compare.wastar.ms, compare.bfws.ms),
  };
  const hevX = (compare.wastar.heuristicEvals / Math.max(compare.bfws.heuristicEvals, 1)).toFixed(0);
  const expX = (compare.wastar.expansions / Math.max(compare.bfws.expansions, 1)).toFixed(0);
  return (
    <div className="card">
      <h2>Search cost · same instance</h2>
      <div className="mono" style={{ color: "var(--muted)", marginBottom: 10, fontSize: 11 }}>
        identical 12-block world &amp; goal, solved two ways. The animation plays the <span style={{ color: "#34d399" }}>BFWS</span> solution.
      </div>
      <Row m={compare.wastar} peak={peak} accent="#fbbf24" />
      <Row m={compare.bfws} peak={peak} accent="#34d399" />
      <div className="mono" style={{ color: "var(--accent-2)", marginTop: 4 }}>
        BFWS: {expX}× fewer expansions · {hevX}× fewer heuristic evaluations
      </div>
    </div>
  );
}
