"use client";
import { Canvas, useFrame } from "@react-three/fiber";
import { GizmoHelper, GizmoViewport, Grid, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { StaircaseInstance } from "@scenarios/staircase";
import type { Frame } from "../lib/run";

const AGENT_R = 0.32;

interface SceneProps {
  frame: Frame;
  instance: StaircaseInstance;
  target: { x: number; z: number; y: number; cell: string };
  reached: boolean;
}

function Agent({ target, holding }: { target: THREE.Vector3; holding: boolean }) {
  const ref = useRef<THREE.Group>(null);
  useEffect(() => {
    ref.current?.position.copy(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    g.position.lerp(target, 1 - Math.pow(0.0015, Math.min(dt, 0.05)));
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

function TargetMarker({ pos, reached }: { pos: THREE.Vector3; reached: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    const m = ref.current;
    if (!m) return;
    const s = 1 + Math.sin(state.clock.elapsedTime * 3) * 0.08;
    m.scale.setScalar(s);
    m.rotation.y += 0.01;
  });
  const color = reached ? "#34d399" : "#fbbf24";
  return (
    <group position={pos}>
      <mesh ref={ref}>
        <boxGeometry args={[0.85, 0.85, 0.85]} />
        <meshBasicMaterial color={color} wireframe />
      </mesh>
      <pointLight color={color} intensity={reached ? 3 : 1.5} distance={4} />
    </group>
  );
}

function Column({
  x,
  z,
  height,
  isTarget,
  isSupply,
  isWall,
}: {
  x: number;
  z: number;
  height: number;
  isTarget: boolean;
  isSupply: boolean;
  isWall: boolean;
}) {
  const tile = isWall ? "#0c0f16" : isTarget ? "#3b2f12" : isSupply ? "#3a2a10" : "#1b2333";
  const block = isWall ? "#2b3140" : isTarget ? "#6366f1" : "#3f7cc4";
  return (
    <group position={[x, 0, z]}>
      {/* cell tile on the ground */}
      <mesh position={[0, 0.02, 0]} receiveShadow>
        <boxGeometry args={[0.96, 0.04, 0.96]} />
        <meshStandardMaterial color={tile} />
      </mesh>
      {/* stacked unit blocks (a tall dark pillar for walls) */}
      {Array.from({ length: height }).map((_, k) => (
        <mesh key={k} position={[0, k + 0.5, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.9, 0.96, 0.9]} />
          <meshStandardMaterial color={block} roughness={isWall ? 0.95 : 0.7} metalness={0.05} />
        </mesh>
      ))}
      {isSupply && height === 0 && (
        <mesh position={[0, 0.12, 0]}>
          <boxGeometry args={[0.5, 0.16, 0.5]} />
          <meshStandardMaterial color="#f59e0b" emissive="#5a3b00" emissiveIntensity={0.5} />
        </mesh>
      )}
    </group>
  );
}

function Scene({ frame, instance, target, reached }: SceneProps) {
  const cellPos = useMemo(() => {
    const m = new Map<string, [number, number]>();
    for (const c of instance.cells) m.set(c.name, [c.x, c.z]);
    return m;
  }, [instance]);
  const supplyCells = useMemo(() => new Set(instance.cells.filter((c) => (c.supply ?? 0) > 0).map((c) => c.name)), [instance]);
  const wallCells = useMemo(() => new Set(instance.cells.filter((c) => c.wall).map((c) => c.name)), [instance]);

  const center = useMemo<[number, number, number]>(() => {
    const xs = instance.cells.map((c) => c.x);
    const zs = instance.cells.map((c) => c.z);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, 1.2, (Math.min(...zs) + Math.max(...zs)) / 2];
  }, [instance]);

  const [ax, az] = cellPos.get(frame.agentCell) ?? [0, 0];
  const agentTarget = useMemo(() => new THREE.Vector3(ax, frame.agentY + AGENT_R + 0.02, az), [ax, az, frame.agentY]);
  const markerPos = useMemo(() => new THREE.Vector3(target.x, target.y + 0.5, target.z), [target]);

  return (
    <>
      <PerspectiveCamera makeDefault position={[center[0] + 5, 6, center[2] + 7.5]} fov={42} />
      <OrbitControls target={center} enablePan minDistance={3} maxDistance={30} maxPolarAngle={Math.PI / 2.1} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[6, 10, 4]} intensity={1.1} castShadow shadow-mapSize={[1024, 1024]} />
      <hemisphereLight args={["#9db7ff", "#0b0e14", 0.4]} />

      <Grid
        args={[40, 40]}
        position={[center[0], 0, center[2]]}
        cellColor="#1c2436"
        sectionColor="#283350"
        fadeDistance={34}
        infiniteGrid
      />

      {instance.cells.map((c) => (
        <Column
          key={c.name}
          x={c.x}
          z={c.z}
          height={frame.heights[c.name] ?? 0}
          isTarget={c.name === target.cell}
          isSupply={supplyCells.has(c.name)}
          isWall={wallCells.has(c.name)}
        />
      ))}

      <Agent target={agentTarget} holding={frame.holding} />
      <TargetMarker pos={markerPos} reached={reached} />

      <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
        <GizmoViewport axisColors={["#f87171", "#34d399", "#38bdf8"]} labelColor="#0b0e14" />
      </GizmoHelper>
    </>
  );
}

export default function StaircaseScene(props: SceneProps) {
  return (
    <Canvas shadows dpr={[1, 2]} gl={{ antialias: true }} style={{ background: "linear-gradient(180deg,#0d1320,#0b0e14)" }}>
      <Scene {...props} />
    </Canvas>
  );
}
