"use client";
import { Canvas, useFrame } from "@react-three/fiber";
import { GizmoHelper, GizmoViewport, Grid, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { BlocksFrame } from "../lib/runBlocks";

const PALETTE = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#fb7185"];

const letterCache = new Map<string, THREE.CanvasTexture>();
function letterTexture(ch: string): THREE.CanvasTexture {
  const key = ch.toUpperCase();
  const cached = letterCache.get(key);
  if (cached) return cached;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 128, 128);
  ctx.font = "bold 90px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 12;
  ctx.strokeStyle = "rgba(7,10,16,0.92)";
  ctx.strokeText(key, 64, 70);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(key, 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  letterCache.set(key, tex);
  return tex;
}

function Block({ target, color, label, held, reached }: { target: THREE.Vector3; color: string; label: string; held: boolean; reached: boolean }) {
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
      <mesh castShadow receiveShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial
          color={color}
          emissive={held ? "#1f2937" : reached ? "#064e3b" : "#000000"}
          emissiveIntensity={held ? 0.5 : reached ? 0.5 : 0}
          roughness={0.6}
          metalness={0.05}
        />
      </mesh>
      <sprite scale={[0.85, 0.85, 0.85]} renderOrder={20}>
        <spriteMaterial map={letterTexture(label)} depthTest={false} transparent />
      </sprite>
    </group>
  );
}

function Scene({ frame, blocks, reached }: { frame: BlocksFrame; blocks: string[]; reached: boolean }) {
  const colorOf = useMemo(() => {
    const sorted = [...blocks].sort();
    const m: Record<string, string> = {};
    sorted.forEach((b, i) => (m[b] = PALETTE[i % PALETTE.length]));
    return m;
  }, [blocks]);

  const targets = useMemo(() => {
    const m: Record<string, THREE.Vector3> = {};
    for (const b of blocks) {
      const [x, depth] = frame.positions[b] ?? [0, 0];
      m[b] = new THREE.Vector3(x, depth + 0.5, 0);
    }
    return m;
  }, [frame, blocks]);

  return (
    <>
      <PerspectiveCamera makeDefault position={[3.5, 3.6, 6.5]} fov={42} />
      <OrbitControls target={[0, 1, 0]} enablePan minDistance={3} maxDistance={24} maxPolarAngle={Math.PI / 2.1} />
      <ambientLight intensity={0.55} />
      <directionalLight position={[5, 9, 4]} intensity={1.15} castShadow shadow-mapSize={[1024, 1024]} />
      <hemisphereLight args={["#9db7ff", "#0b0e14", 0.4]} />

      {/* the table */}
      <mesh position={[0, -0.01, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[14, 10]} />
        <meshStandardMaterial color="#10151f" />
      </mesh>
      <Grid args={[20, 20]} cellColor="#1c2436" sectionColor="#283350" fadeDistance={26} infiniteGrid />

      {blocks.map((b) => (
        <Block key={b} target={targets[b]} color={colorOf[b]} label={b} held={frame.held === b} reached={reached} />
      ))}

      <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
        <GizmoViewport axisColors={["#f87171", "#34d399", "#38bdf8"]} labelColor="#0b0e14" />
      </GizmoHelper>
    </>
  );
}

export default function BlocksScene(props: { frame: BlocksFrame; blocks: string[]; reached: boolean }) {
  return (
    <Canvas shadows dpr={[1, 2]} gl={{ antialias: true }} style={{ background: "linear-gradient(180deg,#0d1320,#0b0e14)" }}>
      <Scene {...props} />
    </Canvas>
  );
}
