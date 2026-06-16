"use client";
import { Canvas, useFrame } from "@react-three/fiber";
import { GizmoHelper, GizmoViewport, Grid, Html, Instance, Instances, Line, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { SquadFrame, SquadInstance, UnitFrame, Vec2 } from "@scenarios/squad-combat";

const SIDE_COLOR: Record<string, string> = { enemy: "#ef4444", ally: "#3b82f6", player: "#3b82f6" };
const CHEST = 0.55;
const HOSTILE: Record<string, string[]> = { enemy: ["player", "ally"], ally: ["enemy"], player: ["enemy"] };

function actionIcon(action: string): string {
  if (action.startsWith("firing")) return "🎯";
  if (action.includes("moving up")) return "→";
  if (action === "breaching") return "💥";
  if (action === "reloading") return "⟳";
  if (action === "falling back") return "⮌";
  if (action === "down") return "✖";
  if (action.includes("reading the room")) return "…";
  if (action.includes("angle")) return "🔍";
  return "•";
}

interface SceneProps {
  frame: SquadFrame;
  instance: SquadInstance;
  selected: string | null;
  onSelect: (name: string) => void;
}

function unitPos(u: UnitFrame): THREE.Vector3 {
  return new THREE.Vector3(u.x, u.elevation * 0.6 + 0.45, u.z);
}

/** A bright tracer beam from shooter to target, with a round travelling along it. */
function FireBeam({ from, to, kind, color }: { from: THREE.Vector3; to: THREE.Vector3; kind: string; color: string }) {
  const round = useRef<THREE.Mesh>(null);
  const a = useMemo(() => from.clone().setY(from.y + CHEST), [from]);
  const b = useMemo(() => to.clone().setY(to.y + CHEST), [to]);
  useFrame((state) => {
    const m = round.current;
    if (!m) return;
    const t = (state.clock.elapsedTime * 3) % 1;
    m.position.lerpVectors(a, b, t);
  });
  const beamColor = kind === "breach" ? "#f43f5e" : color;
  return (
    <group>
      <Line points={[a, b]} color={beamColor} lineWidth={2} transparent opacity={0.7} />
      <mesh ref={round}>
        <sphereGeometry args={[0.09, 8, 8]} />
        <meshBasicMaterial color={beamColor} />
      </mesh>
      <mesh position={a}>
        <sphereGeometry args={[0.16, 8, 8]} />
        <meshBasicMaterial color={beamColor} transparent opacity={0.5} />
      </mesh>
    </group>
  );
}

/** The selected unit's line of sight to its target — green if it has a shot, red if blocked. */
function SightLine({ from, to, hasShot }: { from: THREE.Vector3; to: THREE.Vector3; hasShot: boolean }) {
  const a = from.clone().setY(from.y + CHEST);
  const b = to.clone().setY(to.y + CHEST);
  return (
    <>
      <Line points={[a, b]} color={hasShot ? "#34d399" : "#ef4444"} lineWidth={1.5} dashed dashSize={0.25} gapSize={0.18} transparent opacity={0.8} />
      <Html position={a.clone().lerp(b, 0.5).toArray()} center distanceFactor={16} style={{ pointerEvents: "none" }}>
        <div style={{ fontSize: 9, color: hasShot ? "#34d399" : "#ef4444", fontFamily: "monospace", background: "rgba(11,14,20,0.7)", padding: "1px 5px", borderRadius: 5, whiteSpace: "nowrap" }}>
          {hasShot ? "line of fire" : "no line of fire → repositioning"}
        </div>
      </Html>
    </>
  );
}

/** The searched, multi-step covered approach a unit is executing — the headline. The
 *  selected unit's route is bright; everyone else's is a faint trail, so you can watch
 *  the whole squad manoeuvre. */
function Route({ from, route, color, bright }: { from: THREE.Vector3; route: Vec2[]; color: string; bright: boolean }) {
  if (route.length === 0) return null;
  const pts = [new THREE.Vector3(from.x, 0.12, from.z), ...route.map((p) => new THREE.Vector3(p.x, 0.12, p.z))];
  return (
    <>
      <Line points={pts} color={color} lineWidth={bright ? 3 : 1.5} dashed dashSize={0.4} gapSize={0.25} transparent opacity={bright ? 0.95 : 0.3} />
      {bright &&
        route.map((p, i) => (
          <mesh key={i} position={[p.x, 0.12, p.z]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[0.16, 16]} />
            <meshBasicMaterial color={color} transparent opacity={0.8} side={THREE.DoubleSide} />
          </mesh>
        ))}
    </>
  );
}

function Unit({ u, target, selected, onSelect }: { u: UnitFrame; target: THREE.Vector3 | null; selected: boolean; onSelect: () => void }) {
  const ref = useRef<THREE.Group>(null);
  const dest = useMemo(() => unitPos(u), [u]);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    g.position.lerp(dest, 1 - Math.pow(0.0015, Math.min(dt, 0.05)));
    if (target) {
      const dir = Math.atan2(target.x - g.position.x, target.z - g.position.z);
      g.rotation.y += (dir - g.rotation.y) * Math.min(1, dt * 8);
    }
  });
  const color = SIDE_COLOR[u.side] ?? "#94a3b8";
  const hpFrac = Math.max(0, Math.min(1, u.hp / 100));
  return (
    <group ref={ref} position={dest.toArray()}>
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
      {selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.78, 0]}>
          <ringGeometry args={[0.55, 0.72, 32]} />
          <meshBasicMaterial color="#e2e8f0" side={THREE.DoubleSide} />
        </mesh>
      )}
      {u.alive && (
        <mesh position={[-(1 - hpFrac) * 0.4, 1.0, 0]} scale={[Math.max(0.001, hpFrac), 1, 1]}>
          <boxGeometry args={[0.8, 0.1, 0.05]} />
          <meshBasicMaterial color={hpFrac > 0.5 ? "#22c55e" : hpFrac > 0.25 ? "#f59e0b" : "#ef4444"} />
        </mesh>
      )}
      <Html position={[0, 1.5, 0]} center distanceFactor={13} style={{ pointerEvents: "none", userSelect: "none" }}>
        <div style={{ textAlign: "center", fontFamily: "ui-monospace, monospace", whiteSpace: "nowrap" }}>
          <div style={{ fontSize: 11, color, fontWeight: 700 }}>{u.name}</div>
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
        </div>
      </Html>
    </group>
  );
}

