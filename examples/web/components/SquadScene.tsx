"use client";
import { Canvas, useFrame } from "@react-three/fiber";
import { GizmoHelper, GizmoViewport, Grid, Html, Line, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { SquadWorld, evaluateSpot, isSoftCover, type SquadFrame, type SquadInstance, type UnitFrame, type SpotEval } from "@scenarios/squad-combat";

const SIDE_COLOR: Record<string, string> = { enemy: "#ef4444", ally: "#3b82f6", player: "#3b82f6" };
const COVER_COLOR = { free: "#6b6051", flank: "#b45309", high: "#6d28d9", breach: "#7c2d12", rally: "#15803d" };
const CHEST = 0.55;
const HOSTILE: Record<string, string[]> = { enemy: ["player", "ally"], ally: ["enemy"], player: ["enemy"] };

function actionIcon(action: string): string {
  if (action.startsWith("firing")) return "🎯";
  if (action.startsWith("suppress")) return "🔥";
  if (action === "flanking") return "↗";
  if (action.includes("high ground")) return "⤴";
  if (action.includes("moving")) return "→";
  if (action.includes("stacking")) return "▮";
  if (action === "breaching") return "💥";
  if (action === "reloading") return "⟳";
  if (action === "falling back") return "⮌";
  if (action === "down") return "✖";
  if (action === "thinking…") return "…";
  return "•";
}

/** Ring colour around a unit's feet, by what it is doing — a quick read of state. */
function stateColor(action: string): string {
  if (action.startsWith("firing")) return "#f97316";
  if (action.startsWith("suppress")) return "#f59e0b";
  if (action === "flanking" || action.includes("moving") || action.includes("repositioning") || action === "stacking on door") return "#38bdf8";
  if (action === "reloading") return "#a78bfa";
  if (action === "falling back") return "#f87171";
  if (action === "breaching" || action === "taking high ground") return "#fb7185";
  return "#64748b";
}

/** green (good / cheap & safe) → red (bad / exposed) for a normalized cost t∈[0,1]. */
function heatColor(t: number): string {
  return new THREE.Color().setHSL((1 - t) * 0.33, 0.85, 0.5).getStyle();
}

interface SceneProps {
  frame: SquadFrame;
  instance: SquadInstance;
  /** the discrete tactical positions the planner scores + chooses among */
  spots?: { name: string; x: number; z: number }[];
  /** score spots against the unit's BELIEF (what it knows) or ground TRUTH */
  heatMode?: "belief" | "truth";
  /** master switch for the whole "what it's thinking" overlay */
  showThinking: boolean;
  selected: string | null;
  onSelect: (name: string) => void;
}

interface Heat {
  evals: Map<string, SpotEval>;
  lo: number;
  hi: number;
}

/** The candidate positions the spot search considers, drawn as floor markers. When a
 *  unit is selected they become a POTENTIAL FIELD: each dot is tinted by that unit's
 *  risk/reward at that spot (green = cheap, safe firing position → red = exposed),
 *  grey = no line of fire. The dot the unit is moving to lights up cyan — the choice
 *  the search just made. The field shifts live as enemies move. */
function TacticalSpots({ spots, chosen, heat }: { spots: { name: string; x: number; z: number }[]; chosen: string | null; heat: Heat | null }) {
  return (
    <group>
      {spots.map((s) => {
        if (s.name === chosen) {
          return (
            <mesh key={s.name} rotation={[-Math.PI / 2, 0, 0]} position={[s.x, 0.02, s.z]}>
              <circleGeometry args={[0.34, 24]} />
              <meshBasicMaterial color="#38bdf8" transparent opacity={0.9} side={THREE.DoubleSide} />
            </mesh>
          );
        }
        let color = "#3b4763";
        let opacity = 0.26;
        let r = 0.12;
        const e = heat?.evals.get(s.name);
        if (e) {
          if (!e.firing) {
            color = "#2b3447";
            opacity = 0.2;
            r = 0.11;
          } else {
            const t = heat && heat.hi > heat.lo ? (e.cost - heat.lo) / (heat.hi - heat.lo) : 0;
            color = heatColor(t);
            opacity = 0.82;
            r = 0.22;
          }
        }
        return (
          <mesh key={s.name} rotation={[-Math.PI / 2, 0, 0]} position={[s.x, 0.015, s.z]}>
            <circleGeometry args={[r, 12]} />
            <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} />
          </mesh>
        );
      })}
    </group>
  );
}

