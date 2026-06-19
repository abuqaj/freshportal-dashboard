"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { translations, Lang } from "@/lib/i18n";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

interface Props { lang: Lang; }

type PhotoPhase = "idle" | "analyzing" | "review" | "uploading" | "done";
type ProductMatchItem = { product_id: string; name: string; vbn_number: string; similarity: number };
type ReviewItem = {
  filename: string;
  thumbnailUrl: string;
  normalized_name: string;
  selected: ProductMatchItem[];
  alternatives: ProductMatchItem[];
  approved: boolean;
};
type UploadResultItem = { filename: string; product_name: string; status: "pending" | "ok" | "error"; message?: string };

function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

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

  const approvedItems    = reviewItems.filter(i => i.approved && i.selected.length > 0);
  const totalAssignments = approvedItems.reduce((s, i) => s + i.selected.length, 0);
  const uploadLabel      = photoPhase === "review" ? t.photo.uploadBtn(approvedItems.length, totalAssignments) : "";

  return (
    <div className="bg-surface rounded-2xl border border-border overflow-hidden shadow-[0_8px_40px_-8px_rgba(0,0,0,0.18)] card-enter">

      {/* ── Header ── */}
      <div className="px-6 py-5 border-b border-border flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-ink">{t.nav.photoUploader}</h2>
          <p className="text-xs text-ink-3 mt-0.5">
            {photoPhase === "review" ? t.photo.reviewInstruction : t.photo.description}
          </p>
        </div>
        {photoPhase !== "idle" && (
          <button
            onClick={resetPhotoUploader}
            className="flex-shrink-0 text-xs text-ink-3 hover:text-ink border border-border rounded-lg px-3 py-1.5 bg-surface hover:bg-muted transition-colors whitespace-nowrap"
          >
            {t.photo.startOver}
          </button>
        )}
      </div>

      {/* ── Body ── */}
      <div className="p-5 space-y-4">

        {photoError && (
          <div className="text-xs text-ember bg-ember-light border border-ember/20 rounded-xl px-4 py-3">
            {photoError}
          </div>
        )}

        {/* ── IDLE ── */}
        {photoPhase === "idle" && (
          <div
            className="border-2 border-dashed border-border rounded-2xl p-14 text-center hover:border-emerald hover:bg-emerald-light/20 transition-all cursor-pointer group"
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); if (e.dataTransfer.files.length) analyzePhotos(e.dataTransfer.files); }}
            onClick={() => document.getElementById("photo-file-input")?.click()}
          >
            <input id="photo-file-input" type="file" accept="image/*" multiple className="hidden"
              onChange={e => { if (e.target.files?.length) analyzePhotos(e.target.files); }} />
            <div className="w-12 h-12 bg-ground border border-border rounded-2xl flex items-center justify-center mx-auto mb-4 group-hover:border-emerald/40 group-hover:bg-emerald-light/40 transition-all">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="text-ink-3 group-hover:text-emerald transition-colors">
                <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.5"/>
                <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/>
                <path d="M3 15l5-5 4 4 3-3 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <p className="text-sm font-medium text-ink">{t.photo.dropTitle}</p>
            <p className="text-xs text-ink-3 mt-1">{t.photo.dropHint}</p>
            {photoAnalyzing && (
              <div className="mt-5 flex items-center justify-center gap-2 text-xs text-emerald">
                <Spinner className="h-3.5 w-3.5" />
                <span>{photoStatusMsg ?? t.photo.analyzing}</span>
              </div>
            )}
          </div>
        )}

        {/* ── ANALYZING ── */}
        {photoPhase === "analyzing" && (
          <div className="flex flex-col items-center justify-center gap-4 py-14">
            <Spinner className="h-7 w-7 text-emerald" />
            <p className="text-sm text-ink-3">{photoStatusMsg ?? t.photo.analyzing}</p>
            <button
              onClick={resetPhotoUploader}
              className="text-xs text-ink-3 hover:text-ember border border-border hover:border-ember/20 rounded-lg px-4 py-1.5 bg-ground hover:bg-ember-light/50 transition-colors"
            >{t.common.cancel}</button>
          </div>
        )}

        {/* ── REVIEW ── */}
        {photoPhase === "review" && reviewItems.length > 0 && (
          <div className="border border-border rounded-2xl overflow-hidden card-enter">

            {/* Review header */}
            <div className="px-5 py-3.5 border-b border-border flex items-center justify-between bg-ground/60">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-ink">{t.photo.reviewTitle}</span>
                <span className="text-xs text-ink-3 bg-muted px-2 py-0.5 rounded-full">{reviewItems.length}</span>
              </div>
              <span className="text-xs text-ink-3">{approvedItems.length} {t.photo.approved}</span>
            </div>

            {/*
              Scrollable container with sticky footer.
              The footer uses position:sticky bottom-0 INSIDE the overflow-y-auto div.
              This is the only reliable way to keep it always visible:
              - when content fits: footer sits naturally at the bottom
              - when content overflows and user scrolls: footer sticks to bottom of visible area
              No flex tricks, no max-h on parent, no layout knowledge needed.
            */}
            <div
              ref={scrollBodyRef}
              className="overflow-y-auto max-h-[calc(100vh-360px)]"
            >
              {/* Items */}
              <div className="divide-y divide-border">
                {reviewItems.map((item, idx) => (
                  <div key={item.filename} className="card-enter" style={{ animationDelay: `${Math.min(idx * 25, 400)}ms` }}>
                    <div className={`px-5 py-4 transition-opacity ${!item.approved ? "opacity-40" : ""}`}>

                      {/* Top: number + name + checkbox */}
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-[10px] font-semibold text-ink-3 tabular-nums w-5 text-right flex-shrink-0">{idx + 1}</span>
                        <p className="text-xs font-semibold text-ink flex-1 truncate">{item.normalized_name}</p>
                        <button
                          onClick={() => setReviewItems(prev => prev.map((r, i) => i === idx ? { ...r, approved: !r.approved } : r))}
                          disabled={item.selected.length === 0}
                          className={`flex-shrink-0 w-7 h-7 rounded-lg border-2 flex items-center justify-center transition-all ${
                            item.approved
                              ? "bg-emerald border-emerald text-white"
                              : "border-border text-transparent hover:border-emerald/50 disabled:opacity-30"
                          }`}
                        >
                          <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1.5 5.5l3 3 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </button>
                      </div>

                      {/* Body: 3-column grid — thumbnail | selected | alternatives */}
                      <div className={`grid grid-cols-[56px_1fr_1fr] gap-x-4 pl-7 ${!item.approved ? "pointer-events-none" : ""}`}>

                        {/* Col 1: Thumbnail */}
                        <div
                          className="w-14 h-14 rounded-xl overflow-hidden bg-muted flex-shrink-0 ring-1 ring-border"
                          onMouseEnter={e => handleThumbnailEnter(item.thumbnailUrl, e)}
                          onMouseLeave={handleThumbnailLeave}
                        >
                          {item.thumbnailUrl
                            ? <img src={item.thumbnailUrl} alt="" className="w-full h-full object-cover" />
                            : <div className="w-full h-full flex items-center justify-center text-ink-3">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.5"/><path d="M3 15l5-5 4 4 3-3 6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                              </div>
                          }
                        </div>

                        {/* Col 2: Selected matches — full names */}
                        <div className="min-w-0">
                          <p className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider mb-1.5">{t.photo.foundMatches}</p>
                          {item.selected.length > 0 ? (
                            <div className="rounded-lg border border-emerald/25 bg-emerald-light/20 overflow-hidden">
                              {item.selected.map((p, pi) => (
                                <div key={p.product_id} className={`flex items-start gap-2 px-2.5 py-1.5 group ${pi > 0 ? "border-t border-emerald/15" : ""}`}>
                                  <span className="text-[9px] font-bold text-emerald/50 w-3 text-center flex-shrink-0 tabular-nums mt-0.5">{pi + 1}</span>
                                  <span className="text-xs font-medium text-emerald-dark flex-1 leading-snug">{p.name}</span>
                                  <span className={`text-[10px] font-semibold flex-shrink-0 mt-0.5 mr-1 ${
                                    p.similarity >= 0.9 ? "text-emerald/70" : p.similarity >= 0.6 ? "text-amber-500/80" : "text-ember/70"
                                  }`}>{Math.round(p.similarity * 100)}%</span>
                                  <button
                                    onClick={() => setReviewItems(prev => prev.map((r, ri) => ri !== idx ? r : {
                                      ...r,
                                      selected: r.selected.filter(s => s.product_id !== p.product_id),
                                      alternatives: [p, ...r.alternatives],
                                      approved: r.selected.length > 1,
                                    }))}
                                    className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-ink-3 hover:text-ember mt-0.5"
                                  >
                                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                                  </button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-ink-3 italic">{t.photo.noMatch}</p>
                          )}
                        </div>

                        {/* Col 3: Alternative suggestions — full names, list layout */}
                        <div className="min-w-0 border-l border-border pl-4">
                          <p className="text-[10px] font-semibold text-ink-3 uppercase tracking-wider mb-1.5">{t.photo.suggestions}</p>
                          {item.alternatives.length > 0 ? (
                            <div className="flex flex-col gap-1">
                              {item.alternatives.map(alt => (
                                <button
                                  key={alt.product_id}
                                  onClick={() => setReviewItems(prev => prev.map((r, ri) => ri !== idx ? r : {
                                    ...r,
                                    selected: [...r.selected, alt],
                                    alternatives: r.alternatives.filter(a => a.product_id !== alt.product_id),
                                    approved: true,
                                  }))}
                                  className="flex items-start gap-2 text-left text-[11px] text-ink-3 hover:text-ink bg-ground hover:bg-muted border border-border rounded-md px-2.5 py-1.5 transition-colors group w-full"
                                >
                                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="text-ink-3 flex-shrink-0 mt-0.5 group-hover:text-emerald transition-colors"><path d="M4 1v6M1 4h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                                  <span className="flex-1 leading-snug">{alt.name}</span>
                                  <span className={`text-[10px] font-semibold flex-shrink-0 mt-0.5 ${
                                    alt.similarity >= 0.8 ? "text-emerald" : alt.similarity >= 0.5 ? "text-amber-500" : "text-ember"
                                  }`}>{Math.round(alt.similarity * 100)}%</span>
                                </button>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-ink-3 italic">{t.photo.noSuggestions}</p>
                          )}
                        </div>

                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Footer — sticky inside the scroll container so it's always visible */}
              <div className="sticky bottom-0 px-5 py-3.5 border-t border-border bg-surface flex justify-end gap-2 shadow-[0_-4px_12px_-4px_rgba(0,0,0,0.06)]">
                <button
                  onClick={resetPhotoUploader}
                  className="text-xs text-ink-3 border border-border rounded-lg px-3 py-2 hover:bg-muted transition-colors"
                >
                  {t.photo.cancelUpload}
                </button>
                <button
                  onClick={executePhotoUpload}
                  disabled={totalAssignments === 0}
                  className="bg-emerald hover:bg-emerald-dark disabled:opacity-40 text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors shadow-sm"
                >
                  {uploadLabel} {t.photo.uploadToFP}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── UPLOADING ── */}
        {photoPhase === "uploading" && (
          <div className="border border-border rounded-2xl overflow-hidden card-enter">
            <div className="px-5 py-3.5 border-b border-border bg-ground/60 flex items-center gap-2.5">
              <Spinner className="h-4 w-4 text-emerald flex-shrink-0" />
              <p className="text-sm font-medium text-ink flex-1">{photoStatusMsg ?? t.photo.uploadingStatus}</p>
              <button
                onClick={resetPhotoUploader}
                className="text-xs text-ink-3 hover:text-ember border border-border hover:border-ember/20 rounded-lg px-3 py-1 bg-surface hover:bg-ember-light/50 transition-colors flex-shrink-0"
              >{t.common.cancel}</button>
            </div>
            <div className="divide-y divide-border overflow-y-auto max-h-[calc(100vh-320px)]">
              {uploadResults.map(r => (
                <div key={`${r.filename}-${r.product_name}`} className="flex items-center gap-3 px-5 py-3">
                  <span className={`w-4 flex-shrink-0 ${r.status === "ok" ? "text-emerald" : r.status === "error" ? "text-ember" : "text-border"}`}>
                    {r.status === "ok"
                      ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7l4 4 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      : r.status === "error"
                      ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3L3 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
                      : <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="2" fill="currentColor"/></svg>
                    }
                  </span>
                  <span className="text-xs text-ink truncate flex-1">{r.product_name}</span>
                  <span className="text-[11px] text-ink-3 truncate max-w-40">{r.filename}</span>
                  {r.status === "error" && r.message && (
                    <span className="text-[11px] text-ember truncate max-w-32">{r.message}</span>
                  )}
                </div>
              ))}
              <div className="h-3" />
            </div>
          </div>
        )}

        {/* ── DONE ── */}
        {photoPhase === "done" && (() => {
          const ok  = uploadResults.filter(r => r.status === "ok").length;
          const err = uploadResults.filter(r => r.status === "error").length;
          return (
            <div className="space-y-3 card-enter">
              <div className={`rounded-xl px-5 py-4 border text-sm font-medium ${err === 0 ? "bg-emerald-light border-emerald/20 text-emerald-dark" : "bg-amber-50 border-amber-200 text-amber-800"}`}>
                {err === 0 ? t.photo.allOk(ok) : t.photo.uploadDone(ok, err)}
              </div>
              <div className="border border-border rounded-2xl overflow-hidden">
                <div className="divide-y divide-border overflow-y-auto max-h-[calc(100vh-360px)]">
                  {uploadResults.map(r => (
                    <div key={`${r.filename}-${r.product_name}`} className="flex items-center gap-3 px-5 py-3">
                      <span className={`w-4 flex-shrink-0 ${r.status === "ok" ? "text-emerald" : "text-ember"}`}>
                        {r.status === "ok"
                          ? <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7l4 4 6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          : <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3L3 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
                        }
                      </span>
                      <span className="text-xs text-ink truncate flex-1">{r.product_name}</span>
                      <span className="text-[11px] text-ink-3 truncate max-w-40">{r.filename}</span>
                      {r.status === "error" && r.message && (
                        <span className="text-[11px] text-ember truncate max-w-32">{r.message}</span>
                      )}
                    </div>
                  ))}
                  <div className="h-3" />
                </div>
              </div>
              <button
                onClick={resetPhotoUploader}
                className="text-xs text-emerald hover:text-emerald-dark border border-emerald/20 rounded-xl px-4 py-2 bg-emerald-light hover:bg-emerald/10 transition-colors"
              >
                {t.photo.uploadMore}
              </button>
            </div>
          );
        })()}

      </div>

      {/* ── Hover preview via portal — avoids CSS transform containment ── */}
      {mounted && previewUrl && createPortal(
        <div
          className="fixed z-[9999] rounded-2xl overflow-hidden border border-border bg-surface shadow-2xl pointer-events-none"
          style={{ left: previewPos.x, top: previewPos.y, width: 340, height: 340 }}
        >
          <img src={previewUrl} alt="" className="w-full h-full object-contain" />
        </div>,
        document.body
      )}
    </div>
  );
}
