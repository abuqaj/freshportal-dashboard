import { preload } from "react-dom";

// The company's runner with his tulips, running on the spot while a shipment
// is being created in FreshPortal (user, 2026-09-30): he bobs in his stride
// over ground that slides away under him, kicking up dust behind the back
// boot, and every second stride his hat hops off, turns over and lands back
// (user, 2026-10-01). Still under reduced motion.
//
// Both drawings are the user's SVGs, slimmed (coordinates rounded, the
// tracer's faint grey fringes dropped): 8 KB over the wire where the PNG
// was 78 KB, which loaded slowly while the shipment's own requests ran.
const RUNNER = "/mascot-runner.svg";
const HAT = "/fast-delivery-hat.svg";

/** Fetches both drawings ahead, from the review step, so the runner is there
 *  the moment the shipment is being created. Call while rendering. */
export function preloadMascot() {
  preload(RUNNER, { as: "image" });
  preload(HAT, { as: "image" });
}

export default function MascotRunner({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center gap-3">
      <div className="relative w-64 h-44 overflow-hidden" aria-hidden="true">
        <span className="mascot-shadow absolute bottom-2 left-1/2 -translate-x-1/2 w-36 h-3" />
        <span className="mascot-dust absolute bottom-11 left-9 size-3 rounded-full bg-sand" />
        <span className="mascot-dust mascot-dust-late absolute bottom-9 left-12 size-2 rounded-full bg-taupe/40" />
        <span className="mascot-dust mascot-dust-late absolute bottom-3 right-10 size-2.5 rounded-full bg-sand" />
        {/* The runner and his hat bob together; the hat sits on his head,
            placed in the drawing's own 435 x 348 units. */}
        <div className="mascot-run absolute bottom-3 left-1/2 -translate-x-1/2 w-44 aspect-[435/348]">
          <img src={RUNNER} alt="" width={435} height={348}
            className="absolute inset-0 size-full select-none" draggable={false} />
          <span className="mascot-hat absolute left-[24.8%] top-[12.6%] w-[18.4%] aspect-square">
            <img src={HAT} alt="" width={74} height={74}
              className="block size-full rotate-[40deg] select-none" draggable={false} />
          </span>
        </div>
        <span className="mascot-ground absolute bottom-1 inset-x-0 h-[3px] rounded-full" />
      </div>
      <p className="text-sm font-semibold text-ink">{label}</p>
    </div>
  );
}
