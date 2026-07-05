"use client";
/**
 * 2D SVG map of the director demo domain: six nav nodes, the breachable door
 * on the doorstep–room edge, live traversal costs from the oracle stub, rubble
 * on blocked edges, the agent (with cover ring), the threat, and the currently
 * installed plan drawn as a dashed route.
 */
import type { DirectorSnapshot } from "../lib/useDirectorFeed";

const POS: Record<string, [number, number]> = {
  start: [80, 230],
  doorstep: [230, 230],
  room: [380, 230],
  cover1: [500, 160],
  rally: [300, 70],
  flank: [300, 380],
};

const EDGES: [string, string][] = [
  ["start", "doorstep"],
  ["doorstep", "room"],
  ["room", "cover1"],
  ["start", "rally"],
  ["rally", "cover1"],
  ["start", "flank"],
  ["flank", "cover1"],
];

const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
/** where along a→b to place the cost label (flank edges sit nearer flank, clear of the room label) */
const LABEL_FRAC: Record<string, number> = { "flank|start": 0.35, "cover1|flank": 0.68 };
const along = (a: [number, number], b: [number, number], f: number): [number, number] => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];

/** node sequence of the installed plan, derived from its op labels */
function planRoute(at: string, ops: string[]): [number, number][] {
  const route: string[] = [at];
  for (const label of ops) {
    const m = /^(GoTo|TakeCover|Regroup)\((\w+)\)$/.exec(label);
    if (m && POS[m[2]]) route.push(m[2]);
  }
  return route.map((n) => POS[n]);
}

export default function DirectorMap({ snap }: { snap: DirectorSnapshot }) {
  const blocked = new Set(snap.blocked);
  const route = planRoute(snap.at, snap.planOps);
  const agent = POS[snap.at] ?? POS.start;
  const threatVisible = snap.threatKnown && !snap.threatDown;

  return (
    <svg viewBox="0 0 600 440" style={{ width: "100%", height: "auto", background: "var(--panel)", borderRadius: 12, border: "1px solid var(--border)" }}>
      {/* edges + live costs */}
      {EDGES.map(([a, b]) => {
        const k = key(a, b);
        const isDoor = k === "doorstep|room";
        const isBlocked = blocked.has(k);
        const [ax, ay] = POS[a];
        const [bx, by] = POS[b];
        const [mx, my] = mid(POS[a], POS[b]);
        const [lx, ly] = LABEL_FRAC[k] !== undefined ? along(POS[a], POS[b], LABEL_FRAC[k]) : [mx, my];
        const cost = snap.costs[k];
        return (
          <g key={k}>
            <line x1={ax} y1={ay} x2={bx} y2={by} stroke={isBlocked ? "#3a2530" : "#2a3245"} strokeWidth={isBlocked ? 2 : 3} strokeDasharray={isBlocked ? "4 6" : undefined} />
            {isBlocked && <text x={mx} y={my + 4} textAnchor="middle" fontSize={15} fill="var(--bad)">✕</text>}
            {isDoor && !isBlocked && (
              <rect x={mx - 5} y={my - 14} width={10} height={28} rx={2} fill={snap.sealed ? "var(--bad)" : "var(--good)"} opacity={0.9}>
                <title>{snap.sealed ? "sealed door — needs Breach" : "breached door"}</title>
              </rect>
            )}
            {!isBlocked && (
              <text x={lx + (isDoor ? 14 : 0)} y={ly - 8} textAnchor="middle" fontSize={11} fill={cost !== undefined && cost < 1 ? "var(--good)" : "var(--muted)"} fontFamily="ui-monospace, monospace">
                {cost !== undefined ? `${cost}s` : ""}
              </text>
            )}
          </g>
        );
      })}

      {/* installed plan as a dashed route */}
      {route.length > 1 && (
        <polyline
          points={route.map(([x, y]) => `${x},${y}`).join(" ")}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2}
          strokeDasharray="6 5"
          opacity={0.8}
        />
      )}

      {/* nodes */}
      {Object.entries(POS).map(([n, [x, y]]) => (
        <g key={n}>
          <circle cx={x} cy={y} r={13} fill="var(--panel-2)" stroke="var(--border)" strokeWidth={1.5} />
          {n === "cover1" && <text x={x} y={y + 4} textAnchor="middle" fontSize={12}>★</text>}
          {n === "rally" && <text x={x} y={y + 4} textAnchor="middle" fontSize={11}>⚑</text>}
          <text x={x} y={y + 30} textAnchor="middle" fontSize={12} fill="var(--muted)">{n}</text>
        </g>
      ))}

      {/* the threat, near the room approach */}
      {threatVisible && (
        <g>
          <circle cx={545} cy={250} r={9} fill="var(--bad)" opacity={0.9} />
          <text x={545} y={276} textAnchor="middle" fontSize={11} fill="var(--bad)">threat</text>
        </g>
      )}
      {snap.threatDown && (
        <g opacity={0.6}>
          <text x={545} y={255} textAnchor="middle" fontSize={14} fill="var(--muted)">✕</text>
          <text x={545} y={276} textAnchor="middle" fontSize={11} fill="var(--muted)">suppressed</text>
        </g>
      )}

      {/* the agent */}
      <g style={{ transition: "transform 450ms ease" }} transform={`translate(${agent[0]}, ${agent[1]})`}>
        {snap.inCover && <circle r={11} fill="none" stroke="var(--good)" strokeWidth={2} opacity={0.9} />}
        <circle r={7} fill="var(--accent)" />
      </g>
    </svg>
  );
}
