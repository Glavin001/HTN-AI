"use client";
/**
 * Live sim behind the /director demo page: one REAL reactive `Planner` running
 * the ~6-operator director domain in the browser, with a `PlanEventStream`
 * attached. The page's buttons mutate the live host stubs (nav mesh, traversal
 * oracle) or the planner's belief fluents — exactly how a game layer would —
 * and the structured plan events stream out via `drain()` each tick.
 *
 * This file IS the integration example: everything below the types is the
 * same wiring a host game/agent would write.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Planner, PlanEventStream, stepLabel, task, type PlanEvent } from "htn-ai";
import { directorModel, directorWorld, edgeKey, type DirectorWorld } from "@scenarios/director";
import type { Model } from "htn-ai";

export interface DirectorSnapshot {
  at: string;
  inCover: boolean;
  sealed: boolean;
  threatKnown: boolean;
  threatDown: boolean;
  regrouped: boolean;
  status: string;
  clock: number;
  /** blocked edge keys ("a|b", sorted) — drawn as rubble on the map */
  blocked: string[];
  /** live per-edge traversal costs from the oracle stub */
  costs: Record<string, number>;
  /** op labels of the currently-installed plan (from the last plan.created) */
  planOps: string[];
  currentStep: string | null;
}

export interface DirectorFeed {
  events: PlanEvent[];
  snapshot: DirectorSnapshot | null;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  /** silent live-world change: the nav mesh loses the door edge, nothing announced */
  collapseDoor: () => void;
  /** announced change: oracle re-weights the flank + host bumps navVersion */
  reweightFlank: () => void;
  /** silent belief change: the threat drops out of sight (verify/pre-check discovers it) */
  loseThreat: () => void;
  /** announced belief change: perception reports contact */
  spotThreat: () => void;
  reset: () => void;
  doorCollapsed: boolean;
  flankCheap: boolean;
}

const DOOR = edgeKey("doorstep", "room");
const MAX_EVENTS = 400;

export function useDirectorFeed(stepMs = 600): DirectorFeed {
  const worldRef = useRef<DirectorWorld | null>(null);
  const modelRef = useRef<Model | null>(null);
  const plannerRef = useRef<Planner | null>(null);
  const streamRef = useRef<PlanEventStream | null>(null);
  const clockRef = useRef({ t: 0 });
  const navVersionRef = useRef(0);
  const planOpsRef = useRef<string[]>([]);

  const [events, setEvents] = useState<PlanEvent[]>([]);
  const [snapshot, setSnapshot] = useState<DirectorSnapshot | null>(null);
  const [playing, setPlaying] = useState(true);
  const [doorCollapsed, setDoorCollapsed] = useState(false);
  const [flankCheap, setFlankCheap] = useState(false);

  const takeSnapshot = useCallback((): DirectorSnapshot | null => {
    const m = modelRef.current;
    const p = plannerRef.current;
    const w = worldRef.current;
    if (!m || !p || !w) return null;
    const flag = (f: string) => p.state.get(m.slotOf(f)) === 1;
    const atRaw = p.state.get(m.slotOf("at"));
    const cur = p.currentStep();
    return {
      at: atRaw === 0 ? "?" : m.entityNames[atRaw - 1],
      inCover: flag("inCover"),
      sealed: flag("sealed"),
      threatKnown: flag("threatKnown"),
      threatDown: flag("threatDown"),
      regrouped: flag("regrouped"),
      status: p.getStatus(),
      clock: p.clock(),
      blocked: [...w.nav.blocked],
      costs: Object.fromEntries(w.oracle),
      planOps: planOpsRef.current,
      currentStep: cur ? stepLabel(m, cur) : null,
    };
  }, []);

  const reset = useCallback(() => {
    // === the integration, end to end ===============================
    const world = directorWorld(); //           1. your live host systems
    const model = directorModel(world); //      2. compile the domain once
    const clock = { t: 0 };
    const planner = new Planner(model, {
      goals: [task("Directive")], //            3. task the agent
      now: () => clock.t,
      weight: 1,
      collectRejections: true, //               so plan.failed says WHY
    });
    const stream = new PlanEventStream();
    stream.attach(planner, "alpha"); //         4. attach the director feed
    // ===============================================================
    worldRef.current = world;
    modelRef.current = model;
    plannerRef.current = planner;
    streamRef.current = stream;
    clockRef.current = clock;
    navVersionRef.current = 0;
    planOpsRef.current = [];
    setEvents([]);
    setDoorCollapsed(false);
    setFlankCheap(false);
    setPlaying(true);
    setSnapshot(takeSnapshot());
  }, [takeSnapshot]);

  useEffect(() => {
    reset();
  }, [reset]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const planner = plannerRef.current;
      const stream = streamRef.current;
      if (!planner || !stream) return;
      planner.tick({ nodes: 200_000 }); //      5. every frame, budgeted
      clockRef.current.t = Math.round((clockRef.current.t + 0.4) * 10) / 10;
      const fresh = stream.drain(); //          6. consume the feed
      fresh.forEach((e) => {
        if (e.t === "plan.created") planOpsRef.current = e.steps.filter((s) => s.kind === "op").map((s) => s.label);
        if (e.t === "plan.completed") planOpsRef.current = []; // route done — clear it from the map
      });
      if (fresh.length > 0) setEvents((prev) => [...prev, ...fresh].slice(-MAX_EVENTS));
      setSnapshot(takeSnapshot());
      const status = planner.getStatus();
      if (status === "succeeded" || status === "failed") setPlaying(false);
    }, stepMs);
    return () => clearInterval(id);
  }, [playing, stepMs, takeSnapshot]);

  const collapseDoor = useCallback(() => {
    worldRef.current?.nav.blocked.add(DOOR);
    setDoorCollapsed(true);
    setSnapshot(takeSnapshot());
  }, [takeSnapshot]);

  const reweightFlank = useCallback(() => {
    const w = worldRef.current;
    const m = modelRef.current;
    const p = plannerRef.current;
    if (!w || !m || !p) return;
    w.oracle.set(edgeKey("start", "flank"), 0.5);
    w.oracle.set(edgeKey("flank", "cover1"), 0.5);
    p.state.set(m.slotOf("navVersion"), ++navVersionRef.current); // announce it
    setFlankCheap(true);
    setSnapshot(takeSnapshot());
  }, [takeSnapshot]);

  const loseThreat = useCallback(() => {
    const m = modelRef.current;
    const p = plannerRef.current;
    if (!m || !p) return;
    p.state.buffer[m.slotOf("threatKnown")] = 0; // silent: bypasses dirty-tracking
    setSnapshot(takeSnapshot());
  }, [takeSnapshot]);

  const spotThreat = useCallback(() => {
    const m = modelRef.current;
    const p = plannerRef.current;
    if (!m || !p) return;
    p.state.set(m.slotOf("threatKnown"), 1); // announced: dirty write
    setPlaying(true);
    setSnapshot(takeSnapshot());
  }, [takeSnapshot]);

  return { events, snapshot, playing, setPlaying, collapseDoor, reweightFlank, loseThreat, spotThreat, reset, doorCollapsed, flankCheap };
}