function unitPos(u: UnitFrame): THREE.Vector3 {
  return new THREE.Vector3(u.x, u.elevation * 0.6 + 0.45, u.z);
}

/** A bright tracer beam from shooter to target, with a round travelling along it,
 *  a pulsing muzzle flash + a flickering muzzle light. */
function FireBeam({ from, to, kind, color }: { from: THREE.Vector3; to: THREE.Vector3; kind: string; color: string }) {
  const round = useRef<THREE.Mesh>(null);
  const flash = useRef<THREE.Mesh>(null);
  const light = useRef<THREE.PointLight>(null);
  const a = useMemo(() => from.clone().setY(from.y + CHEST), [from]);
  const b = useMemo(() => to.clone().setY(to.y + CHEST), [to]);
  useFrame((state) => {
    const t = (state.clock.elapsedTime * (kind === "suppress" ? 1.4 : 3)) % 1;
    if (round.current) round.current.position.lerpVectors(a, b, t);
    const f = 0.5 + 0.5 * Math.abs(Math.sin(state.clock.elapsedTime * (kind === "suppress" ? 9 : 22)));
    if (flash.current) flash.current.scale.setScalar(0.7 + f * 0.9);
    if (light.current) light.current.intensity = (kind === "suppress" ? 1.2 : 2.6) * f;
  });
  const beamColor = kind === "suppress" ? "#f59e0b" : kind === "breach" ? "#f43f5e" : color;
  return (
    <group>
      <Line points={[a, b]} color={beamColor} lineWidth={kind === "suppress" ? 3 : 2} transparent opacity={kind === "suppress" ? 0.4 : 0.75} dashed={kind === "suppress"} dashSize={0.3} gapSize={0.2} />
      <mesh ref={round}>
        <sphereGeometry args={[0.09, 8, 8]} />
        <meshBasicMaterial color={beamColor} />
      </mesh>
      <group position={a.toArray()}>
        <mesh ref={flash}>
          <sphereGeometry args={[0.18, 10, 10]} />
          <meshBasicMaterial color="#fff7d6" transparent opacity={0.85} />
        </mesh>
        <mesh>
          <sphereGeometry args={[0.13, 8, 8]} />
          <meshBasicMaterial color={beamColor} transparent opacity={0.6} />
        </mesh>
        <pointLight ref={light} color={beamColor} distance={4} decay={2} intensity={2} />
      </group>
    </group>
  );
}

/** A transient hit effect: a spray of blood/sparks that pops out and falls away. */
interface Impact {
  pos: THREE.Vector3;
  born: number;
  lethal: boolean;
  side: string;
}
const PARTICLES = 9;
function Impacts({ impactsRef }: { impactsRef: React.MutableRefObject<Impact[]> }) {
  const group = useRef<THREE.Group>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const meshes = useRef<(THREE.InstancedMesh | null)[]>([]);
  const POOL = 10;
  const seeds = useMemo(
    () =>
      Array.from({ length: POOL }, () =>
        Array.from({ length: PARTICLES }, () => ({
          dir: new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.2, Math.random() - 0.5).normalize(),
          spd: 1.4 + Math.random() * 2.2,
        })),
      ),
    [],
  );
  useFrame((state) => {
    const now = state.clock.elapsedTime;
    const live = impactsRef.current;
    while (live.length && now - live[0].born > 0.9) live.shift();
    if (live.length > POOL) live.splice(0, live.length - POOL);
    for (let i = 0; i < POOL; i++) {
      const m = meshes.current[i];
      if (!m) continue;
      const imp = live[i];
      if (!imp) { m.visible = false; continue; }
      m.visible = true;
      const age = now - imp.born;
      const k = Math.min(1, age / 0.9);
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.opacity = (1 - k) * 0.95;
      m.position.copy(imp.pos);
      const s = seeds[i];
      for (let p = 0; p < PARTICLES; p++) {
        const sd = s[p];
        const rr = sd.spd * age;
        dummy.position.set(sd.dir.x * rr, sd.dir.y * rr - 2.2 * age * age, sd.dir.z * rr);
        const sc = (imp.lethal ? 0.14 : 0.08) * (1 - k * 0.6);
        dummy.scale.setScalar(Math.max(0.001, sc));
        dummy.updateMatrix();
        m.setMatrixAt(p, dummy.matrix);
      }
      m.instanceMatrix.needsUpdate = true;
    }
  });
  return (
    <group ref={group}>
      {Array.from({ length: POOL }, (_, i) => (
        <instancedMesh key={i} ref={(el) => { meshes.current[i] = el; }} args={[undefined as unknown as THREE.BufferGeometry, undefined as unknown as THREE.Material, PARTICLES]} visible={false}>
          <sphereGeometry args={[1, 6, 6]} />
          <meshBasicMaterial color="#b91c1c" transparent opacity={0.9} />
        </instancedMesh>
      ))}
    </group>
  );
}