/** Full-height wall (blocks sight + movement) or, when `half`, a low half-cover crate
 *  you path AROUND and tuck behind for a directional accuracy edge. */
function Wall({ x, z, w, d, door, half, broken }: { x: number; z: number; w: number; d: number; door?: boolean; half?: boolean; broken?: boolean }) {
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
  if (half) {
    // chest-high cover: you don't stand on it, you tuck beside it
    return (
      <mesh position={[cx, 0.4, cz]} castShadow receiveShadow>
        <boxGeometry args={[w, 0.8, d]} />
        <meshStandardMaterial color="#6b5b3e" roughness={0.95} metalness={0.02} />
      </mesh>
    );
  }
  return (
    <mesh position={[cx, 1.1, cz]} castShadow receiveShadow>
      <boxGeometry args={[w, 2.2, d]} />
      <meshStandardMaterial color="#161c28" roughness={0.95} />
    </mesh>
  );
}

function Scene({ frame, instance, selected, onSelect }: SceneProps) {
  const center = useMemo<[number, number, number]>(() => {
    const xs = instance.units.map((u) => u.x).concat((instance.walls ?? []).flatMap((w) => [w.x, w.x + w.w]));
    const zs = instance.units.map((u) => u.z).concat((instance.walls ?? []).flatMap((w) => [w.z, w.z + w.d]));
    return [(Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2];
  }, [instance]);

  const byName = useMemo(() => {
    const m = new Map<string, UnitFrame>();
    for (const u of frame.units) m.set(u.name, u);
    return m;
  }, [frame]);

  // plain cells vs. tagged rally/breach cells (the static grid the AI searches over)
  const plainCells = useMemo(() => frame.cells.filter((c) => !c.rally && !c.breach), [frame.cells]);
  const rallyCells = useMemo(() => frame.cells.filter((c) => c.rally), [frame.cells]);
  const breachCells = useMemo(() => frame.cells.filter((c) => c.breach), [frame.cells]);

  const sel = selected ? byName.get(selected) : undefined;
  const selTarget = useMemo(() => {
    if (!sel || !sel.alive) return undefined;
    const hostiles = frame.units.filter((u) => u.alive && (HOSTILE[sel.side] ?? []).includes(u.side));
    let best: UnitFrame | undefined;
    let bestD = Infinity;
    for (const h of hostiles) {
      const d = Math.hypot(h.x - sel.x, h.z - sel.z);
      if (d < bestD) { bestD = d; best = h; }
    }
    return best;
  }, [sel, frame]);

  return (
    <>
      <PerspectiveCamera makeDefault position={[center[0], 22, center[2] + 15]} fov={40} />
      <OrbitControls target={[center[0], 0, center[2]]} enablePan minDistance={8} maxDistance={60} maxPolarAngle={Math.PI / 2.1} />
      <ambientLight intensity={0.65} />
      <directionalLight position={[8, 16, 6]} intensity={1.1} castShadow shadow-mapSize={[1024, 1024]} />
      <hemisphereLight args={["#9db7ff", "#0b0e14", 0.4]} />

      <Grid args={[90, 90]} position={[center[0], 0, center[2]]} cellColor="#1c2436" sectionColor="#283350" fadeDistance={75} infiniteGrid />

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[center[0], -0.01, center[2]]} onClick={() => onSelect("")}>
        <planeGeometry args={[260, 260]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>

      {/* the fluid position grid the planner searches over — faint dots, with rally /
          breach cells called out */}
      {plainCells.length > 0 && (
        <Instances limit={plainCells.length} range={plainCells.length}>
          <circleGeometry args={[0.1, 10]} />
          <meshBasicMaterial color="#33405e" transparent opacity={0.45} side={THREE.DoubleSide} />
          {plainCells.map((c) => (
            <Instance key={c.name} position={[c.x, 0.015, c.z]} rotation={[-Math.PI / 2, 0, 0]} />
          ))}
        </Instances>
      )}
      {rallyCells.map((c) => (
        <mesh key={c.name} position={[c.x, 0.02, c.z]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.3, 0.42, 20]} />
          <meshBasicMaterial color="#15803d" side={THREE.DoubleSide} transparent opacity={0.8} />
        </mesh>
      ))}
      {breachCells.map((c) => (
        <mesh key={c.name} position={[c.x, 0.02, c.z]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.3, 0.42, 4]} />
          <meshBasicMaterial color="#b45309" side={THREE.DoubleSide} transparent opacity={0.85} />
        </mesh>
      ))}

      {(instance.walls ?? []).map((w, i) => (
        <Wall key={i} {...w} broken={frame.doorBroken} />
      ))}

      {/* every unit's planned route — the searched covered approach (selected = bright) */}
      {frame.units.map((u) =>
        u.alive && u.route.length > 0 ? (
          <Route key={`route-${u.name}`} from={unitPos(u)} route={u.route} color={SIDE_COLOR[u.side] ?? "#fff"} bright={selected === u.name} />
        ) : null,
      )}

      {/* fire beams for every unit currently shooting */}
      {frame.units.map((u) => {
        if (!u.alive || !u.firingAt) return null;
        const t = byName.get(u.firingAt);
        if (!t) return null;
        return <FireBeam key={`beam-${u.name}`} from={unitPos(u)} to={unitPos(t)} kind={u.firingKind ?? "shot"} color={SIDE_COLOR[u.side] ?? "#fff"} />;
      })}

      {sel && sel.alive && selTarget && <SightLine from={unitPos(sel)} to={unitPos(selTarget)} hasShot={sel.sees === selTarget.name} />}

      {frame.units.map((u) => {
        const aimAt = u.firingAt ? byName.get(u.firingAt) : u.sees ? byName.get(u.sees) : null;
        return <Unit key={u.name} u={u} target={aimAt ? unitPos(aimAt) : null} selected={selected === u.name} onSelect={() => onSelect(u.name)} />;
      })}

      <GizmoHelper alignment="bottom-right" margin={[56, 56]}>
        <GizmoViewport axisColors={["#f87171", "#34d399", "#38bdf8"]} labelColor="#0b0e14" />
      </GizmoHelper>
    </>
  );
}

export default function SquadScene(props: SceneProps) {
  return (
    <Canvas shadows dpr={[1, 2]} gl={{ antialias: true }} style={{ background: "linear-gradient(180deg,#0d1320,#0b0e14)" }}>
      <Scene {...props} />
    </Canvas>
  );
}
