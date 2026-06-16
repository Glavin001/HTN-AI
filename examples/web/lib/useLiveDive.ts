"use client";
/**
 * Live, interactive deathmatch sim for the Dive scenario. Drives a real-time
 * DiveSim (4-bot free-for-all) on a wall-clock interval, and lets one slot be
 * handed between the htn-ai planner and a human player — the swap hits the RUNNING
 * sim (`setControl`), so taking over (or handing back) happens mid-match with no
 * reset. Human movement/fire is fed in via `setInput` each tick.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { DiveSim, arenaInstance, type DiveFrame } from "@scenarios/dive";

export interface PlayerInput {
  moveX: number;
  moveZ: number;
  shoot: boolean;
}

export interface LiveDive {
  frame: DiveFrame | null;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  reset: () => void;
  stepOnce: () => void;
  /** the bot currently under human control (null = all AI) */
  humanName: string | null;
  /** take over a bot (or hand control back to the AI with null) */
  takeOver: (name: string | null) => void;
  /** feed the human-controlled bot's input for the coming ticks */
  setInput: (input: PlayerInput) => void;
  names: string[];
}

/** Drives a live DiveSim. `stepMs` = wall-clock ms per sim tick (null = inactive). */
export function useLiveDive(active: boolean, stepMs: number): LiveDive {
  const simRef = useRef<DiveSim | null>(null);
  const [frame, setFrame] = useState<DiveFrame | null>(null);
  const [playing, setPlaying] = useState(true);
  const [humanName, setHumanName] = useState<string | null>(null);
  const [, bump] = useState(0);

  const reset = useCallback(() => {
    if (!active) {
      simRef.current = null;
      setFrame(null);
      return;
    }
    const sim = new DiveSim(arenaInstance(), { seed: 1, dt: 0.1 });
    simRef.current = sim;
    setHumanName(null);
    setFrame(sim.snapshot());
    setPlaying(true);
  }, [active]);

  useEffect(() => {
    reset();
  }, [reset]);

  useEffect(() => {
    if (!active || !playing) return;
    const id = setInterval(() => {
      const sim = simRef.current;
      if (!sim) return;
      sim.step();
      setFrame(sim.snapshot());
      bump((n) => (n + 1) % 1_000_000);
    }, Math.max(40, stepMs));
    return () => clearInterval(id);
  }, [active, playing, stepMs]);

  const stepOnce = useCallback(() => {
    const sim = simRef.current;
    if (!sim) return;
    sim.step();
    setFrame(sim.snapshot());
    bump((n) => (n + 1) % 1_000_000);
  }, []);

  const takeOver = useCallback(
    (name: string | null) => {
      const sim = simRef.current;
      if (!sim) return;
      if (humanName && humanName !== name) sim.setControl(humanName, "ai"); // hand the old one back
      if (name) sim.setControl(name, "human");
      setHumanName(name);
    },
    [humanName],
  );

  const setInput = useCallback(
    (input: PlayerInput) => {
      const sim = simRef.current;
      if (sim && humanName) sim.setInput(humanName, input);
    },
    [humanName],
  );

  return {
    frame,
    playing,
    setPlaying,
    reset,
    stepOnce,
    humanName,
    takeOver,
    setInput,
    names: simRef.current ? [...simRef.current.world.actors.keys()] : [],
  };
}
