import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn/ui's class joiner: later classes win over earlier ones of the same
// kind, so a component's defaults can be overridden from where it is used.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
