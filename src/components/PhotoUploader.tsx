"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { Check, Flower2, ImageIcon, Images, Layers, Loader2, Palette, RotateCcw, Upload, X } from "lucide-react";
import { translations, Lang } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import {
  Chip, Code, DoneState, DropZone, GoButton, IconButton, ModuleHeader, ProgressWait, RunnerWait, Section, Steps,
} from "@/components/ui/kit";
import { preloadMascot } from "@/components/MascotRunner";
import { cn } from "@/lib/utils";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

interface Props { lang: Lang; }

type PhotoPhase = "idle" | "analyzing" | "review" | "uploading" | "done";
// The facts past the name are optional: a backend from before 2026-10-08
// sends only the VBN and the group.
type ProductMatchItem = {
  product_id: string;
  name: string;
  vbn_number: string;
  product_group: string;
  similarity: number;
  product_number?: string;
  application?: string;
  product_gtin?: string;
  color?: string;
};
type ReviewItem = {
  filename: string;
  thumbnailUrl: string;
  normalized_name: string;
  selected: ProductMatchItem[];
  alternatives: ProductMatchItem[];
  approved: boolean;
};
type UploadResultItem = { filename: string; product_name: string; status: "pending" | "ok" | "error"; message?: string };

const PHOTO_EXTS = [".jpg", ".png", ".webp", ".gif", ".bmp"];

