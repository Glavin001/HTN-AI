"use client";
import { Canvas, useFrame } from "@react-three/fiber";
import { GizmoHelper, GizmoViewport, Grid, Html, Line, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { BotFrame, DiveFrame, ItemFrame, BoxSpec } from "@scenarios/dive";
import type { PlayerInput } from "../lib/useLiveDive";

const CHEST = 0.55;

function actionIcon(action: string): string {
  if (action.startsWith("firing")) return "🎯";
  if (action.startsWith("hunting")) return "👁";
  if (action.startsWith("fetching")) return "✦";
  if (action.startsWith("exploring")) return "→";
  if (action === "respawning") return "✖";
  if (action === "thinking…") return "…";
  if (action === "you") return "🎮";
  return "•";
}

function weaponLabel(w: string): string {
  return w === "shotgun" ? "SG" : w === "rifle" ? "RF" : "BL";
}

interface SceneProps {
  frame: DiveFrame;
  halfWidth: number;
  halfDepth: number;
  selected: string | null;
  onSelect: (name: string) => void;
  humanName: string | null;
  onInput: (input: PlayerInput) => void;
}

function botPos(b: BotFrame): THREE.Vector3 {
  return new THREE.Vector3(b.x, 0.45, b.z);
}

/** A short tracer beam for a shot fired this tick. */
function Tracer({ from, to, color, hit }: { from: THREE.Vector3; to: THREE.Vector3; color: string; hit: boolean }) {
  const a = from.clone().setY(CHEST);
  const b = to.clone().setY(CHEST);
  return (
    <>
      <Line points={[a, b]} color={hit ? color : "#94a3b8"} lineWidth={hit ? 2.5 : 1.2} transparent opacity={hit ? 0.85 : 0.4} />
      <mesh position={a}>
        <sphereGeometry args={[0.15, 8, 8]} />
        <meshBasicMaterial color={color} transparent opacity={0.6} />
      </mesh>
    </>
  );
}

function Bot({ b, selected, isHuman, onSelect }: { b: BotFrame; selected: boolean; isHuman: boolean; onSelect: () => void }) {
  const ref = useRef<THREE.Group>(null);
  const dest = useMemo(() => botPos(b), [b]);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    g.position.lerp(dest, 1 - Math.pow(0.002, Math.min(dt, 0.05)));
    g.rotation.y += (b.heading - g.rotation.y) * Math.min(1, dt * 10);
  });
  const hpFrac = Math.max(0, Math.min(1, b.hp / 100));
  return (
    <group ref={ref} position={dest.toArray()} rotation={[0, b.heading, 0]}>
      <mesh castShadow onClick={(e) => { e.stopPropagation(); onSelect(); }}>
        <capsuleGeometry args={[0.32, 0.5, 6, 14]} />
        <meshStandardMaterial color={b.alive ? b.color : "#3a3f4b"} emissive={b.alive ? b.color : "#000"} emissiveIntensity={selected || isHuman ? 0.75 : 0.25} roughness={0.5} transparent opacity={b.alive ? 1 : 0.25} />
      </mesh>
      {/* gun nub (points along heading +z local) */}
      {b.alive && (
        <mesh position={[0, 0.15, 0.42]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.05, 0.05, 0.5, 8]} />
          <meshStandardMaterial color="#1f2630" />
        </mesh>
      )}
      {(selected || isHuman) && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.78, 0]}>
          <ringGeometry args={[0.55, 0.72, 32]} />
          <meshBasicMaterial color={isHuman ? "#fde047" : "#e2e8f0"} side={THREE.DoubleSide} />
        </mesh>
      )}
      {b.alive && (
        <mesh position={[-(1 - hpFrac) * 0.4, 1.0, 0]} scale={[Math.max(0.001, hpFrac), 1, 1]} rotation={[0, -b.heading, 0]}>
          <boxGeometry args={[0.8, 0.1, 0.05]} />
          <meshBasicMaterial color={hpFrac > 0.5 ? "#22c55e" : hpFrac > 0.25 ? "#f59e0b" : "#ef4444"} />
        </mesh>
      )}
      <Html position={[0, 1.5, 0]} center distanceFactor={14} style={{ pointerEvents: "none", userSelect: "none" }}>
        <div style={{ textAlign: "center", fontFamily: "ui-monospace, monospace", whiteSpace: "nowrap" }}>
          <div style={{ fontSize: 11, color: b.color, fontWeight: 700 }}>
            {b.name}
            <span style={{ color: "#9aa4b8", fontWeight: 400 }}> · {weaponLabel(b.weapon)}{b.ammo >= 0 ? ` ${b.ammo}` : ""}</span>
          </div>
          <div style={{ marginTop: 2, fontSize: 10, color: "#0b0e14", background: b.alive ? b.color : "#3a3f4b", borderRadius: 6, padding: "1px 7px", display: "inline-block", fontWeight: 600 }}>
            {actionIcon(b.action)} {b.action}
          </div>
        </div>
      </Html>
    </group>
  );
}

function Wall({ x, z, w, d }: BoxSpec) {
  return (
    <mesh position={[x + w / 2, 0.9, z + d / 2]} castShadow receiveShadow>
      <boxGeometry args={[w, 1.8, d]} />
      <meshStandardMaterial color="#161c28" roughness={0.95} />
    </mesh>
  );
}

