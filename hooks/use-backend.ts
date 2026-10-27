"use client";
import { useEffect, useState } from "react";

export type BackendInfo =
  | { kind: "files" }
  | { kind: "hub"; host: string; target: string; state: string; error: string; author: string | null };

/** Which backend the server uses; on the hub, re-checked so the badge follows the connection. */
export function useBackend(): BackendInfo | undefined {
  const [info, setInfo] = useState<BackendInfo>();
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      let next: BackendInfo | undefined;
      try {
        const response = await fetch("/api/backend", { cache: "no-store" });
        if (response.ok) next = await response.json() as BackendInfo;
      } catch { /* The workspace reader reports connection problems itself. */ }
      if (cancelled) return;
      if (next) setInfo(next);
      if (next?.kind !== "files") timer = setTimeout(read, 10_000);
    };
    void read();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);
  return info;
}
