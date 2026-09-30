// The company's runner with his tulips, running on the spot while a shipment
// is being created in FreshPortal (user, 2026-09-30). The drawing is the
// brand's own, cut out of the file the user gave (public/mascot-runner.png),
// not redrawn: he bobs in his stride over ground that slides away under him,
// kicking up dust behind the back boot. Still under reduced motion.
export default function MascotRunner({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center gap-3">
      <div className="relative w-64 h-44 overflow-hidden" aria-hidden="true">
        <span className="mascot-shadow absolute bottom-2 left-1/2 -translate-x-1/2 w-36 h-3" />
        <span className="mascot-dust absolute bottom-11 left-9 size-3 rounded-full bg-sand" />
        <span className="mascot-dust mascot-dust-late absolute bottom-9 left-12 size-2 rounded-full bg-taupe/40" />
        <span className="mascot-dust mascot-dust-late absolute bottom-3 right-10 size-2.5 rounded-full bg-sand" />
        <img
          src="/mascot-runner.png"
          alt=""
          width={435}
          height={348}
          className="mascot-run absolute bottom-3 left-1/2 -translate-x-1/2 w-44 h-auto select-none"
          draggable={false}
        />
        <span className="mascot-ground absolute bottom-1 inset-x-0 h-[3px] rounded-full" />
      </div>
      <p className="text-sm font-semibold text-ink">{label}</p>
    </div>
  );
}
