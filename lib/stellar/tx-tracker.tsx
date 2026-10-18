"use client";

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { NETWORK_PASSPHRASE } from "./config";
import { rpcServer } from "./clients";
import {
  evaluateTxStatus,
  loadRecords,
  mergeRecords,
  saveRecords,
  tradeInvalidationKeys,
  isValidRecord,
  type TrackedKind,
  type TrackedTx,
} from "./tx-tracker-core";
import { TxToastContainer } from "@/components/ui/tx-toast";

export type { TrackedKind, TrackedTx };

export interface TrackerApi {
  track: (tx: Omit<TrackedTx, "state" | "submittedAt">) => void;
  list: TrackedTx[];
  dismiss: (hash: string) => void;
}

const TxTrackerContext = createContext<TrackerApi | null>(null);

export function useTxTracker(): TrackerApi {
  const ctx = useContext(TxTrackerContext);
  if (!ctx) {
    throw new Error("useTxTracker must be used within TransactionTrackerProvider");
  }
  return ctx;
}

export function TransactionTrackerProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [records, setRecords] = useState<TrackedTx[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      return loadRecords(window.sessionStorage, NETWORK_PASSPHRASE);
    } catch {
      return [];
    }
  });

  const recordsRef = useRef<TrackedTx[]>(records);
  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  const channelRef = useRef<BroadcastChannel | null>(null);
  const pollerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPollingRef = useRef<boolean>(false);

  // Invalidate queries when a transaction finalises
  const invalidateFor = useCallback(
    (record: TrackedTx) => {
      if (record.kind === "usdc-transfer") {
        queryClient.invalidateQueries({ queryKey: ["stellar", "usdcBalance", record.holder] });
      } else if (record.marketId) {
        for (const key of tradeInvalidationKeys(record.marketId, record.holder)) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      }
    },
    [queryClient],
  );

  // Sync to sessionStorage
  const updateRecords = useCallback((updater: (prev: TrackedTx[]) => TrackedTx[]) => {
    setRecords((prev) => {
      const next = updater(prev);
      if (typeof window !== "undefined") {
        try {
          saveRecords(window.sessionStorage, next);
        } catch {
          // ignore storage error
        }
      }
      return next;
    });
  }, []);

  // BroadcastChannel setup for cross-tab sync and claim coordination
  useEffect(() => {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;

    try {
      const channel = new BroadcastChannel("oracledesk-tx");
      channelRef.current = channel;

      channel.onmessage = (event: MessageEvent) => {
        const data = event.data;
        if (!data || typeof data !== "object") return;

        if (data.type === "record_update" && isValidRecord(data.record, NETWORK_PASSPHRASE)) {
          updateRecords((prev) => mergeRecords(prev, [data.record]));
          if (data.record.state === "confirmed") {
            invalidateFor(data.record);
          }
        } else if (data.type === "record_dismiss" && data.hash) {
          updateRecords((prev) => prev.filter((r) => r.hash.toLowerCase() !== String(data.hash).toLowerCase()));
        }
      };

      return () => {
        channel.close();
        channelRef.current = null;
      };
    } catch {
      // BroadcastChannel unavailable
    }
  }, [updateRecords, invalidateFor]);

  // Polling loop for pending records
  useEffect(() => {
    let active = true;

    async function poll() {
      if (!active) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }

      const pending = recordsRef.current.filter((r) => r.state === "pending");
      if (pending.length === 0) {
        isPollingRef.current = false;
        return;
      }

      isPollingRef.current = true;
      const server = rpcServer();

      for (const record of pending) {
        if (!active) break;
        try {
          const res = await server.getTransaction(record.hash);
          const updated = evaluateTxStatus(record, res);
          if (updated.state !== record.state || updated.ledger !== record.ledger) {
            updateRecords((prev) => mergeRecords(prev, [updated]));
            if (updated.state === "confirmed") {
              invalidateFor(updated);
            }
            channelRef.current?.postMessage({ type: "record_update", record: updated });
          }
        } catch {
          // RPC hiccup, skip this record for this tick
        }
      }

      if (active) {
        // Backoff: 2s to 10s
        pollerTimerRef.current = setTimeout(poll, 3000);
      }
    }

    // Handle document visibility change
    function handleVisibilityChange() {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        if (pollerTimerRef.current) clearTimeout(pollerTimerRef.current);
        poll();
      }
    }

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    // Start polling immediately if pending records exist
    poll();

    return () => {
      active = false;
      if (pollerTimerRef.current) {
        clearTimeout(pollerTimerRef.current);
        pollerTimerRef.current = null;
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };
  }, [records, updateRecords, invalidateFor]);

  const track = useCallback(
    (tx: Omit<TrackedTx, "state" | "submittedAt">) => {
      const newRecord: TrackedTx = {
        ...tx,
        hash: tx.hash.toLowerCase(),
        state: "pending",
        submittedAt: Date.now(),
      };
      updateRecords((prev) => mergeRecords(prev, [newRecord]));
      channelRef.current?.postMessage({ type: "record_update", record: newRecord });

    },
    [updateRecords],
  );

  const dismiss = useCallback(
    (hash: string) => {
      const lower = hash.toLowerCase();
      updateRecords((prev) => prev.filter((r) => r.hash.toLowerCase() !== lower));
      channelRef.current?.postMessage({ type: "record_dismiss", hash: lower });
    },
    [updateRecords],
  );

  const value: TrackerApi = {
    track,
    list: records,
    dismiss,
  };

  return (
    <TxTrackerContext.Provider value={value}>
      {children}
      <TxToastContainer />
    </TxTrackerContext.Provider>
  );
}
