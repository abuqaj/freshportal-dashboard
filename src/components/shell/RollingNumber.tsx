"use client";

import { useEffect, useState } from "react";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

/**
 * A formatted number whose digits roll into place, the way bklit's charts
 * count (NumberFlow): one column of digits per place, moved by transform
 * only. It rolls up from zeros when it first shows and again on a change.
 */
export default function RollingNumber({ text }: { text: string }) {
  const [shown, setShown] = useState(() => text.replace(/\d/g, "0"));
  useEffect(() => {
    // After the zeros have been painted, so the columns have somewhere to roll from.
    const id = setTimeout(() => setShown(text), 40);
    return () => clearTimeout(id);
  }, [text]);
  return (
    <span className="roll" aria-label={text}>
      {[...shown].map((ch, i) =>
        /\d/.test(ch) ? (
          <span key={i} className="roll-digit" aria-hidden="true">
            <span className="roll-col" style={{ transform: `translateY(-${Number(ch) * 10}%)` }}>
              {DIGITS.map(d => <span key={d}>{d}</span>)}
            </span>
          </span>
        ) : (
          <span key={i} aria-hidden="true">{ch}</span>
        ),
      )}
    </span>
  );
}
