"use client";
import { Canvas, useFrame } from "@react-three/fiber";
import { GizmoHelper, GizmoViewport, Grid, Html, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import type { SquadFrame, SquadInstance, UnitFrame } from "@scenarios/squad-combat";

const SIDE_COLOR: Record<string, string> = { enemy: "#ef4444", ally: "#34d399", player: "#38bdf8" };
const COVER_COLOR = { free: "#475569", flank: "#f59e0b", high: "#a78bfa", breach: "#f43f5e", rally: "#22c55e" };

interface SceneProps {
  frame: SquadFrame;
  instance: SquadInstance;
  selected: string | null;
  onSelect: (name: string) => void;
}

function Unit({ u, selected, onSelect }: { u: UnitFrame; selected: boolean; onSelect: () => void }) {
  const ref = useRef<THREE.Group>(null);
  const target = useMemo(() => new THREE.Vector3(u.x, u.elevation * 0.6 + 0.4, u.z), [u.x, u.z, u.elevation]);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    g.position.lerp(target, 1 - Math.pow(0.0015, Math.min(dt, 0.05)));
  });
  const color = SIDE_COLOR[u.side] ?? "#94a3b8";
  const hpFrac = Math.max(0, Math.min(1, u.hp / 100));
  return (
    <group ref={ref} position={[u.x, u.elevation * 0.6 + 0.4, u.z]}>
      {/* body */}
      <mesh castShadow onClick={(e) => { e.stopPropagation(); onSelect(); }}>
        <capsuleGeometry args={[0.32, 0.5, 6, 14]} />
        <meshStandardMaterial
          color={u.alive ? color : "#3a3f4b"}
          emissive={u.alive ? color : "#000"}
          emissiveIntensity={selected ? 0.65 : 0.25}
          roughness={0.5}
          transparent
          opacity={u.alive ? 1 : 0.35}
        />
      </mesh>
      {/* selection ring */}
      {selected && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.78, 0]}>
          <ringGeometry args={[0.55, 0.7, 28]} />
          <meshBasicMaterial color="#e2e8f0" side={THREE.DoubleSide} />
        </mesh>
      )}
      {/* hp bar */}
      {u.alive && (
        <group position={[0, 1.05, 0]}>
          <mesh position={[-(1 - hpFrac) * 0.5, 0, 0]} scale={[Math.max(0.001, hpFrac), 1, 1]}>
            <boxGeometry args={[1, 0.12, 0.06]} />
            <meshBasicMaterial color={hpFrac > 0.5 ? "#22c55e" : hpFrac > 0.25 ? "#f59e0b" : "#ef4444"} />
          </mesh>
        </group>
      )}
      {/* name + bark label */}
      <Html position={[0, 1.5, 0]} center distanceFactor={14} style={{ pointerEvents: "none", userSelect: "none" }}>
        <div style={{ textAlign: "center", fontFamily: "var(--font-mono, monospace)", whiteSpace: "nowrap" }}>
          <div style={{ fontSize: 11, color, fontWeight: 700 }}>
            {u.name}
            {u.side !== "player" && <span style={{ color: "#94a3b8", fontWeight: 400 }}> · {u.role}</span>}
          </div>
          {u.alive && u.bark && (
            <div
              style={{
                marginTop: 2,
                fontSize: 10,
                color: "#0b0e14",
                background: color,
                borderRadius: 6,
                padding: "1px 6px",
                display: "inline-block",
              }}
            >
              {u.bark}
            </div>
          )}
        </div>
      </Html>
    </group>
  );
}

function Cover({
  name,
  x,
  z,
  kind,
  ownerColor,
}: {
  name: string;
  x: number;
  z: number;
  kind: keyof typeof COVER_COLOR;
  ownerColor: string | null;
}) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.18, 0]} castShadow>
        <boxGeometry args={[0.7, 0.36, 0.7]} />
        <meshStandardMaterial color={COVER_COLOR[kind]} roughness={0.85} metalness={0.05} />
      </mesh>
      {ownerColor && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
          <ringGeometry args={[0.5, 0.62, 24]} />
          <meshBasicMaterial color={ownerColor} side={THREE.DoubleSide} />
        </mesh>
      )}
      <Html position={[0, 0.6, 0]} center distanceFactor={20} style={{ pointerEvents: "none" }}>
        <div style={{ fontSize: 9, color: "#64748b", fontFamily: "monospace" }}>{name}</div>
      </Html>
    </group>
  );
}

function Wall({ x, z, w, d }: { x: number; z: number; w: number; d: number }) {
  return (
    <mesh position={[x + w / 2, 0.6, z + d / 2]} castShadow receiveShadow>
      <boxGeometry args={[w, 1.2, d]} />
      <meshStandardMaterial color="#0c0f16" roughness={0.95} />
    </mesh>
  );
}

function Scene({ frame, instance, selected, onSelect }: SceneProps) {
  const center = useMemo<[number, number, number]>(() => {
    const xs = instance.units.map((u) => u.x).concat(instance.covers.map((c) => c.x));
    const zs = instance.units.map((u) => u.z).concat(instance.covers.map((c) => c.z));
    return [(Math.min(...xs) + Math.max(...xs)) / 2, 0, (Math.min(...zs) + Math.max(...zs)) / 2];
  }, [instance]);

  const sideOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of frame.units) m.set(u.name, u.side);
    return m;
  }, [frame]);

  const coverKind = (c: SquadInstance["covers"][number]): keyof typeof COVER_COLOR =>
    c.breach ? "breach" : c.flank ? "flank" : c.high ? "high" : c.rally ? "rally" : "free";

  return (
    <>
      <PerspectiveCamera makeDefault position={[center[0] + 2, 16, center[2] + 16]} fov={42} />
      <OrbitControls target={[center[0], 0, center[2]]} enablePan minDistance={6} maxDistance={48} maxPolarAngle={Math.PI / 2.05} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[8, 14, 6]} intensity={1.1} castShadow shadow-mapSize={[1024, 1024]} />
      <hemisphereLight args={["#9db7ff", "#0b0e14", 0.4]} />

      <Grid args={[80, 80]} position={[center[0], 0, center[2]]} cellColor="#1c2436" sectionColor="#283350" fadeDistance={60} infiniteGrid />

      {/* clicking empty space deselects */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[center[0], -0.01, center[2]]} onClick={() => onSelect("")}>
        <planeGeometry args={[200, 200]} />
        <meshBasicMaterial transparent opacity={0} />
      </mesh>

      {(instance.walls ?? []).map((w, i) => (
        <Wall key={i} {...w} />
      ))}

      {instance.covers.map((c) => {
        const owner = frame.reservations[c.name] ?? null;
        return <Cover key={c.name} name={c.name} x={c.x} z={c.z} kind={coverKind(c)} ownerColor={owner ? SIDE_COLOR[sideOf.get(owner) ?? ""] ?? "#e2e8f0" : null} />;
      })}

      {frame.units.map((u) => (
        <Unit key={u.name} u={u} selected={selected === u.name} onSelect={() => onSelect(u.name)} />
      ))}

      <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
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
