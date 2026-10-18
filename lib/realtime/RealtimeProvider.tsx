"use client";

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { API_URL } from "@/lib/api/client";
import { createBatcher, type Batcher, type BatchMeta } from "./batch";

/** Payloads documented in docs/api.md (Realtime). */
export interface TradeExecutedPayload {
  onChainMarketId: string;
  marketId: string | null;
  marketQuestion: string | null;
  trader: string;
  direction: "YES" | "NO";
  isBuy: boolean;
  collateralRaw: string;
  sharesRaw: string;
  feeRaw: string;
  priceYesBps: number;
  txHash: string;
  ledger: number;
  eventId: string;
}

export interface ReasoningPublishedPayload {
  onChainTraceId: string;
  onChainMarketId: string;
  traceId: string | null;
  agent: string;
  action: string;
  ipfsCid?: string;
  traceHash?: string;
  txHash?: string;
  ledger: number;
}

export interface RealtimeEvents {
  TRADE_EXECUTED: TradeExecutedPayload;
  REASONING_PUBLISHED: ReasoningPublishedPayload;
}
export type RealtimeEventName = keyof RealtimeEvents;

const EVENT_NAMES: RealtimeEventName[] = ["TRADE_EXECUTED", "REASONING_PUBLISHED"];

type Batchers = { [K in RealtimeEventName]: Batcher<RealtimeEvents[K]> };

const RealtimeContext = createContext<Batchers | null>(null);

function makeBatchers(): Batchers {
  return {
    TRADE_EXECUTED: createBatcher<TradeExecutedPayload>(),
    REASONING_PUBLISHED: createBatcher<ReasoningPublishedPayload>(),
  };
}

/**
 * One socket for the app. Handlers only push into per-event batchers; React
 * sees at most one batch per subscriber per animation frame (issue #41).
 * Hidden tabs pause all batchers and get one catch-up batch on return.
 */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [batchers] = useState(makeBatchers);

  useEffect(() => {
    const socket = io(API_URL.replace(/\/api\/v1\/?$/, ""));
    for (const name of EVENT_NAMES) {
      socket.on(name, (payload: unknown) => {
        if (payload && typeof payload === "object") {
          (batchers[name] as Batcher<unknown>).push(payload);
        }
      });
    }

    const onVisibility = () => {
      for (const name of EVENT_NAMES) batchers[name].setPaused(document.hidden);
    };
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      socket.disconnect();
    };
  }, [batchers]);

  return <RealtimeContext.Provider value={batchers}>{children}</RealtimeContext.Provider>;
}

/** Subscribe to per-frame batches of one realtime event. Idempotent under StrictMode. */
export function useRealtimeBatch<K extends RealtimeEventName>(
  eventName: K,
  handler: (batch: readonly RealtimeEvents[K][], meta: BatchMeta) => void,
) {
  const batchers = useContext(RealtimeContext);
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (!batchers) return;
    return batchers[eventName].subscribe((batch, meta) => handlerRef.current(batch as readonly RealtimeEvents[K][], meta));
  }, [batchers, eventName]);
}
