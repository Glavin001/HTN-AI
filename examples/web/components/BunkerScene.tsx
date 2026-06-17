"use client";
import { Canvas, useFrame } from "@react-three/fiber";
import { GizmoHelper, GizmoViewport, Grid, Line, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import {
  BUILDINGS,
  BUNKER_EDGES,
  NODE_POS,
  N_,
  type BuildingConfig,
  type BunkerNode,
} from "@scenarios/bunker";
import type { BunkerFrame } from "../lib/runBunker";

const v = (n: BunkerNode, y = 0): THREE.Vector3 => {
  const p = NODE_POS[n];
  return new THREE.Vector3(p[0], p[1] + y, p[2]);
};

/** door slab transform from a building footprint + which wall it sits on */
function doorTransform(b: BuildingConfig): { pos: THREE.Vector3; rotY: number } {
  const [w, , d] = b.size;
  const [cx, cy, cz] = b.center;
  switch (b.doorFace) {
    case "east":
      return { pos: new THREE.Vector3(cx + w / 2, cy, cz), rotY: Math.PI / 2 };
    case "west":
      return { pos: new THREE.Vector3(cx - w / 2, cy, cz), rotY: Math.PI / 2 };
    case "south":
      return { pos: new THREE.Vector3(cx, cy, cz + d / 2), rotY: 0 };
    case "north":
    default:
      return { pos: new THREE.Vector3(cx, cy, cz - d / 2), rotY: 0 };
  }
}

function Building({ b, open, breached }: { b: BuildingConfig; open: boolean; breached: boolean }) {
  const [w, h, d] = b.size;
  const [cx, , cz] = b.center;
  const door = doorTransform(b);
  const doorRef = useRef<THREE.Group>(null);
  // an unlocked door swings open; a breached bunker door is blown away entirely
  useFrame((_, dt) => {
    const g = doorRef.current;
    if (!g) return;
    const targetOpen = open || breached ? 1 : 0;
    const k = 1 - Math.pow(0.002, Math.min(dt, 0.05));
    g.userData.t = THREE.MathUtils.lerp(g.userData.t ?? 0, targetOpen, k);
    g.rotation.y = g.userData.t * (Math.PI / 2.2);
    g.scale.setScalar(breached ? Math.max(0.0001, 1 - g.userData.t) : 1);
  });
  return (
    <group>
      {/* shell: four walls so the interior (and the star) is visible from above */}
      <mesh position={[cx, h / 2, cz]} castShadow receiveShadow>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={b.color} roughness={0.8} metalness={0.12} transparent opacity={0.34} side={THREE.DoubleSide} />
      </mesh>
      {/* edges to read it as a structure */}
      <lineSegments position={[cx, h / 2, cz]}>
        <edgesGeometry args={[new THREE.BoxGeometry(w, h, d)]} />
        <lineBasicMaterial color={b.color} />
      </lineSegments>
      {/* roof slab */}
      <mesh position={[cx, h + 0.08, cz]} castShadow>
        <boxGeometry args={[w + 0.5, 0.16, d + 0.5]} />
        <meshStandardMaterial color="#0b1220" roughness={0.9} />
      </mesh>
      {/* door, hinged on one edge so it swings */}
      <group position={door.pos.toArray()} rotation={[0, door.rotY, 0]}>
        <group ref={doorRef} position={[-0.75, 0, 0]}>
          <mesh position={[0.75, 1.1, 0]} castShadow>
            <boxGeometry args={[1.5, 2.2, 0.18]} />
            <meshStandardMaterial color={breached ? "#7c2d12" : open ? "#a16207" : "#b91c1c"} roughness={0.55} metalness={0.3} emissive={open ? "#3f2d06" : "#000000"} emissiveIntensity={open ? 0.4 : 0} />
          </mesh>
        </group>
      </group>
      {breached && <BreachRubble center={door.pos} />}
    </group>
  );
}

function BreachRubble({ center }: { center: THREE.Vector3 }) {
  const bits = useMemo(() => {
    const rng = mulberry(42);
    return Array.from({ length: 9 }, () => ({
      p: [center.x + (rng() - 0.5) * 2.4, 0.15 + rng() * 0.3, center.z + (rng() - 0.5) * 2.4] as [number, number, number],
      s: 0.2 + rng() * 0.35,
      r: rng() * Math.PI,
    }));
  }, [center]);
  return (
    <group>
      {bits.map((b, i) => (
        <mesh key={i} position={b.p} rotation={[b.r, b.r, 0]} castShadow>
          <boxGeometry args={[b.s, b.s, b.s]} />
          <meshStandardMaterial color="#475569" roughness={0.95} />
        </mesh>
      ))}
    </group>
  );
}

function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A small marker for a pickup item that disappears once collected. */
function Item({ at, show, color, kind }: { at: THREE.Vector3; show: boolean; color: string; kind: "key" | "c4" | "star" }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((st, dt) => {
    if (!ref.current) return;
    const target = show ? 1 : 0;
    ref.current.scale.lerp(new THREE.Vector3(target, target, target), 1 - Math.pow(0.001, Math.min(dt, 0.05)));
    if (kind === "star") ref.current.rotation.y += dt * 1.6;
  });
  return (
    <group ref={ref} position={[at.x, at.y, at.z]}>
      {kind === "key" && (
        <group position={[0, 0.5, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <mesh castShadow>
            <torusGeometry args={[0.18, 0.06, 8, 16]} />
            <meshStandardMaterial color={color} metalness={0.7} roughness={0.3} emissive={color} emissiveIntensity={0.25} />
          </mesh>
          <mesh position={[0, -0.3, 0]} castShadow>
            <boxGeometry args={[0.08, 0.5, 0.08]} />
            <meshStandardMaterial color={color} metalness={0.7} roughness={0.3} />
          </mesh>
        </group>
      )}
      {kind === "c4" && (
        <mesh position={[0, 0.35, 0]} castShadow>
          <boxGeometry args={[0.7, 0.4, 0.5]} />
          <meshStandardMaterial color={color} roughness={0.5} emissive="#7c2d12" emissiveIntensity={0.4} />
        </mesh>
      )}
      {kind === "star" && (
        <group position={[0, 1.0, 0]}>
          <mesh castShadow>
            <octahedronGeometry args={[0.55, 0]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.9} metalness={0.4} roughness={0.2} />
          </mesh>
          <pointLight color={color} intensity={6} distance={7} />
        </group>
      )}
    </group>
  );
}

/** The planted C4 charge stuck on the bunker door. */
function PlantedC4({ show }: { show: boolean }) {
  const at = doorTransform(BUILDINGS.BUNKER).pos;
  const ref = useRef<THREE.Mesh>(null);
  useFrame((st, dt) => {
    if (!ref.current) return;
    const target = show ? 1 : 0;
    ref.current.scale.lerp(new THREE.Vector3(target, target, target), 1 - Math.pow(0.001, Math.min(dt, 0.05)));
    const blink = 0.5 + 0.5 * Math.sin(st.clock.elapsedTime * 6);
    (ref.current.material as THREE.MeshStandardMaterial).emissiveIntensity = show ? blink : 0;
  });
  return (
    <mesh ref={ref} position={[at.x + 0.2, at.y + 1.1, at.z]} castShadow>
      <boxGeometry args={[0.5, 0.35, 0.3]} />
      <meshStandardMaterial color="#f97316" emissive="#ef4444" />
    </mesh>
  );
}

function Explosion({ active }: { active: boolean }) {
  const ref = useRef<THREE.Mesh>(null);
  const light = useRef<THREE.PointLight>(null);
  const at = doorTransform(BUILDINGS.BUNKER).pos;
  const life = useRef(0);
  useEffect(() => {
    if (active) life.current = 1;
  }, [active]);
  useFrame((_, dt) => {
    life.current = Math.max(0, life.current - dt * 1.2);
    const l = life.current;
    if (ref.current) {
      const r = (1 - l) * 5 + 0.2;
      ref.current.scale.setScalar(r);
      (ref.current.material as THREE.MeshBasicMaterial).opacity = l * 0.8;
      ref.current.visible = l > 0.01;
    }
    if (light.current) light.current.intensity = l * 60;
  });
  return (
    <group position={[at.x, at.y + 1.4, at.z]}>
      <mesh ref={ref}>
        <sphereGeometry args={[1, 16, 16]} />
        <meshBasicMaterial color="#fb923c" transparent opacity={0} />
      </mesh>
      <pointLight ref={light} color="#fb923c" distance={20} intensity={0} />
    </group>
  );
}

function Agent({ target, carrying }: { target: THREE.Vector3; carrying: "none" | "key" | "c4" }) {
  const ref = useRef<THREE.Group>(null);
  useEffect(() => {
    ref.current?.position.copy(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useFrame((_, dt) => {
    ref.current?.position.lerp(target, 1 - Math.pow(0.0009, Math.min(dt, 0.05)));
  });
  const carryColor = carrying === "key" ? "#fbbf24" : carrying === "c4" ? "#f97316" : null;
  return (
    <group ref={ref}>
      <mesh position={[0, 0.55, 0]} castShadow>
        <capsuleGeometry args={[0.32, 0.6, 6, 14]} />
        <meshStandardMaterial color="#38bdf8" roughness={0.4} metalness={0.2} emissive="#0c4a6e" emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[0, 1.25, 0]} castShadow>
        <sphereGeometry args={[0.26, 16, 16]} />
        <meshStandardMaterial color="#bae6fd" roughness={0.4} />
      </mesh>
      {carryColor && (
        <mesh position={[0, 1.7, 0]}>
          <boxGeometry args={[0.3, 0.3, 0.3]} />
          <meshStandardMaterial color={carryColor} emissive={carryColor} emissiveIntensity={0.6} />
        </mesh>
      )}
      {/* contact shadow disc */}
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.4, 16]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.25} />
      </mesh>
    </group>
  );
}

function WaypointGraph({ activeNode }: { activeNode: BunkerNode }) {
  return (
    <group>
      {BUNKER_EDGES.map(([a, b], i) => (
        <Line key={i} points={[v(a, 0.06).toArray(), v(b, 0.06).toArray()]} color="#1e3a5f" lineWidth={1.5} dashed dashSize={0.3} gapSize={0.2} />
      ))}
      {(Object.values(N_) as BunkerNode[]).map((n) => (
        <mesh key={n} position={v(n, 0.06).toArray()} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.22, 0.32, 20]} />
          <meshBasicMaterial color={n === activeNode ? "#38bdf8" : "#1e3a5f"} transparent opacity={n === activeNode ? 0.95 : 0.6} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}

function SafeSpot() {
  const at = v(N_.SAFE);
  return (
    <group position={[at.x, at.y, at.z]}>
      <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.5, 0.7, 24]} />
        <meshBasicMaterial color="#22c55e" transparent opacity={0.5} side={THREE.DoubleSide} />
      </mesh>
      {/* a couple of sandbags for cover */}
      {[-0.35, 0.35].map((x) => (
        <mesh key={x} position={[x, 0.2, 0.5]} castShadow>
          <capsuleGeometry args={[0.18, 0.4, 4, 8]} />
          <meshStandardMaterial color="#7c6f4a" roughness={1} />
        </mesh>
      ))}
    </group>
  );
}

function Scene({ frame, reached }: { frame: BunkerFrame; reached: boolean }) {
  const f = frame.flags;
  const agentTarget = v(frame.agentNode);
  const carrying = f.hasC4 ? "c4" : f.hasKey && !f.storageUnlocked ? "key" : "none";
  const detonating = frame.action.startsWith("detonate");

  return (
    <>
      <PerspectiveCamera makeDefault position={[14, 16, 22]} fov={42} />
      <OrbitControls target={[1, 1, 1]} enablePan minDistance={8} maxDistance={60} maxPolarAngle={Math.PI / 2.05} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[18, 26, 12]} intensity={1.2} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-30} shadow-camera-right={30} shadow-camera-top={30} shadow-camera-bottom={-30} />
      <hemisphereLight args={["#9db7ff", "#0b0e14", 0.4]} />

      {/* ground */}
      <mesh position={[0, -0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[80, 80]} />
        <meshStandardMaterial color="#0f1622" roughness={0.95} />
      </mesh>
      {/* courtyard pad */}
      <mesh position={[0, 0.0, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[6, 48]} />
        <meshStandardMaterial color="#1b2433" roughness={0.85} />
      </mesh>
      <Grid args={[80, 80]} cellColor="#16203a" sectionColor="#243154" fadeDistance={70} infiniteGrid position={[0, -0.01, 0]} />

      <WaypointGraph activeNode={frame.agentNode} />
      <SafeSpot />

      <Building b={BUILDINGS.STORAGE} open={f.storageUnlocked} breached={false} />
      <Building b={BUILDINGS.BUNKER} open={false} breached={f.bunkerBreached} />

      {/* the key sits on a small table */}
      <group position={v(N_.TABLE).toArray()}>
        <mesh position={[0, 0.3, 0]} castShadow receiveShadow>
          <boxGeometry args={[1.1, 0.6, 0.8]} />
          <meshStandardMaterial color="#3b2f23" roughness={0.9} />
        </mesh>
      </group>
      <Item at={v(N_.TABLE, 0.3)} show={f.keyOnTable} color="#fbbf24" kind="key" />
      <Item at={v(N_.C4_TABLE)} show={f.c4Available} color="#f97316" kind="c4" />
      <PlantedC4 show={f.c4Placed} />
      <Item at={v(N_.STAR)} show={f.starPresent} color="#facc15" kind="star" />
      <Explosion active={detonating} />

      <Agent target={agentTarget} carrying={carrying} />

      {reached && <pointLight position={[agentTarget.x, 3, agentTarget.z]} color="#facc15" intensity={8} distance={10} />}

      <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
        <GizmoViewport axisColors={["#f87171", "#34d399", "#38bdf8"]} labelColor="#0b0e14" />
      </GizmoHelper>
    </>
  );
}

export default function BunkerScene(props: { frame: BunkerFrame; reached: boolean }) {
  return (
    <Canvas shadows dpr={[1, 2]} gl={{ antialias: true }} style={{ background: "linear-gradient(180deg,#0d1320,#080b12)" }}>
      <Scene {...props} />
    </Canvas>
  );
}
