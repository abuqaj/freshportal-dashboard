"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { DEFAULT_SYSTEM, FPSystem } from "@/lib/systems";

interface SystemContextValue {
  system: FPSystem;
  setSystem: (s: FPSystem) => void;
  fpUrlRef: React.MutableRefObject<string>;
}

const SystemContext = createContext<SystemContextValue | null>(null);

export function SystemProvider({
  children,
  userId,
  isAdmin,
}: {
  children: React.ReactNode;
  userId?: string;
  isAdmin?: boolean;
}) {
  const storageKey = userId ? `fp_system_${userId}` : "fp_system";
  const [system, setSystemState] = useState<FPSystem>(DEFAULT_SYSTEM);
  const fpUrlRef = useRef<string>(DEFAULT_SYSTEM.url);

  useEffect(() => {
    if (!isAdmin) return;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed: FPSystem = JSON.parse(saved);
        setSystemState(parsed);
        fpUrlRef.current = parsed.url;
      }
    } catch {}
  }, [storageKey, isAdmin]);

  function setSystem(s: FPSystem) {
    setSystemState(s);
    fpUrlRef.current = s.url;
    if (isAdmin) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(s));
      } catch {}
    }
  }

  return (
    <SystemContext.Provider value={{ system, setSystem, fpUrlRef }}>
      {children}
    </SystemContext.Provider>
  );
}

export function useSystem() {
  const ctx = useContext(SystemContext);
  if (!ctx) throw new Error("useSystem must be used inside SystemProvider");
  return ctx;
}
