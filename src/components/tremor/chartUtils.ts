// Tremor chartColors, getYAxisDomain, hasOnlyOneValueForKey [v0.1.0] and
// useOnWindowResize [v0.0.2] — Apache-2.0, https://github.com/tremorlabs/tremor.
// Adapted (2026-10-03): the colours are the dashboard's system palette
// (globals.css @theme), not Tremor's Tailwind hues, and dark mode is dropped
// because the dashboard has none.

import * as React from "react";

export type ColorUtility = "bg" | "stroke" | "fill" | "text";

// Every class is written out in full so Tailwind finds it in the source.
export const chartColors = {
  emerald: { bg: "bg-emerald", stroke: "stroke-emerald", fill: "fill-emerald", text: "text-emerald" },
  ink: { bg: "bg-ink", stroke: "stroke-ink", fill: "fill-ink", text: "text-ink" },
  brick: { bg: "bg-brick", stroke: "stroke-brick", fill: "fill-brick", text: "text-brick" },
  taupe: { bg: "bg-taupe", stroke: "stroke-taupe", fill: "fill-taupe", text: "text-taupe" },
  sage: { bg: "bg-sage", stroke: "stroke-sage", fill: "fill-sage", text: "text-sage" },
  blush: { bg: "bg-blush", stroke: "stroke-blush", fill: "fill-blush", text: "text-blush" },
  sand: { bg: "bg-sand", stroke: "stroke-sand", fill: "fill-sand", text: "text-sand" },
} as const satisfies { [color: string]: { [key in ColorUtility]: string } };

export type AvailableChartColorsKeys = keyof typeof chartColors;

// The order series take their colours in. Checked with the dataviz palette
// validator against the white card (2026-10-03): these four keep adjacent
// series apart for colour-blind readers too (worst adjacent ΔE 13). The
// palette's pale steps — sage, blush, sand — fall below 3:1 on white and
// stay for fills and backgrounds; emerald next to brick is hard to tell
// apart with red-green colour blindness, which is why every multi-series
// chart also has a legend and a tooltip naming each series.
export const AvailableChartColors: AvailableChartColorsKeys[] = ["emerald", "ink", "brick", "taupe"];

export const constructCategoryColors = (
  categories: string[],
  colors: AvailableChartColorsKeys[],
): Map<string, AvailableChartColorsKeys> => {
  const categoryColors = new Map<string, AvailableChartColorsKeys>();
  categories.forEach((category, index) => {
    categoryColors.set(category, colors[index % colors.length]);
  });
  return categoryColors;
};

export const getColorClassName = (color: AvailableChartColorsKeys, type: ColorUtility): string => {
  const fallbackColor = { bg: "bg-taupe", stroke: "stroke-taupe", fill: "fill-taupe", text: "text-taupe" };
  return chartColors[color]?.[type] ?? fallbackColor[type];
};

export const getYAxisDomain = (autoMinValue: boolean, minValue: number | undefined, maxValue: number | undefined) => {
  const minDomain = autoMinValue ? "auto" : (minValue ?? 0);
  const maxDomain = maxValue ?? "auto";
  return [minDomain, maxDomain];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function hasOnlyOneValueForKey(array: any[], keyToCheck: string): boolean {
  const val: unknown[] = [];
  for (const obj of array) {
    if (Object.prototype.hasOwnProperty.call(obj, keyToCheck)) {
      val.push(obj[keyToCheck]);
      if (val.length > 1) return false;
    }
  }
  return true;
}

export const useOnWindowResize = (handler: () => void) => {
  React.useEffect(() => {
    const handleResize = () => handler();
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [handler]);
};
