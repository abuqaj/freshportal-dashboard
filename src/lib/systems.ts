export interface FPSystem {
  id: string;
  name: string;
  url: string;
  flagEmoji?: string;
  iconPath?: string;
  gradient: string;
}

export const FP_SYSTEMS: FPSystem[] = [
  {
    id: "stamgegevens",
    name: "Stamgegevens",
    url: "https://fp042100.freshportal.nl",
    iconPath: "/icons/crown.svg",
    gradient: "bg-gradient-to-br from-emerald to-[#0D5430]",
  },
  {
    id: "piazza",
    name: "Piazza dei Fiori",
    url: "https://850295.freshportal.nl",
    flagEmoji: "🇮🇹",
    gradient: "bg-gradient-to-br from-[#009246] to-[#006830]",
  },
  {
    id: "ecuador",
    name: "Ecuador",
    url: "https://850255.freshportal.nl",
    flagEmoji: "🇪🇨",
    gradient: "bg-gradient-to-br from-[#E8A200] to-[#A86E00]",
  },
  {
    id: "netherlands",
    name: "Netherlands",
    url: "https://fp012603.freshportal.com",
    flagEmoji: "🇳🇱",
    gradient: "bg-gradient-to-br from-[#AE1C28] to-[#7A1320]",
  },
  {
    id: "kenya",
    name: "Kenya",
    url: "https://850254.freshportal.nl",
    flagEmoji: "🇰🇪",
    gradient: "bg-gradient-to-br from-[#006600] to-[#004000]",
  },
  {
    id: "coloriginz",
    name: "Coloriginz",
    url: "https://fp066801.freshportal.com",
    iconPath: "/icons/coloriginz.svg",
    gradient: "bg-gradient-to-br from-[#7C3AED] to-[#4C1D95]",
  },
];

export const DEFAULT_SYSTEM = FP_SYSTEMS[0];
