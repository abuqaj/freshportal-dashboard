"use client";

import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { Check, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

// shadcn/ui's Checkbox in the system palette; `checked="indeterminate"`
// draws a dash, for a header box over rows that are only partly ticked.
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-4 shrink-0 cursor-pointer rounded-[4px] border border-taupe/60 bg-surface outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-emerald/40 disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:border-emerald data-[state=checked]:bg-emerald data-[state=checked]:text-white",
        "data-[state=indeterminate]:border-emerald data-[state=indeterminate]:bg-emerald data-[state=indeterminate]:text-white",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="flex items-center justify-center text-current">
        {props.checked === "indeterminate"
          ? <Minus className="size-3" strokeWidth={3} />
          : <Check className="size-3" strokeWidth={3} />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
