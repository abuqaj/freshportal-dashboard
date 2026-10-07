"use client";

import { LayoutGrid } from "lucide-react";
import type { translations, Lang } from "@/lib/i18n";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { playIcon } from "@/lib/motion";
import { MODULES, ModuleIcon, moduleColors, type Tab } from "./modules";

type T = (typeof translations)[Lang];

/**
 * The module switcher: the hub, the system's own modules, then the tools,
 * each in its module's colours. The open one is at full strength, ringed and
 * named; the others say their name in a tooltip. In the top bar on a wide
 * screen and in a bottom dock on a phone (page.tsx renders it in both).
 */
export default function ModuleStrip({ t, current, systemTabs, toolTabs, onSelect }: {
  t: T;
  current: Tab | "hub";
  systemTabs: Tab[];
  toolTabs: Tab[];
  onSelect: (id: Tab | "hub") => void;
}) {
  const item = (id: Tab | "hub") => {
    const on = current === id;
    const label = id === "hub" ? t.hub.back : MODULES[id].label(t);
    return (
      <Tip key={id} content={label}>
        <button
          type="button"
          aria-label={label}
          aria-current={on ? "page" : undefined}
          onClick={() => onSelect(id)}
          onPointerEnter={e => playIcon(e.currentTarget.querySelector("svg"))}
          className={cn("strip-tab", id === "hub" && "strip-home")}
          style={id === "hub" ? undefined : moduleColors(id)}
        >
          {id === "hub" ? <LayoutGrid /> : <ModuleIcon id={id} />}
          <span className="strip-label"><span>{label}</span></span>
        </button>
      </Tip>
    );
  };
  return (
    <div className="strip" data-strip>
      {item("hub")}
      {systemTabs.length > 0 && <span className="strip-sep" />}
      {systemTabs.map(item)}
      {toolTabs.length > 0 && <span className="strip-sep" />}
      {toolTabs.map(item)}
    </div>
  );
}