function Unit({
  u,
  target,
  inCover,
  suppressed,
  selected,
  onSelect,
}: {
  u: UnitFrame;
  target: THREE.Vector3 | null;
  inCover: boolean;
  suppressed: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const pulse = useRef<THREE.Mesh>(null);
  const dest = useMemo(() => unitPos(u), [u]);
  const crouch = inCover && u.alive && !/moving|flanking|repositioning|falling|stacking/.test(u.action);
  useFrame((state, dt) => {
    const g = ref.current;
    if (!g) return;
    g.position.lerp(dest, 1 - Math.pow(0.0015, Math.min(dt, 0.05)));
    if (target) {
      const dir = Math.atan2(target.x - g.position.x, target.z - g.position.z);
      g.rotation.y += (dir - g.rotation.y) * Math.min(1, dt * 8);
    }
    if (body.current) {
      const ty = crouch ? -0.16 : 0;
      const ts = crouch ? 0.82 : 1;
      body.current.position.y += (ty - body.current.position.y) * Math.min(1, dt * 8);
      body.current.scale.y += (ts - body.current.scale.y) * Math.min(1, dt * 8);
    }
    if (pulse.current && suppressed) {
      const s = 0.7 + 0.25 * Math.abs(Math.sin(state.clock.elapsedTime * 7));
      pulse.current.scale.setScalar(s);
    }
  });
  const color = SIDE_COLOR[u.side] ?? "#94a3b8";
  const hpFrac = Math.max(0, Math.min(1, u.hp / 100));
  return (
    <group ref={ref} position={dest.toArray()}>
      <group ref={body}>
        <mesh castShadow onClick={(e) => { e.stopPropagation(); onSelect(); }}>
          <capsuleGeometry args={[0.32, 0.5, 6, 14]} />
          <meshStandardMaterial color={u.alive ? color : "#3a3f4b"} emissive={u.alive ? color : "#000"} emissiveIntensity={selected ? 0.7 : 0.25} roughness={0.5} transparent opacity={u.alive ? 1 : 0.3} />
        </mesh>
        {u.alive && (
          <mesh position={[0, 0.15, 0.42]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.05, 0.05, 0.5, 8]} />
            <meshStandardMaterial color="#1f2630" />
          </mesh>
        )}
        {crouch && (
          <mesh position={[0, 0.05, 0.46]} rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.34, 0.05, 8, 16, Math.PI]} />
            <meshBasicMaterial color="#38bdf8" transparent opacity={0.85} side={THREE.DoubleSide} />
          </mesh>
        )}
      </group>
      {u.alive && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.74, 0]}>
          <ringGeometry args={[0.42, 0.54, 28]} />
          <meshBasicMaterial color={stateColor(u.action)} side={THREE.DoubleSide} transparent opacity={0.9} />
        </mesh>
      )}
      {u.alive && suppressed && (
        <mesh ref={pulse} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.72, 0]}>
          <ringGeometry args={[0.6, 0.78, 28]} />
          <meshBasicMaterial color="#f59e0b" side={THREE.DoubleSide} transparent opacity={0.5} />
        </mesh>
      )}
      {selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.78, 0]}>
          <ringGeometry args={[0.6, 0.78, 32]} />
          <meshBasicMaterial color="#e2e8f0" side={THREE.DoubleSide} />
        </mesh>
      )}
      {u.alive && (
        <group position={[0, 1.0, 0]}>
          <mesh position={[0, 0, -0.01]}>
            <boxGeometry args={[0.82, 0.12, 0.04]} />
            <meshBasicMaterial color="#0b0e14" />
          </mesh>
          <mesh position={[-(1 - hpFrac) * 0.4, 0, 0]} scale={[Math.max(0.001, hpFrac), 1, 1]}>
            <boxGeometry args={[0.8, 0.1, 0.05]} />
            <meshBasicMaterial color={hpFrac > 0.5 ? "#22c55e" : hpFrac > 0.25 ? "#f59e0b" : "#ef4444"} />
          </mesh>
        </group>
      )}
      <Html position={[0, 1.5, 0]} center distanceFactor={13} style={{ pointerEvents: "none", userSelect: "none" }}>
        <div style={{ textAlign: "center", fontFamily: "ui-monospace, monospace", whiteSpace: "nowrap" }}>
          <div style={{ fontSize: 11, color, fontWeight: 700 }}>
            {u.name}
            {u.side !== "player" && <span style={{ color: "#9aa4b8", fontWeight: 400 }}> · {u.role}</span>}
          </div>
          <div
            style={{
              marginTop: 2,
              fontSize: 10,
              color: "#0b0e14",
              background: u.alive ? color : "#3a3f4b",
              borderRadius: 6,
              padding: "1px 7px",
              display: "inline-block",
              fontWeight: 600,
            }}
          >
            {actionIcon(u.action)} {u.action}
          </div>
          {u.alive && crouch && <div style={{ marginTop: 2, fontSize: 9, color: "#7dd3fc" }}>🛡 in cover</div>}
          {u.alive && suppressed && <div style={{ marginTop: 2, fontSize: 9, color: "#fbbf24" }}>⚠ pinned</div>}
          {selected && u.alive && (
            <div style={{ marginTop: 2, display: "flex", gap: 2, justifyContent: "center" }}>
              {Array.from({ length: 8 }, (_, i) => (
                <span key={i} style={{ width: 4, height: 8, borderRadius: 1, background: i < u.ammo ? "#e2e8f0" : "#3a3f4b" }} />
              ))}
            </div>
          )}
        </div>
      </Html>
    </group>
  );
}

