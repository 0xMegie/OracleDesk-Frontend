"use client";

import React, { Profiler, useEffect, useState } from "react";

/**
 * Dev-only render profiler for realtime feeds (issue #41). Enabled with
 * ?profile=1 outside production; logs commits and actualDuration per second.
 * In production builds this renders children only and the branch is removed.
 */
export function FeedProfiler({ id, children }: { id: string; children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    setEnabled(new URLSearchParams(window.location.search).get("profile") === "1");
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV === "production" || !enabled) return;
    const timer = setInterval(() => {
      const s = stats.get(id);
      if (s && s.commits > 0) {
        console.info(`[profile] ${id}: ${s.commits} commits, ${s.duration.toFixed(1)}ms actual in the last second`);
        stats.set(id, { commits: 0, duration: 0 });
      }
    }, 1_000);
    return () => clearInterval(timer);
  }, [enabled, id]);

  if (process.env.NODE_ENV === "production" || !enabled) return <>{children}</>;
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}

const stats = new Map<string, { commits: number; duration: number }>();

function onRender(id: string, _phase: string, actualDuration: number) {
  const s = stats.get(id) ?? { commits: 0, duration: 0 };
  s.commits++;
  s.duration += actualDuration;
  stats.set(id, s);
}
