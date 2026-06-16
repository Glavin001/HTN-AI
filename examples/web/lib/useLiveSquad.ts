"use client";
/**
 * Live, interactive squad sim for the "command your squad" scenario. Unlike the
 * other scenarios (deterministic precomputed replay), this drives a SquadSim in
 * real time so a player order — routed straight to `sim.command()` on the RUNNING
 * sim — makes the unit reactively replan on the very next tick. You watch the plan
 * change, not a re-baked recording.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { SquadSim, type SquadFrame, type SquadInstance } from "@scenarios/squad-combat";
import type { TraceEvent } from "htn-ai";
import { squadInstance, type SquadScenarioId } from "./runSquad";

export type Order = "engage" | "regroup" | "holdFire";

export interface LiveSquad {
  frame: SquadFrame | null;
  trace: { unit: string; e: TraceEvent }[];
  units: string[];
  instance: SquadInstance | null;
  spots: { name: string; x: number; z: number }[];
  playing: boolean;
  setPlaying: (p: boolean) => void;
  reset: () => void;
  stepOnce: () => void;
  command: (unit: string, order: Order) => void;
  lastOrder: { unit: string; order: Order; at: number } | null;
}

/** Drives a live SquadSim for `scenario` (null = inactive). `stepMs` = wall-clock ms per sim tick. */
export function useLiveSquad(scenario: SquadScenarioId | null, stepMs: number): LiveSquad {
  const simRef = useRef<SquadSim | null>(null);
  const instRef = useRef<SquadInstance | null>(null);
  const [frame, setFrame] = useState<SquadFrame | null>(null);
  const [playing, setPlaying] = useState(true);
  const [, bump] = useState(0);
  const [lastOrder, setLastOrder] = useState<{ unit: string; order: Order; at: number } | null>(null);

  const reset = useCallback(() => {
    if (!scenario) {
      simRef.current = null;
      instRef.current = null;
      setFrame(null);
      return;
    }
    const inst = squadInstance(scenario);
    instRef.current = inst;
    simRef.current = new SquadSim(inst, { seed: 1, positioning: "goap" });
    setFrame(simRef.current.snapshot());
    setLastOrder(null);
    setPlaying(true);
  }, [scenario]);

  useEffect(() => {
    reset();
  }, [reset]);

  useEffect(() => {
    if (!scenario || !playing) return;
    const id = setInterval(() => {
      const sim = simRef.current;
      if (!sim) return;
      if (sim.engagementOver()) {
        setPlaying(false);
        return;
      }
      sim.step();
      setFrame(sim.snapshot());
      bump((n) => (n + 1) % 1_000_000);
    }, Math.max(40, stepMs));
    return () => clearInterval(id);
  }, [scenario, playing, stepMs]);

  const stepOnce = useCallback(() => {
    const sim = simRef.current;
    if (sim && !sim.engagementOver()) {
      sim.step();
      setFrame(sim.snapshot());
      bump((n) => (n + 1) % 1_000_000);
    }
  }, []);

  const command = useCallback((unit: string, order: Order) => {
    const sim = simRef.current;
    if (!sim) return;
    sim.command(unit, order); // ← hits the LIVE planner; it replans next tick
    setLastOrder({ unit, order, at: Math.round(sim.world.clock * 10) / 10 });
  }, []);

  return {
    frame,
    trace: simRef.current?.trace ?? [],
    units: simRef.current?.units.map((u) => u.name) ?? [],
    instance: instRef.current,
    spots: simRef.current?.spots ?? [],
    playing,
    setPlaying,
    reset,
    stepOnce,
    command,
    lastOrder,
  };
}