function Item({ it }: { it: ItemFrame }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((state) => {
    const g = ref.current;
    if (!g) return;
    g.rotation.y = state.clock.elapsedTime * 1.5;
    g.position.y = 0.6 + Math.sin(state.clock.elapsedTime * 2) * 0.12;
  });
  const color = it.kind === "health" ? "#22c55e" : it.weapon === "shotgun" ? "#f97316" : "#a855f7";
  return (
    <group position={[it.x, 0.6, it.z]} visible={it.active}>
      <group ref={ref}>
        {it.kind === "health" ? (
          <group>
            <mesh><boxGeometry args={[0.5, 0.16, 0.16]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} /></mesh>
            <mesh><boxGeometry args={[0.16, 0.16, 0.5]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} /></mesh>
          </group>
        ) : (
          <mesh><boxGeometry args={[0.5, 0.22, 0.22]} /><meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} metalness={0.4} /></mesh>
        )}
      </group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.58, 0]}>
        <ringGeometry args={[0.5, 0.62, 24]} />
        <meshBasicMaterial color={color} transparent opacity={0.5} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/** Captures WASD movement + space/click to fire for the human-controlled bot, and
 *  feeds it into the live sim every frame. No-op when nobody is under human control. */
function HumanControls({ active, onInput }: { active: boolean; onInput: (i: PlayerInput) => void }) {
  const keys = useRef<Record<string, boolean>>({});
  const shoot = useRef(false);
  useEffect(() => {
    if (!active) return;
    const down = (e: KeyboardEvent) => {
      keys.current[e.key.toLowerCase()] = true;
      if (e.key === " ") shoot.current = true;
    };
    const up = (e: KeyboardEvent) => {
      keys.current[e.key.toLowerCase()] = false;
      if (e.key === " ") shoot.current = false;
    };
    const md = () => (shoot.current = true);
    const mu = () => (shoot.current = false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("mousedown", md);
    window.addEventListener("mouseup", mu);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("mousedown", md);
      window.removeEventListener("mouseup", mu);
      onInput({ moveX: 0, moveZ: 0, shoot: false });
    };
  }, [active, onInput]);
  useFrame(() => {
    if (!active) return;
    const k = keys.current;
    // screen-up (w) = -z; world axes match the top-down camera
    const mx = (k["d"] || k["arrowright"] ? 1 : 0) - (k["a"] || k["arrowleft"] ? 1 : 0);
    const mz = (k["s"] || k["arrowdown"] ? 1 : 0) - (k["w"] || k["arrowup"] ? 1 : 0);
    onInput({ moveX: mx, moveZ: mz, shoot: shoot.current });
  });
  return null;
}

function Scene({ frame, halfWidth, halfDepth, selected, onSelect, humanName, onInput }: SceneProps) {
  return (
    <>
      <PerspectiveCamera makeDefault position={[0, Math.max(halfWidth, halfDepth) * 1.5, halfDepth * 1.4]} fov={42} />
      <OrbitControls target={[0, 0, 0]} enablePan minDistance={10} maxDistance={90} maxPolarAngle={Math.PI / 2.1} />
      <ambientLight intensity={0.65} />
      <directionalLight position={[10, 20, 8]} intensity={1.1} castShadow shadow-mapSize={[1024, 1024]} />
      <hemisphereLight args={["#9db7ff", "#0b0e14", 0.4]} />

      <Grid args={[halfWidth * 2, halfDepth * 2]} cellColor="#1c2436" sectionColor="#283350" fadeDistance={120} infiniteGrid />

      {/* arena floor (click to deselect) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]} receiveShadow onClick={() => onSelect("")}>
        <planeGeometry args={[halfWidth * 2, halfDepth * 2]} />
        <meshStandardMaterial color="#0e1422" roughness={1} />
      </mesh>
      {/* arena border */}
      <Line points={[[-halfWidth, 0.02, -halfDepth], [halfWidth, 0.02, -halfDepth], [halfWidth, 0.02, halfDepth], [-halfWidth, 0.02, halfDepth], [-halfWidth, 0.02, -halfDepth]]} color="#2a3650" lineWidth={2} />

      {frame.obstacles.map((o, i) => <Wall key={i} {...o} />)}
      {frame.items.map((it) => <Item key={it.name} it={it} />)}

      {frame.shots.map((s, i) => (
        <Tracer key={i} from={new THREE.Vector3(s.from.x, 0, s.from.z)} to={new THREE.Vector3(s.to.x, 0, s.to.z)} color={frame.bots.find((b) => b.name === s.by)?.color ?? "#fff"} hit={s.hit} />
      ))}

      {frame.bots.map((b) => (
        <Bot key={b.name} b={b} selected={selected === b.name} isHuman={humanName === b.name} onSelect={() => onSelect(b.name)} />
      ))}

      <HumanControls active={!!humanName} onInput={onInput} />

      <GizmoHelper alignment="bottom-right" margin={[56, 56]}>
        <GizmoViewport axisColors={["#f87171", "#34d399", "#38bdf8"]} labelColor="#0b0e14" />
      </GizmoHelper>
    </>
  );
}

export default function DiveScene(props: SceneProps) {
  return (
    <Canvas shadows dpr={[1, 2]} gl={{ antialias: true }} style={{ background: "linear-gradient(180deg,#0d1320,#0b0e14)" }}>
      <Scene {...props} />
    </Canvas>
  );
}
