"use client";

import * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

// shadcn/ui's toaster in the system palette: ink for news, brick for what
// went wrong. A toast is for what the user just did and needs no answer;
// anything the user must act on stays on the screen.
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="bottom-right"
      style={{
        "--normal-bg": "#111A14",
        "--normal-text": "#FFFFFF",
        "--normal-border": "#111A14",
        "--border-radius": "12px",
      } as React.CSSProperties}
      toastOptions={{
        classNames: {
          toast: "font-sans text-sm shadow-lg",
          error: "bg-brick! border-brick! text-white!",
          description: "text-white/80!",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
