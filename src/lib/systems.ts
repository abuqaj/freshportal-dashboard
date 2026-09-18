export interface FPSystem {
  id: string;
  name: string;
  url: string;
  svgPath: string;
  /** Brand colour as a Tailwind class, written out so the JIT can see it.
   *  The one place a system's colour is decided — Admin > Groups reads it
   *  from here rather than keeping a second copy of the palette. */
  accent: string;
  fallbackGradient: string;
}

export const FP_SYSTEMS: FPSystem[] = [
  {
    id: "stamgegevens",
    name: "Stamgegevens",
    url: "https://fp042100.freshportal.nl",
    svgPath: "/icons/systems/stamgegevens.svg",
    // No brand colour agreed yet — stays on the house emerald.
    accent: "bg-emerald",
    fallbackGradient: "bg-gradient-to-br from-emerald to-[#0D5430]",
  },
  {
    id: "piazza",
    name: "Piazza dei Fiori",
    url: "https://850295.freshportal.nl",
    svgPath: "/icons/systems/italy.svg",
    accent: "bg-[#070000]",
    fallbackGradient: "bg-gradient-to-br from-[#2E2828] to-[#070000]",
  },
  {
    id: "ecuador",
    name: "Ecuador",
    url: "https://850255.freshportal.nl",
    svgPath: "/icons/systems/ecuador.svg",
    accent: "bg-[#ffcc00]",
    fallbackGradient: "bg-gradient-to-br from-[#ffcc00] to-[#C79E00]",
  },
  {
    id: "netherlands",
    name: "Netherlands",
    url: "https://fp012603.freshportal.com",
    svgPath: "/icons/systems/netherlands.svg",
    accent: "bg-[#f79a19]",
    fallbackGradient: "bg-gradient-to-br from-[#f79a19] to-[#B86B08]",
  },
  {
    id: "kenya",
    name: "Kenya",
    url: "https://850254.freshportal.nl",
    svgPath: "/icons/systems/kenya.svg",
    accent: "bg-[#2b379c]",
    fallbackGradient: "bg-gradient-to-br from-[#2b379c] to-[#1B2367]",
  },
  {
    id: "coloriginz",
    name: "Coloriginz",
    url: "https://fp066801.freshportal.com",
    svgPath: "/icons/systems/coloriginz.svg",
    accent: "bg-[#009cde]",
    fallbackGradient: "bg-gradient-to-br from-[#009cde] to-[#006793]",
  },
];

export const DEFAULT_SYSTEM = FP_SYSTEMS[0];
