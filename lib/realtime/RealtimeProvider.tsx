"use client";

import { createContext, useContext, useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { MotionConfig } from "framer-motion";
import { io } from "socket.io-client";
import { API_URL } from "@/lib/api/client";
import { createBatcher, type Batch } from "./batch";
import { isTradeEvent, isTraceEvent, type RealtimeEvent } from "./types";

type Listener = (batch: Batch<RealtimeEvent>) => void;
const Context = createContext<Set<Listener> | null>(null);

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [listeners] = useState(() => new Set<Listener>());
  useEffect(() => {
    // One scheduler for both event kinds: mixed bursts also commit once per frame.
    const batcher = createBatcher<RealtimeEvent>();
    const stop = batcher.subscribe(batch => { for (const listener of listeners) listener(batch); });
    const visibility = () => batcher.setPaused(document.hidden);
    visibility();
    document.addEventListener("visibilitychange", visibility);
    const socket = io(API_URL.replace(/\/api\/v1\/?$/, ""));
    socket.on("TRADE_EXECUTED", (payload: unknown) => { if (isTradeEvent(payload)) batcher.push({ type: "TRADE_EXECUTED", payload, receivedAt: Date.now() }); });
    socket.on("REASONING_PUBLISHED", (payload: unknown) => { if (isTraceEvent(payload)) batcher.push({ type: "REASONING_PUBLISHED", payload, receivedAt: Date.now() }); });
    return () => { socket.disconnect(); stop(); batcher.dispose(); document.removeEventListener("visibilitychange", visibility); };
  }, [listeners]);
  return <Context.Provider value={listeners}><MotionConfig reducedMotion="user">{children}</MotionConfig></Context.Provider>;
}

export function useRealtimeBatch(handler: Listener) {
  const listeners = useContext(Context);
  const onBatch = useEffectEvent(handler);
  useEffect(() => {
    if (!listeners) throw new Error("RealtimeProvider is missing");
    const listener: Listener = batch => onBatch(batch);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, [listeners]);
}