export default function PhotoUploader({ lang }: Props) {
  const t = translations[lang];

  const [photoPhase, setPhotoPhase]         = useState<PhotoPhase>("idle");
  const [photoSessionId, setPhotoSessionId] = useState<string | null>(null);
  const [reviewItems, setReviewItems]       = useState<ReviewItem[]>([]);
  const [uploadResults, setUploadResults]   = useState<UploadResultItem[]>([]);
  const [photoAnalyzing, setPhotoAnalyzing] = useState(false);
  const [photoError, setPhotoError]         = useState<string | null>(null);
  const [photoStatusMsg, setPhotoStatusMsg] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const scrollBodyRef = useRef<HTMLDivElement>(null);
  const hoverTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef      = useRef<AbortController | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewPos, setPreviewPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  useEffect(() => { setMounted(true); }, []);

  function handleThumbnailEnter(url: string, e: React.MouseEvent<HTMLElement>) {
    if (!url) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => {
      const W = 340, H = 340;
      let x = rect.right + 14;
      let y = rect.top + rect.height / 2 - H / 2;
      if (x + W > window.innerWidth - 16) x = rect.left - W - 14;
      if (y < 8) y = 8;
      if (y + H > window.innerHeight - 8) y = window.innerHeight - H - 8;
      setPreviewUrl(url);
      setPreviewPos({ x, y });
    }, 500);
  }

  function handleThumbnailLeave() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setPreviewUrl(null);
  }

  function resetPhotoUploader() {
    abortRef.current?.abort();
    abortRef.current = null;
    reviewItems.forEach(i => { try { URL.revokeObjectURL(i.thumbnailUrl); } catch { /* ok */ } });
    setPhotoPhase("idle");
    setPhotoSessionId(null);
    setReviewItems([]);
    setUploadResults([]);
    setPhotoError(null);
    setPhotoStatusMsg(null);
    setPreviewUrl(null);
  }

  async function analyzePhotos(fileList: FileList) {
    if (!RAILWAY || fileList.length === 0) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhotoAnalyzing(true);
    setPhotoPhase("analyzing");
    setPhotoError(null);
    setPhotoStatusMsg(t.photo.uploadingN(fileList.length));

    const thumbMap: Record<string, string> = {};
    const fd = new FormData();
    Array.from(fileList).forEach(f => {
      fd.append("files", f);
      thumbMap[f.name] = URL.createObjectURL(f);
    });

    try {
      const res = await fetch(`${RAILWAY}/photo-upload/analyze/stream`, { method: "POST", body: fd, signal: ctrl.signal });
      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => ({}));
        throw new Error((errData as { detail?: string }).detail ?? `HTTP ${res.status}`);
      }

      let sessionId = "";
      let total = 0;
      const items: ReviewItem[] = [];
      let phaseSet = false;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }

          if (ev.type === "session") {
            sessionId = ev.session_id as string;
            total = ev.total as number;
            setPhotoStatusMsg(t.photo.matchingPhotos(0, total));
          } else if (ev.type === "match") {
            const m = ev as { filename: string; normalized_name: string; matches: ProductMatchItem[] };
            const perfect = m.matches.filter(x => x.similarity >= 0.99);
            const rest    = m.matches.filter(x => x.similarity < 0.99);
            const sel: ProductMatchItem[]  = perfect.length > 0 ? perfect : (m.matches.length > 0 ? [m.matches[0]] : []);
            const alts: ProductMatchItem[] = perfect.length > 0 ? rest.slice(0, 2) : m.matches.slice(1, 3);
            items.push({
              filename: m.filename,
              thumbnailUrl: thumbMap[m.filename] ?? "",
              normalized_name: m.normalized_name,
              selected: sel,
              alternatives: alts,
              approved: sel.length > 0 && (sel[0]?.similarity ?? 0) >= 0.40,
            });
            setPhotoStatusMsg(t.photo.matchingPhotos(items.length, total));
          } else if (ev.type === "done") {
            setPhotoSessionId(sessionId);
            setReviewItems(items);
            setPhotoPhase("review");
            phaseSet = true;
          } else if (ev.type === "error") {
            throw new Error(ev.message as string);
          }
        }
      }

      if (!phaseSet && items.length > 0) {
        setPhotoSessionId(sessionId);
        setReviewItems(items);
        setPhotoPhase("review");
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") {
        setPhotoPhase("idle");
      } else {
        setPhotoError(e instanceof Error ? e.message : String(e));
        setPhotoPhase("idle");
      }
      Object.values(thumbMap).forEach(u => URL.revokeObjectURL(u));
    } finally {
      setPhotoAnalyzing(false);
      setPhotoStatusMsg(null);
    }
  }

  async function executePhotoUpload() {
    if (!photoSessionId || !RAILWAY) return;
    const confirmed = reviewItems
      .filter(i => i.approved && i.selected.length > 0)
      .flatMap(i => i.selected.map(p => ({ filename: i.filename, product_id: p.product_id, product_name: p.name })));
    if (confirmed.length === 0) return;

    let localResults: UploadResultItem[] = confirmed.map(c => ({ filename: c.filename, product_name: c.product_name, status: "pending" as const }));
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhotoPhase("uploading");
    setUploadResults(localResults);
    setPhotoStatusMsg(t.photo.connectingFP);

    try {
      const res = await fetch(`${RAILWAY}/photo-upload/execute/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: photoSessionId, confirmed, lang }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === "status") {
            setPhotoStatusMsg(ev.message as string);
          } else if (ev.type === "item") {
            const item = ev as { filename: string; product_name: string; status: string; message?: string };
            localResults = localResults.map(r =>
              r.filename === item.filename && r.product_name === item.product_name
                ? { ...r, status: item.status as "ok" | "error", message: item.message }
                : r
            );
            setUploadResults([...localResults]);
          } else if (ev.type === "result") {
            const d = (ev.data ?? {}) as { ok?: number; error?: number; total?: number };
            setPhotoPhase("done");
            setPhotoStatusMsg(null);
            fetch("/api/history", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "photo_upload",
                vbn_filter: null,
                stats: { ok: d.ok ?? 0, error: d.error ?? 0, total: d.total ?? localResults.length },
                details: { items: localResults },
              }),
            }).catch(() => {});
          } else if (ev.type === "error") {
            throw new Error(ev.message as string);
          }
        }
      }
    } catch (e: unknown) {
      if (!(e instanceof Error && e.name === "AbortError")) {
        setPhotoError(e instanceof Error ? e.message : String(e));
        setPhotoPhase("review");
      }
    }
  }

  /** A candidate ticked or unticked for one photo; unticking the last one
   *  leaves the photo out of the upload. */
  function toggleCandidate(idx: number, p: ProductMatchItem, on: boolean) {
    setReviewItems(prev => prev.map((r, ri) => {
      if (ri !== idx) return r;
      if (on) {
        return {
          ...r,
          selected: r.selected.filter(s => s.product_id !== p.product_id),
          alternatives: [p, ...r.alternatives],
          approved: r.selected.length > 1,
        };
      }
      return {
        ...r,
        selected: [...r.selected, p],
        alternatives: r.alternatives.filter(a => a.product_id !== p.product_id),
        approved: true,
      };
    }));
  }

  const approvedItems    = reviewItems.filter(i => i.approved && i.selected.length > 0);
  const totalAssignments = approvedItems.reduce((s, i) => s + i.selected.length, 0);
  const uploadLabel      = photoPhase === "review" ? t.photo.uploadBtn(approvedItems.length, totalAssignments) : "";
  const okCount  = uploadResults.filter(r => r.status === "ok").length;
  const errCount = uploadResults.filter(r => r.status === "error").length;
  const stepIndex = photoPhase === "idle" ? 0 : photoPhase === "analyzing" || photoPhase === "review" ? 1 : photoPhase === "uploading" ? 2 : 3;

  // The runner shows while photos go to FreshPortal; fetch him from the review on.
  preloadMascot();

  // One line per photo-to-product upload: waiting, done, or what went wrong.
  const resultList = (
    <ul className="mx-auto max-h-[calc(100vh-420px)] min-h-24 w-full max-w-[640px] overflow-y-auto rounded-2xl border border-border text-left">
      {uploadResults.map(r => (
        <li key={`${r.filename}-${r.product_name}`} className="flex items-center gap-3 border-b border-muted px-4 py-2.5 last:border-0">
          {r.status === "ok" ? <Check className="size-4 flex-none text-emerald" strokeWidth={2.6} />
            : r.status === "error" ? <X className="size-4 flex-none text-brick" strokeWidth={2.6} />
            : <Loader2 className="size-4 flex-none animate-spin text-ink-3/50" />}
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{r.product_name}</span>
          <span className="max-w-40 truncate text-[11.5px] text-ink-3">{r.filename}</span>
          {r.status === "error" && r.message && (
            <Tip content={r.message}>
              <span tabIndex={0} className="max-w-32 truncate text-[11.5px] font-semibold text-brick">{r.message}</span>
            </Tip>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <div>
      <ModuleHeader
        tab="photos"
        t={t}
        info={photoPhase === "review" ? t.photo.reviewInstruction : t.photo.description}
        chips={photoPhase === "review" ? <>
          <Chip tone="info" icon={Images} tip={t.photo.reviewTitle}>{t.photo.photosCount(reviewItems.length)}</Chip>
          <Chip tone="ok" icon={Check} tip={t.photo.approved}>{approvedItems.length}</Chip>
        </> : null}
        actions={photoPhase !== "idle" && photoPhase !== "uploading"
          ? <IconButton icon={RotateCcw} tip={t.photo.startOver} onClick={resetPhotoUploader} />
          : null}
      />
      <Section tight>
        <Steps labels={[t.photo.stepDrop, t.photo.stepReview, t.photo.stepSend]} current={stepIndex} />
      </Section>

      {/* "backwards", not "both": a kept transform would frame the hover preview. */}
      <div key={photoPhase} className="step-enter">

        {/* ── Photos ── */}
        {photoPhase === "idle" && (
          <Section className="flex flex-col gap-3">
            {photoError && <ErrorLine>{photoError}</ErrorLine>}
            <DropZone title={t.photo.dropTitle} exts={PHOTO_EXTS} accept="image/*" multiple disabled={photoAnalyzing} onFiles={analyzePhotos} />
          </Section>
        )}

        {/* ── Matching ── */}
        {photoPhase === "analyzing" && (
          <Section>
            <ProgressWait status={photoStatusMsg ?? t.photo.analyzing}>
              <Button variant="outline" size="sm" onClick={resetPhotoUploader}><X className="size-3.5" />{t.common.cancel}</Button>
            </ProgressWait>
          </Section>
        )}

        {/* ── Review ── the footer sticks inside the scroll box, so it stays in view. */}
        {photoPhase === "review" && reviewItems.length > 0 && (
          <div ref={scrollBodyRef} className="max-h-[calc(100vh-300px)] overflow-y-auto border-t border-muted">
            {photoError && <div className="px-5 pt-3"><ErrorLine>{photoError}</ErrorLine></div>}
            <ul>
              {reviewItems.map((item, idx) => {
                const candidates = [
                  ...item.selected.map(p => ({ p, on: true })),
                  ...item.alternatives.map(p => ({ p, on: false })),
                ].sort((a, b) => b.p.similarity - a.p.similarity);
                return (
                  // Photo, name and switch on top; the candidates beside the
                  // photo, or under it on a phone, where they need the width.
                  <li key={item.filename} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3.5 gap-y-2.5 border-b border-muted px-5 py-4 last:border-0">
                    {/* Thumbnail; held still, it opens large */}
                    <div
                      className={cn("grid size-14 flex-none place-items-center overflow-hidden rounded-xl bg-muted ring-1 ring-border transition-opacity sm:row-span-2 sm:size-20", !item.approved && "opacity-45")}
                      onMouseEnter={e => handleThumbnailEnter(item.thumbnailUrl, e)}
                      onMouseLeave={handleThumbnailLeave}
                    >
                      {item.thumbnailUrl
                        ? <img src={item.thumbnailUrl} alt="" className="size-full object-cover" />
                        : <ImageIcon className="size-6 text-ink-3" />}
                    </div>

                    <div className={cn("min-w-0 self-center transition-opacity sm:self-start", !item.approved && "opacity-45")}>
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="text-[10.5px] font-semibold tabular-nums text-ink-3">{idx + 1}</span>
                        <p className="truncate text-sm font-bold text-ink">{item.normalized_name}</p>
                      </div>
                      <p className="truncate text-[11.5px] text-ink-3">{item.filename}</p>
                    </div>

                    {/* The photo in or out of this upload */}
                    <Tip content={t.photo.approved}>
                      <button
                        type="button"
                        aria-pressed={item.approved}
                        aria-label={`${t.photo.approved}: ${item.normalized_name}`}
                        aria-disabled={item.selected.length === 0}
                        onClick={() => { if (item.selected.length > 0) setReviewItems(prev => prev.map((r, i) => i === idx ? { ...r, approved: !r.approved } : r)); }}
                        className={cn("grid size-9 flex-none place-items-center rounded-xl border-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald/40 active:scale-95 aria-disabled:cursor-not-allowed aria-disabled:opacity-30",
                          item.approved ? "border-emerald bg-emerald text-white" : "border-border text-transparent hover:border-emerald/50 hover:text-emerald/40")}
                      >
                        <Check className="size-4" strokeWidth={3} />
                      </button>
                    </Tip>

                    <div className={cn("col-span-3 transition-opacity sm:col-span-1 sm:col-start-2", !item.approved && "opacity-45")}>
                      {candidates.length > 0 ? (
                        <div className="flex flex-col gap-1.5">
                          {candidates.map(({ p, on }) => (
                            <Candidate key={p.product_id} p={p} on={on} t={t} onToggle={() => toggleCandidate(idx, p, on)} />
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-ink-3">{t.photo.noMatch}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="sticky bottom-0 flex items-center gap-2 border-t border-border bg-surface/95 px-5 py-3 shadow-[0_-4px_12px_-4px_rgba(0,0,0,0.06)] backdrop-blur-sm">
              <Button variant="outline" size="sm" onClick={resetPhotoUploader}><X className="size-3.5" />{t.photo.cancelUpload}</Button>
              <span className="ml-auto" />
              <GoButton icon={Upload} tip={`${uploadLabel} ${t.photo.uploadToFP}`} count={totalAssignments}
                disabled={totalAssignments === 0} onClick={executePhotoUpload} />
            </div>
          </div>
        )}

        {/* ── Uploading ── */}
        {photoPhase === "uploading" && (
          <Section className="flex flex-col gap-3">
            <RunnerWait title={t.photo.uploadingStatus} status={photoStatusMsg}>
              <Button variant="outline" size="sm" onClick={resetPhotoUploader}><X className="size-3.5" />{t.common.cancel}</Button>
            </RunnerWait>
            {resultList}
          </Section>
        )}

        {/* ── Done ── */}
        {photoPhase === "done" && (
          <Section className="flex flex-col gap-3">
            <DoneState
              tone={errCount === 0 ? "ok" : okCount === 0 ? "bad" : "warn"}
              title={errCount === 0 ? t.photo.allOk(okCount).replace(/^✓\s*/, "") : t.photo.uploadDone(okCount, errCount)}
              chips={<>
                <Chip tone="ok" size="lg" icon={Check}><b>{okCount}</b></Chip>
                {errCount > 0 && <Chip tone="bad" size="lg" icon={X}><b>{errCount}</b></Chip>}
              </>}
            >
              <Button variant="primary" onClick={resetPhotoUploader}><Upload className="size-4" />{t.photo.uploadMore}</Button>
            </DoneState>
            {resultList}
          </Section>
        )}

      </div>

      {/* Hover preview through a portal: no ancestor's transform can frame it */}
      {mounted && previewUrl && createPortal(
        <div
          className="pointer-events-none fixed z-[9999] overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
          style={{ left: previewPos.x, top: previewPos.y, width: 340, height: 340 }}
        >
          <img src={previewUrl} alt="" className="size-full object-contain" />
        </div>,
        document.body
      )}
    </div>
  );
}

type T = (typeof translations)[Lang];

/** One product a photo may go to: ticked or not, and what tells it apart
 *  from its neighbours — number, VBN, GTIN, group, application, colour
 *  (user, 2026-10-07). The whole row ticks; its box is the keyboard's way in. */
function Candidate({ p, on, t, onToggle }: { p: ProductMatchItem; on: boolean; t: T; onToggle: () => void }) {
  const pct = Math.round(p.similarity * 100);
  const words = [
    p.product_group && { icon: Layers, label: t.photo.colGroup, value: p.product_group },
    p.application && { icon: Flower2, label: t.photo.colApplication, value: p.application },
    p.color && { icon: Palette, label: t.photo.colColor, value: p.color },
  ].filter(Boolean) as { icon: typeof Layers; label: string; value: string }[];
  return (
    <div
      onClick={onToggle}
      className={cn("flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2 transition-colors",
        on ? "border-emerald/35 bg-sage/35 hover:bg-sage/50" : "border-border bg-surface hover:bg-ground")}
    >
      <button type="button" role="checkbox" aria-checked={on} aria-label={p.name}
        className={cn("mt-px grid size-[18px] flex-none place-items-center rounded-md border-2 outline-none focus-visible:ring-2 focus-visible:ring-emerald/40",
          on ? "border-emerald bg-emerald text-white" : "border-border bg-surface text-transparent")}>
        <Check className="size-3" strokeWidth={3.2} />
      </button>
      <div className="min-w-0 flex-1">
        <p className={cn("truncate text-[13px] font-semibold leading-snug", on ? "text-emerald-dark" : "text-ink")}>{p.name}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          {p.product_number && <Code tip={t.photo.colNumber}>{p.product_number}</Code>}
          <Code tone={p.vbn_number ? "mute" : "warn"} tip={t.photo.colVbn}>
            <span className="mr-1 font-sans font-medium text-ink-3">VBN</span>{p.vbn_number || "—"}
          </Code>
          {p.product_gtin && (
            <Code tip={t.photo.colGtin}><span className="mr-1 font-sans font-medium text-ink-3">GTIN</span>{p.product_gtin}</Code>
          )}
          {words.map(({ icon: Ico, label, value }) => (
            <Tip key={label} content={label}>
              <span tabIndex={0} className="inline-flex max-w-[180px] items-center gap-1 text-[11.5px] text-ink-2 outline-none">
                <Ico className="size-3 flex-none text-ink-3" /><span className="truncate">{value}</span>
              </span>
            </Tip>
          ))}
        </div>
      </div>
      <Chip tone={p.similarity >= 0.9 ? "ok" : p.similarity >= 0.6 ? "warn" : "bad"} tip={t.photo.colSimilarity}>{pct}%</Chip>
    </div>
  );
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-[12.5px] font-semibold text-brick">
      <X className="mt-px size-[15px] flex-none" strokeWidth={2.6} /><span className="break-words">{children}</span>
    </p>
  );
}
