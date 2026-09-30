"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

// shadcn/ui's Dialog, cut down to the dashboard's popups. Drawn in a portal
// on <body>: inside a screen, an ancestor with a transform (an entrance
// animation) became the frame of every `fixed` popup, which shrank to that
// screen's height and hid its results, and dimmed only that rectangle
// (user, 2026-09-30). The backdrop dims towards the edges and blurs the page
// a little, fading in (`popup-backdrop` in globals.css).
//
// `className` places and frames the panel itself (it is `fixed`). A popup
// that asks something that must be answered is `dismissable={false}`: no
// closing by Escape or by a click beside it.
function Popup({ title, onClose, dismissable = true, className, style, role, children }: {
  title: string;
  onClose?: () => void;
  dismissable?: boolean;
  className?: string;
  style?: React.CSSProperties;
  role?: "dialog" | "alertdialog";
  children: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Root open onOpenChange={open => { if (!open && dismissable) onClose?.(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-slot="dialog-overlay" className="popup-backdrop fixed inset-0 z-[300]" />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          aria-describedby={undefined}
          role={role}
          className={cn("popup-panel fixed z-[301] outline-none", className)}
          style={style}
          onInteractOutside={dismissable ? undefined : e => e.preventDefault()}
          onEscapeKeyDown={dismissable ? undefined : e => e.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export { Popup };
