"use client";
import { Profiler, useEffect, useRef, useState, type ProfilerOnRenderCallback, type ReactNode } from "react";

export function RealtimeProfiler({ id, children }: { id: string; children: ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  const metrics = useRef({ commits: 0, actualDuration: 0 });
  useEffect(() => {
    if (process.env.NODE_ENV === "production" || new URLSearchParams(location.search).get("profile") !== "1") return;
    const activate = setTimeout(() => setEnabled(true), 0);
    const timer = setInterval(() => {
      console.info("[realtime-profile]", id, metrics.current);
      metrics.current = { commits: 0, actualDuration: 0 };
    }, 1000);
    return () => { clearTimeout(activate); clearInterval(timer); };
  }, [id]);
  const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
    metrics.current.commits++; metrics.current.actualDuration += actualDuration;
  };
  if (process.env.NODE_ENV === "production" || !enabled) return children;
  return <Profiler id={id} onRender={onRender}>{children}</Profiler>;
}
