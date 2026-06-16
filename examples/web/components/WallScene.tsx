"use client";
import { Canvas, useFrame } from "@react-three/fiber";
import { GizmoHelper, GizmoViewport, Grid, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { WallCell, WallFrame } from "../lib/runWall";

const AGENT_R = 0.32;

interface SceneProps {
  frame: WallFrame;
  cells: WallCell[];
  targets: string[];
  sources: string[];
  core: string;
  reached: boolean;
}

function Agent({ target, holding }: { target: THREE.Vector3; holding: boolean }) {
  const ref = useRef<THREE.Group>(null);
  useEffect(() => {
    ref.current?.position.copy(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useFrame((_, dt) => {
    ref.current?.position.lerp(target, 1 - Math.pow(0.0015, Math.min(dt, 0.05)));
  });
  return (
    <group ref={ref}>
      <mesh castShadow>
        <sphereGeometry args={[AGENT_R, 28, 28]} />
        <meshStandardMaterial color="#38bdf8" emissive="#0b3b4d" emissiveIntensity={0.6} roughness={0.4} />
      </mesh>
      {holding && (
        <mesh position={[0, AGENT_R + 0.35, 0]} castShadow>
          <boxGeometry args={[0.42, 0.42, 0.42]} />
          <meshStandardMaterial color="#f59e0b" emissive="#7a4d00" emissiveIntensity={0.4} />
        </mesh>
      )}
    </group>
  );
}

/** A wall slot: a translucent wireframe "ghost" of the goal, made solid once laid. */
function Slot({ x, z, laid }: { x: number; z: number; laid: boolean }) {
  const ghost = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    const m = ghost.current;
    if (!m || laid) return;
    const s = 1 + Math.sin(state.clock.elapsedTime * 2.4 + x + z) * 0.05;
    m.scale.set(1, s, 1);
  });
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.02, 0]} receiveShadow>
        <boxGeometry args={[0.96, 0.04, 0.96]} />
        <meshStandardMaterial color={laid ? "#163a2c" : "#243049"} />
      </mesh>
      {laid ? (
        <mesh position={[0, 0.5, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.9, 0.96, 0.9]} />
          <meshStandardMaterial color="#34d399" emissive="#064e3b" emissiveIntensity={0.45} roughness={0.55} />
        </mesh>
      ) : (
        <mesh ref={ghost} position={[0, 0.5, 0]}>
          <boxGeometry args={[0.9, 0.96, 0.9]} />
          <meshBasicMaterial color="#fbbf24" wireframe transparent opacity={0.55} />
        </mesh>
      )}
    </group>
  );
}

/** A scattered source block sitting on the ground until the agent collects it. */
function SourceCell({ x, z, present }: { x: number; z: number; present: boolean }) {
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.02, 0]} receiveShadow>
        <boxGeometry args={[0.96, 0.04, 0.96]} />
        <meshStandardMaterial color="#1b2333" />
      </mesh>
      {present && (
        <mesh position={[0, 0.5, 0]} castShadow receiveShadow rotation={[0, 0.5, 0]}>
          <boxGeometry args={[0.78, 0.78, 0.78]} />
          <meshStandardMaterial color="#f59e0b" emissive="#5a3b00" emissiveIntensity={0.4} roughness={0.7} />
        </mesh>
      )}
    </group>
  );
}

/** A plain floor tile (no goal, no block). */
function FloorCell({ x, z, isCore }: { x: number; z: number; isCore: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(() => {
    if (ref.current && isCore) ref.current.rotation.y += 0.01;
  });
  return (
    <group position={[x, 0, z]}>
      <mesh position={[0, 0.02, 0]} receiveShadow>
        <boxGeometry args={[0.96, 0.04, 0.96]} />
        <meshStandardMaterial color={isCore ? "#2a2140" : "#10151f"} />
      </mesh>
      {isCore && (
        <>
          <mesh ref={ref} position={[0, 0.5, 0]}>
            <octahedronGeometry args={[0.3, 0]} />
            <meshStandardMaterial color="#a78bfa" emissive="#4c1d95" emissiveIntensity={0.7} roughness={0.3} />
          </mesh>
          <pointLight color="#a78bfa" intensity={1.2} distance={3.5} position={[0, 0.6, 0]} />
        </>
      )}
    </group>
  );
}

function Scene({ frame, cells, targets, sources, core, reached }: SceneProps) {
  const targetSet = useMemo(() => new Set(targets), [targets]);
  const sourceSet = useMemo(() => new Set(sources), [sources]);

  const center = useMemo<[number, number, number]>(() => {
    const xs = cells.map((c) => c.x);
    const zs = cells.map((c) => c.z);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, 0.8, (Math.min(...zs) + Math.max(...zs)) / 2];
  }, [cells]);

  const cellPos = useMemo(() => {
    const m = new Map<string, [number, number]>();
    for (const c of cells) m.set(c.name, [c.x, c.z]);
    return m;
  }, [cells]);

  const [ax, az] = cellPos.get(frame.agentCell) ?? [0, 0];
  const agentTarget = useMemo(() => new THREE.Vector3(ax, frame.agentY + AGENT_R + 0.02, az), [ax, az, frame.agentY]);

  return (
    <>
      <PerspectiveCamera makeDefault position={[center[0] + 4.5, 7, center[2] + 8]} fov={42} />
      <OrbitControls target={center} enablePan minDistance={4} maxDistance={32} maxPolarAngle={Math.PI / 2.1} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[6, 11, 4]} intensity={1.1} castShadow shadow-mapSize={[1024, 1024]} />
      <hemisphereLight args={["#9db7ff", "#0b0e14", 0.4]} />

      <Grid args={[40, 40]} position={[center[0], 0, center[2]]} cellColor="#1c2436" sectionColor="#283350" fadeDistance={34} infiniteGrid />

      {cells.map((c) => {
        const h = frame.heights[c.name] ?? 0;
        if (targetSet.has(c.name)) return <Slot key={c.name} x={c.x} z={c.z} laid={h >= 1} />;
        if (sourceSet.has(c.name)) return <SourceCell key={c.name} x={c.x} z={c.z} present={h >= 1} />;
        return <FloorCell key={c.name} x={c.x} z={c.z} isCore={c.name === core} />;
      })}

      <Agent target={agentTarget} holding={frame.holding} />

      {reached && (
        <mesh position={[center[0], 0.02, center[2]]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[2.2, 2.4, 48]} />
          <meshBasicMaterial color="#34d399" transparent opacity={0.6} side={THREE.DoubleSide} />
        </mesh>
      )}

      <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
        <GizmoViewport axisColors={["#f87171", "#34d399", "#38bdf8"]} labelColor="#0b0e14" />
      </GizmoHelper>
    </>
  );
}

export default function WallScene(props: SceneProps) {
  return (
    <Canvas shadows dpr={[1, 2]} gl={{ antialias: true }} style={{ background: "linear-gradient(180deg,#0d1320,#0b0e14)" }}>
      <Scene {...props} />
    </Canvas>
  );
}