/** A soft-cover crate — a half-height sandbag/crate you fight FROM beside. */
function CoverCrate({ x, z, color, ownerColor }: { x: number; z: number; color: string; ownerColor: string | null }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.16, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.98, 0.32, 0.56]} />
        <meshStandardMaterial color={color} roughness={0.96} metalness={0.02} />
      </mesh>
      <mesh position={[-0.22, 0.4, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <capsuleGeometry args={[0.12, 0.34, 4, 8]} />
        <meshStandardMaterial color={color} roughness={1} />
      </mesh>
      <mesh position={[0.22, 0.4, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <capsuleGeometry args={[0.12, 0.34, 4, 8]} />
        <meshStandardMaterial color={color} roughness={1} />
      </mesh>
      {ownerColor && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
          <ringGeometry args={[0.62, 0.76, 24]} />
          <meshBasicMaterial color={ownerColor} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}

/** A maneuver anchor (flank / high / breach / rally) — an open marked spot, NOT a
 *  fire-blocking crate. Drawn as a flat painted ring + a thin post so it is clearly
 *  "a position to reach", distinct from a crate that stops bullets. */
function Anchor({ x, z, kind, color, ownerColor }: { x: number; z: number; kind: string; color: string; ownerColor: string | null }) {
  const label = kind === "flank" ? "flank" : kind === "high" ? "high ground" : kind === "breach" ? "breach" : "rally";
  return (
    <group position={[x, 0, z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[0.34, 0.5, 24]} />
        <meshBasicMaterial color={color} side={THREE.DoubleSide} transparent opacity={0.85} />
      </mesh>
      <mesh position={[0, 0.45, 0]}>
        <cylinderGeometry args={[0.03, 0.03, 0.9, 6]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[0.13, 0.78, 0]}>
        <boxGeometry args={[0.26, 0.16, 0.02]} />
        <meshBasicMaterial color={color} side={THREE.DoubleSide} />
      </mesh>
      {ownerColor && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
          <ringGeometry args={[0.54, 0.66, 24]} />
          <meshBasicMaterial color={ownerColor} side={THREE.DoubleSide} />
        </mesh>
      )}
      <Html position={[0, 1.0, 0]} center distanceFactor={20} style={{ pointerEvents: "none" }}>
        <div style={{ fontSize: 8, color, fontFamily: "monospace", opacity: 0.85, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      </Html>
    </group>
  );
}

function Wall({ x, z, w, d, door, broken }: { x: number; z: number; w: number; d: number; door?: boolean; broken?: boolean }) {
  const cx = x + w / 2;
  const cz = z + d / 2;
  if (door) {
    if (broken) {
      return (
        <mesh position={[cx, 0.08, cz]} receiveShadow>
          <boxGeometry args={[w, 0.16, d]} />
          <meshStandardMaterial color="#241712" roughness={1} />
        </mesh>
      );
    }
    return (
      <group position={[cx, 0, cz]}>
        <mesh position={[0, 1.0, 0]} castShadow>
          <boxGeometry args={[w, 2.0, d]} />
          <meshStandardMaterial color="#7c2d12" emissive="#3a1206" emissiveIntensity={0.4} roughness={0.7} />
        </mesh>
        <Html position={[0, 2.5, 0]} center distanceFactor={18} style={{ pointerEvents: "none" }}>
          <div style={{ fontSize: 9, color: "#fbbf24", fontFamily: "monospace", background: "rgba(11,14,20,0.7)", padding: "1px 6px", borderRadius: 4 }}>DOOR</div>
        </Html>
      </group>
    );
  }
  return (
    <mesh position={[cx, 1.1, cz]} castShadow receiveShadow>
      <boxGeometry args={[w, 2.2, d]} />
      <meshStandardMaterial color="#161c28" roughness={0.95} />
    </mesh>
  );
}

/** Where the selected unit BELIEVES the enemy is, when that diverges from reality —
 *  a translucent "ghost" at the last-known position with a dotted leash to the real
 *  position. Makes stale belief (a unit acting on outdated info, getting flanked)
 *  visible: the unit plans/scores against the ghost, not the truth. */
function BeliefGhosts({ believed, actual, color }: { believed: { x: number; z: number }[]; actual: { x: number; z: number }[]; color: string }) {
  return (
    <group>
      {believed.map((b, i) => {
        let nearest = Infinity;
        let near: { x: number; z: number } | null = null;
        for (const a of actual) {
          const d = Math.hypot(a.x - b.x, a.z - b.z);
          if (d < nearest) { nearest = d; near = a; }
        }
        if (nearest <= 1.4) return null; // belief matches reality → nothing to show
        const g = new THREE.Vector3(b.x, 0.45, b.z);
        return (
          <group key={i}>
            <mesh position={[b.x, 0.45 + CHEST, b.z]}>
              <sphereGeometry args={[0.34, 12, 12]} />
              <meshBasicMaterial color={color} transparent opacity={0.22} />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[b.x, 0.02, b.z]}>
              <ringGeometry args={[0.42, 0.54, 24]} />
              <meshBasicMaterial color={color} transparent opacity={0.4} side={THREE.DoubleSide} />
            </mesh>
            {near && (
              <Line points={[g.clone().setY(0.05), new THREE.Vector3(near.x, 0.05, near.z)]} color={color} lineWidth={1} dashed dashSize={0.12} gapSize={0.12} transparent opacity={0.4} />
            )}
            <Html position={[b.x, 1.1, b.z]} center distanceFactor={18} style={{ pointerEvents: "none" }}>
              <div style={{ fontSize: 8, color, fontFamily: "monospace", opacity: 0.8, whiteSpace: "nowrap" }}>thinks enemy here</div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

/** The selected unit's line of sight to its target — green if it has a shot, red if blocked. */
function SightLine({ from, to, hasShot }: { from: THREE.Vector3; to: THREE.Vector3; hasShot: boolean }) {
  const a = from.clone().setY(from.y + CHEST);
  const b = to.clone().setY(to.y + CHEST);
  return (
    <>
      <Line points={[a, b]} color={hasShot ? "#34d399" : "#ef4444"} lineWidth={1.5} dashed dashSize={0.25} gapSize={0.18} transparent opacity={0.85} />
      <Html position={a.clone().lerp(b, 0.5).toArray()} center distanceFactor={16} style={{ pointerEvents: "none" }}>
        <div style={{ fontSize: 9, color: hasShot ? "#34d399" : "#ef4444", fontFamily: "monospace", background: "rgba(11,14,20,0.7)", padding: "1px 5px", borderRadius: 5, whiteSpace: "nowrap" }}>
          {hasShot ? "line of fire" : "no line of fire → repositioning"}
        </div>
      </Html>
    </>
  );
}

function nearestHostileFrame(frame: SquadFrame, self: UnitFrame): UnitFrame | null {
  let best: UnitFrame | null = null;
  let bestD = Infinity;
  for (const h of frame.units) {
    if (!h.alive || !(HOSTILE[self.side] ?? []).includes(h.side)) continue;
    const d = Math.hypot(h.x - self.x, h.z - self.z);
    if (d < bestD) { bestD = d; best = h; }
  }
  return best;
}

function Scene({ frame, instance, spots = [], heatMode = "belief", showThinking, selected, onSelect }: SceneProps) {
  const center = useMemo<[number, number, number]>(() => {
    const xs = instance.units.map((u) => u.x).concat(instance.covers.map((c) => c.x));
    const zs = instance.units.map((u) => u.z).concat(instance.covers.map((c) => c.z));
    return [(Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2];
  }, [instance]);

  const byName = useMemo(() => {
    const m = new Map<string, UnitFrame>();
    for (const u of frame.units) m.set(u.name, u);
    return m;
  }, [frame]);

  // geometry-only world (walls + crates) for line-of-sight / cover / exposure queries —
  // the library's own primitives, rebuilt only when the map changes. Positions are
  // always passed in explicitly (from the current frame), so it needs no per-tick sync.
  const world = useMemo(() => new SquadWorld(instance), [instance]);

  // which units are tucked behind a crate vs. their nearest real threat (so they crouch)
  const coverSet = useMemo(() => {
    const s = new Set<string>();
    for (const u of frame.units) {
      if (!u.alive) continue;
      const t = nearestHostileFrame(frame, u);
      if (t && world.inCoverVs(u.x, u.z, t.x, t.z)) s.add(u.name);
    }
    return s;
  }, [frame, world]);

  // who is being suppressed (an enemy is laying suppressing fire on them this beat)
  const suppressedSet = useMemo(() => {
    const s = new Set<string>();
    for (const u of frame.units) if (u.alive && u.firingKind === "suppress" && u.firingAt) s.add(u.firingAt);
    return s;
  }, [frame]);

  const sel = selected ? byName.get(selected) : undefined;
  const selTarget = useMemo(() => (sel && sel.alive ? nearestHostileFrame(frame, sel) : null), [sel, frame]);

  // the potential field FOR THE SELECTED UNIT: score every candidate spot by its
  // risk/reward (the SAME cost the planner optimises). "belief" = against what the unit
  // KNOWS (the positions it actually plans against); "truth" = against the enemies' real
  // positions. Either way it shifts as the fight moves.
  const heat = useMemo<Heat | null>(() => {
    if (!sel || !sel.alive || spots.length === 0) return null;
    const threat = heatMode === "belief" ? sel.believedThreat : selTarget ? { x: selTarget.x, z: selTarget.z } : null;
    if (!threat) return null;
    const foes =
      heatMode === "belief"
        ? sel.believedFoes
        : frame.units.filter((u) => u.alive && (HOSTILE[sel.side] ?? []).includes(u.side)).map((u) => ({ x: u.x, z: u.z }));
    const evals = new Map<string, SpotEval>();
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of spots) {
      const e = evaluateSpot(world, s.x, s.z, threat, foes);
      evals.set(s.name, e);
      if (e.firing) { lo = Math.min(lo, e.cost); hi = Math.max(hi, e.cost); }
    }
    return { evals, lo, hi };
  }, [sel, selTarget, spots, frame, world, heatMode]);

  // the spot the selected unit is currently moving to — parsed from its plan step
  const chosenSpot = useMemo(() => {
    if (!sel || !sel.alive) return null;
    const m = /\((\w+)\)/.exec(sel.step ?? "");
    return m ? m[1] : null;
  }, [sel]);
  const chosenPos = useMemo(() => {
    if (!chosenSpot) return null;
    const s = spots.find((p) => p.name === chosenSpot) ?? instance.covers.find((c) => c.name === chosenSpot);
    return s ? new THREE.Vector3(s.x, 0.05, s.z) : null;
  }, [chosenSpot, spots, instance]);

  // enemies that currently have a line of fire on the selected unit (incoming risk)
  const incoming = useMemo(() => {
    if (!sel || !sel.alive) return [];
    return frame.units.filter(
      (e) => e.alive && (HOSTILE[sel.side] ?? []).includes(e.side) && Math.hypot(e.x - sel.x, e.z - sel.z) <= 22 && world.losClear(e.x, e.z, sel.x, sel.z),
    );
  }, [sel, frame, world]);

  // transient blood/impact effects, fed by per-unit HP drops between frames
  const impactsRef = useRef<Impact[]>([]);
  const prevHp = useRef<Map<string, number>>(new Map());
  const clockRef = useRef(0);
  useEffect(() => {
    for (const u of frame.units) {
      const prev = prevHp.current.get(u.name);
      if (prev != null && u.hp < prev - 0.5) {
        impactsRef.current.push({ pos: unitPos(u).clone(), born: clockRef.current, lethal: !u.alive, side: u.side });
      }
      prevHp.current.set(u.name, u.hp);
    }
  }, [frame]);

  const selPos = sel && sel.alive ? unitPos(sel) : null;

  return (
    <>
      <PerspectiveCamera makeDefault position={[center[0], 20, center[2] + 13]} fov={40} />
      <OrbitControls target={[center[0], 0, center[2]]} enablePan minDistance={8} maxDistance={52} maxPolarAngle={Math.PI / 2.1} />
      <ambientLight intensity={0.65} />
      <directionalLight position={[8, 16, 6]} intensity={1.1} castShadow shadow-mapSize={[1024, 1024]} />
      <hemisphereLight args={["#9db7ff", "#0b0e14", 0.4]} />
      <ClockSync clockRef={clockRef} />

      <Grid args={[90, 90]} position={[center[0], 0, center[2]]} cellColor="#1c2436" sectionColor="#283350" fadeDistance={70} infiniteGrid />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[center[0], -0.01, center[2]]} onClick={() => onSelect("")}>
        <planeGeometry args={[240, 240]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>

      {(instance.walls ?? []).map((w, i) => (
        <Wall key={i} {...w} broken={frame.doorBroken} />
      ))}

      {/* the discrete candidate positions the planner scores each beat (heat field) */}
      {showThinking && <TacticalSpots spots={spots} chosen={chosenSpot} heat={heat} />}

      {/* the move the SELECTED unit's search just committed to (unit → chosen spot) */}
      {showThinking && sel && sel.alive && chosenPos && (
        <Line points={[unitPos(sel).setY(0.05), chosenPos]} color="#38bdf8" lineWidth={1.5} dashed dashSize={0.3} gapSize={0.2} transparent opacity={0.8} />
      )}

      {instance.covers.map((c) => {
        const owner = frame.reservations[c.name] ?? null;
        const oc = owner ? SIDE_COLOR[byName.get(owner)?.side ?? ""] ?? "#e2e8f0" : null;
        if (isSoftCover(c)) return <CoverCrate key={c.name} x={c.x} z={c.z} color={COVER_COLOR.free} ownerColor={oc} />;
        const kind = c.breach ? "breach" : c.flank ? "flank" : c.high ? "high" : "rally";
        return <Anchor key={c.name} x={c.x} z={c.z} kind={kind} color={COVER_COLOR[kind as keyof typeof COVER_COLOR]} ownerColor={oc} />;
      })}

      {/* fire beams for every unit currently shooting */}
      {frame.units.map((u) => {
        if (!u.alive || !u.firingAt) return null;
        const t = byName.get(u.firingAt);
        if (!t) return null;
        return <FireBeam key={`beam-${u.name}`} from={unitPos(u)} to={unitPos(t)} kind={u.firingKind ?? "shot"} color={SIDE_COLOR[u.side] ?? "#fff"} />;
      })}

      {/* selected unit's awareness overlay: sight-range ring, line of fire, incoming guns */}
      {showThinking && sel && sel.alive && selPos && (
        <group>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[sel.x, 0.012, sel.z]}>
            <ringGeometry args={[21.5, 22, 64]} />
            <meshBasicMaterial color="#38bdf8" transparent opacity={0.45} side={THREE.DoubleSide} />
          </mesh>
          {selTarget && <SightLine from={selPos} to={unitPos(selTarget)} hasShot={sel.sees === selTarget.name} />}
          <BeliefGhosts
            believed={sel.believedFoes}
            actual={frame.units.filter((e) => e.alive && (HOSTILE[sel.side] ?? []).includes(e.side)).map((e) => ({ x: e.x, z: e.z }))}
            color={SIDE_COLOR[(HOSTILE[sel.side] ?? [])[0] ?? ""] ?? "#ef4444"}
          />
          {incoming.map((e) => (
            <Line
              key={`in-${e.name}`}
              points={[unitPos(e).clone().setY(unitPos(e).y + CHEST), selPos.clone().setY(selPos.y + CHEST)]}
              color="#ef4444"
              lineWidth={1.5}
              dashed
              dashSize={0.15}
              gapSize={0.12}
              transparent
              opacity={0.5}
            />
          ))}
          {incoming.length > 0 && (
            <Html position={[sel.x, 2.2, sel.z]} center distanceFactor={16} style={{ pointerEvents: "none" }}>
              <div style={{ fontSize: 9, color: "#fca5a5", fontFamily: "monospace", background: "rgba(11,14,20,0.75)", padding: "1px 6px", borderRadius: 5, whiteSpace: "nowrap" }}>
                ⚠ {incoming.length} enemy gun{incoming.length > 1 ? "s" : ""} on me
              </div>
            </Html>
          )}
        </group>
      )}

      {frame.units.map((u) => {
        const aimAt = u.firingAt ? byName.get(u.firingAt) : u.sees ? byName.get(u.sees) : null;
        return (
          <Unit
            key={u.name}
            u={u}
            target={aimAt ? unitPos(aimAt) : null}
            inCover={coverSet.has(u.name)}
            suppressed={suppressedSet.has(u.name)}
            selected={selected === u.name}
            onSelect={() => onSelect(u.name)}
          />
        );
      })}

      <Impacts impactsRef={impactsRef} />

      <GizmoHelper alignment="bottom-right" margin={[56, 56]}>
        <GizmoViewport axisColors={["#f87171", "#34d399", "#38bdf8"]} labelColor="#0b0e14" />
      </GizmoHelper>
    </>
  );
}

/** Keeps a ref in sync with the render clock so frame-driven effects share a timebase. */
function ClockSync({ clockRef }: { clockRef: React.MutableRefObject<number> }) {
  useFrame((state) => { clockRef.current = state.clock.elapsedTime; });
  return null;
}

export default function SquadScene(props: SceneProps) {
  return (
    <Canvas shadows dpr={[1, 2]} gl={{ antialias: true }} style={{ background: "linear-gradient(180deg,#0d1320,#0b0e14)" }}>
      <Scene {...props} />
    </Canvas>
  );
}
