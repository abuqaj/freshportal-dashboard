import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// shadcn/ui's Button in the system palette (user, 2026-09-30). A step's
// main action is the round `go` button with an icon, never a sentence; an
// icon-only button says what it does in a tooltip (see ui/tooltip `Tip`).
// A button that cannot act yet stays hoverable with aria-disabled, so its
// tooltip can say why; `disabled` would swallow the hover.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors outline-none cursor-pointer focus-visible:ring-2 focus-visible:ring-emerald/40 disabled:pointer-events-none disabled:opacity-40 aria-disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-emerald font-semibold text-white hover:bg-emerald-dark",
        outline: "border border-border bg-surface text-ink-3 hover:border-emerald/40 hover:text-ink",
        emphasis: "border-2 border-emerald bg-emerald/8 font-semibold text-emerald hover:bg-emerald/15",
        danger: "border border-border bg-surface text-ink-3 hover:border-brick/50 hover:bg-blush/30 hover:text-brick",
        ghost: "text-ink-3 hover:bg-muted hover:text-ink",
        go: "bg-emerald text-white shadow-[0_6px_16px_rgba(26,125,69,0.32)] hover:bg-emerald-dark aria-disabled:bg-sage aria-disabled:text-emerald-dark/50 aria-disabled:shadow-none",
      },
      size: {
        default: "h-9 rounded-xl px-4 text-sm",
        sm: "h-7 rounded-lg px-3 text-xs",
        icon: "size-8 rounded-full",
        "icon-sm": "size-6 rounded-full",
        go: "relative size-12 rounded-full",
        "go-sm": "relative size-10 rounded-full",
      },
    },
    defaultVariants: { variant: "outline", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  type = "button",
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      type={asChild ? undefined : type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
