"use client";
import { Canvas, useFrame } from "@react-three/fiber";
import { GizmoHelper, GizmoViewport, Grid, Html, Line, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { type SoloFrame, type SoloInstance, soloFieldFromFrame } from "@scenarios/solo-combat";

const NPC_COLOR = "#3b82f6";
const THREAT_COLOR = "#ef4444";
const CHEST = 0.55;

function actionIcon(action: string): string {
  if (action.startsWith("firing")) return "🎯";
  if (action.startsWith("advancing")) return "🔥";
  if (action.includes("cover")) return "→";
  if (action.includes("high ground")) return "⤴";
  if (action === "falling back") return "⮌";
  if (action === "reloading") return "⟳";
  if (action === "thinking…") return "…";
  if (action === "down") return "✖";
  return "•";
}

interface SceneProps {
  frame: SoloFrame;
  instance: SoloInstance;
}

function FireBeam({ from, to, color }: { from: THREE.Vector3; to: THREE.Vector3; color: string }) {
  const round = useRef<THREE.Mesh>(null);
  const a = useMemo(() => from.clone().setY(from.y + CHEST), [from]);
  const b = useMemo(() => to.clone().setY(to.y + CHEST), [to]);
  useFrame((state) => {
    const m = round.current;
    if (!m) return;
    m.position.lerpVectors(a, b, (state.clock.elapsedTime * 3) % 1);
  });
  return (
    <group>
      <Line points={[a, b]} color={color} lineWidth={2} transparent opacity={0.7} />
      <mesh ref={round}>
        <sphereGeometry args={[0.09, 8, 8]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh position={a}>
        <sphereGeometry args={[0.16, 8, 8]} />
        <meshBasicMaterial color={color} transparent opacity={0.5} />
      </mesh>
    </group>
  );
}

function Actor({ x, z, elev, hp, alive, color, label, sub }: { x: number; z: number; elev: number; hp: number; alive: boolean; color: string; label: string; sub: string }) {
  const ref = useRef<THREE.Group>(null);
  const dest = useMemo(() => new THREE.Vector3(x, elev * 0.6 + 0.45, z), [x, z, elev]);
  useFrame((_, dt) => {
    const g = ref.current;
    if (g) g.position.lerp(dest, 1 - Math.pow(0.0015, Math.min(dt, 0.05)));
  });
  const hpFrac = Math.max(0, Math.min(1, hp / 100));
  return (
    <group ref={ref} position={dest.toArray()}>
      <mesh castShadow>
        <capsuleGeometry args={[0.32, 0.5, 6, 14]} />
        <meshStandardMaterial color={alive ? color : "#3a3f4b"} emissive={alive ? color : "#000"} emissiveIntensity={0.3} roughness={0.5} transparent opacity={alive ? 1 : 0.3} />
      </mesh>
      {/* HP bar — a thin centered bar above the capsule (green→red as it drops) */}
      {alive && (
        <group position={[0, 1.05, 0]}>
          <mesh>
            <boxGeometry args={[0.84, 0.12, 0.04]} />
            <meshBasicMaterial color="#0b0e14" />
          </mesh>
          <mesh position={[-(1 - hpFrac) * 0.4, 0, 0.01]} scale={[Math.max(0.001, hpFrac), 1, 1]}>
            <boxGeometry args={[0.8, 0.08, 0.04]} />
            <meshBasicMaterial color={hpFrac > 0.5 ? "#22c55e" : hpFrac > 0.25 ? "#f59e0b" : "#ef4444"} />
          </mesh>
        </group>
      )}
      <Html position={[0, 1.5, 0]} center distanceFactor={13} style={{ pointerEvents: "none", userSelect: "none" }}>
        <div style={{ textAlign: "center", fontFamily: "ui-monospace, monospace", whiteSpace: "nowrap" }}>
          <div style={{ fontSize: 11, color, fontWeight: 700 }}>{label}</div>
          <div style={{ marginTop: 2, fontSize: 10, color: "#0b0e14", background: alive ? color : "#3a3f4b", borderRadius: 6, padding: "1px 7px", display: "inline-block", fontWeight: 600 }}>{sub}</div>
        </div>
      </Html>
    </group>
  );
}

/** A soft-cover crate. Intact crates are solid; a destroyed one is low rubble. */
function Cover({ x, z, destroyed, high }: { x: number; z: number; destroyed: boolean; high: boolean }) {
  if (destroyed) {
    return (
      <mesh position={[x, 0.06, z]} receiveShadow>
        <boxGeometry args={[1.0, 0.12, 0.6]} />
        <meshStandardMaterial color="#241712" roughness={1} />
      </mesh>
    );
  }
  const h = high ? 0.9 : 0.26;
  return (
    <mesh position={[x, h / 2, z]} castShadow receiveShadow>
      <boxGeometry args={[1.2, h, 0.8]} />
      <meshStandardMaterial color={high ? "#6d28d9" : "#6b6253"} roughness={0.95} metalness={0.02} />
    </mesh>
  );
}

function Wall({ x, z, w, d }: { x: number; z: number; w: number; d: number }) {
  return (
    <mesh position={[x + w / 2, 1.1, z + d / 2]} castShadow receiveShadow>
      <boxGeometry args={[w, 2.2, d]} />
      <meshStandardMaterial color="#161c28" roughness={0.95} />
    </mesh>
  );
}

/**
 * A translucent floor heatmap of THREAT EXPOSURE: red where a threat has a clear shot,
 * green where shielded (behind a wall or hugging a crate). Built from the FRAME's live
 * covers + threats (soloFieldFromFrame), so destroying a crate updates the overlay. The
 * sampling grid is aligned to integer world cells so tiles line up with the geometry.
 */
function ExposureHeatmap({ frame, instance }: SceneProps) {
  const tiles = useMemo(() => {
    if (frame.threats.every((t) => !t.alive)) return [];
    const field = soloFieldFromFrame(frame, instance.walls);
    const xs = [...instance.units.map((u) => u.x), ...instance.covers.map((c) => c.x)];
    const zs = [...instance.units.map((u) => u.z), ...instance.covers.map((c) => c.z)];
    const pad = 4;
    const lo = (a: number[]) => Math.floor(Math.min(...a) - pad);
    const hi = (a: number[]) => Math.ceil(Math.max(...a) + pad);
    const minX = lo(xs), maxX = hi(xs), minZ = lo(zs), maxZ = hi(zs);
    const out: { x: number; z: number; exp: number }[] = [];
    for (let x = minX; x <= maxX; x += 1) for (let z = minZ; z <= maxZ; z += 1) out.push({ x, z, exp: field.exposureAt(x, z, 0) });
    return out.slice(0, 1100);
  }, [frame, instance]);
  const max = Math.max(1, ...tiles.map((t) => t.exp));
  return (
    <group>
      {tiles.map((t, i) => {
        const f = t.exp / max;
        const safe = t.exp === 0;
        const danger = new THREE.Color(0.85, 0.25 - 0.2 * f, 0.2).getStyle();
        return (
          <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} position={[t.x, 0.02, t.z]}>
            <planeGeometry args={[0.92, 0.92]} />
            <meshBasicMaterial color={safe ? "#14532d" : danger} transparent opacity={safe ? 0.22 : 0.12 + 0.28 * f} />
          </mesh>
        );
      })}
    </group>
  );
}

function Scene({ frame, instance }: SceneProps) {
  const center = useMemo<[number, number, number]>(() => {
    const xs = instance.units.map((u) => u.x).concat(instance.covers.map((c) => c.x));
    const zs = instance.units.map((u) => u.z).concat(instance.covers.map((c) => c.z));
    return [(Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2];
  }, [instance]);

  const npc = frame.npc;
  const npcPos = new THREE.Vector3(npc.x, npc.elev * 0.6 + 0.45, npc.z);
  const firingTarget = npc.firingAt ? frame.threats.find((t) => t.name === npc.firingAt) : null;

  return (
    <>
      <PerspectiveCamera makeDefault position={[center[0], 20, center[2] + 13]} fov={40} />
      <OrbitControls target={[center[0], 0, center[2]]} enablePan minDistance={8} maxDistance={52} maxPolarAngle={Math.PI / 2.1} />
      <ambientLight intensity={0.65} />
      <directionalLight position={[8, 16, 6]} intensity={1.1} castShadow shadow-mapSize={[1024, 1024]} />
      <hemisphereLight args={["#9db7ff", "#0b0e14", 0.4]} />
      <Grid args={[90, 90]} position={[center[0], 0, center[2]]} cellColor="#1c2436" sectionColor="#283350" fadeDistance={70} infiniteGrid />

      <ExposureHeatmap frame={frame} instance={instance} />

      {(instance.walls ?? []).map((w, i) => <Wall key={i} {...w} />)}
      {frame.covers.map((c) => <Cover key={c.name} x={c.x} z={c.z} destroyed={c.destroyed} high={c.high} />)}

      {/* NPC fire beam → its target; threats firing → the NPC */}
      {npc.alive && firingTarget && <FireBeam from={npcPos} to={new THREE.Vector3(firingTarget.x, 0.45, firingTarget.z)} color={NPC_COLOR} />}
      {frame.threats.map((t) => (t.alive && t.firing && npc.alive ? <FireBeam key={`tb-${t.name}`} from={new THREE.Vector3(t.x, 0.45, t.z)} to={npcPos} color={THREAT_COLOR} /> : null))}

      <Actor x={npc.x} z={npc.z} elev={npc.elev} hp={npc.hp} alive={npc.alive} color={NPC_COLOR} label="NPC" sub={`${actionIcon(npc.action)} ${npc.action}`} />
      {frame.threats.map((t) => <Actor key={t.name} x={t.x} z={t.z} elev={0} hp={t.hp} alive={t.alive} color={THREAT_COLOR} label="threat" sub={t.alive ? "target" : "down"} />)}

      <GizmoHelper alignment="bottom-right" margin={[56, 56]}>
        <GizmoViewport axisColors={["#f87171", "#34d399", "#38bdf8"]} labelColor="#0b0e14" />
      </GizmoHelper>
    </>
  );
}

export default function SoloScene(props: SceneProps) {
  return (
    <Canvas shadows dpr={[1, 2]} gl={{ antialias: true }} style={{ background: "linear-gradient(180deg,#0d1320,#0b0e14)" }}>
      <Scene {...props} />
    </Canvas>
  );
}
