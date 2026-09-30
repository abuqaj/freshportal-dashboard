"use client";

import * as React from "react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

// shadcn/ui's ToggleGroup in the system palette: sage track, the chosen
// item in emerald.
function ToggleGroup({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn("inline-flex items-center rounded-lg border border-sage bg-sage/40 p-0.5", className)}
      {...props}
    />
  );
}

function ToggleGroupItem({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        "inline-flex h-7 min-w-8 cursor-pointer items-center justify-center gap-1 rounded-md px-2 text-xs font-medium text-emerald-dark outline-none transition-colors",
        "hover:bg-sage focus-visible:ring-2 focus-visible:ring-emerald/40 disabled:cursor-wait",
        "data-[state=on]:bg-emerald data-[state=on]:text-white data-[state=on]:shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
