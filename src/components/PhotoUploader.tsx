"use client";

import { useState } from "react";
import { translations, Lang } from "@/lib/i18n";

const RAILWAY = process.env.NEXT_PUBLIC_RAILWAY_API_URL ?? "";

interface Props {
  lang: Lang;
}

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

export default function PhotoUploader({ lang }: Props) {
  const t = translations[lang];

  const [photoPhase, setPhotoPhase] = useState<PhotoPhase>("idle");
  const [photoSessionId, setPhotoSessionId] = useState<string | null>(null);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [uploadResults, setUploadResults] = useState<UploadResultItem[]>([]);
  const [photoAnalyzing, setPhotoAnalyzing] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoStatusMsg, setPhotoStatusMsg] = useState<string | null>(null);

  function resetPhotoUploader() {
    reviewItems.forEach(i => { try { URL.revokeObjectURL(i.thumbnailUrl); } catch { /* ok */ } });
    setPhotoPhase("idle");
    setPhotoSessionId(null);
    setReviewItems([]);
    setUploadResults([]);
    setPhotoError(null);
    setPhotoStatusMsg(null);
  }

  async function analyzePhotos(fileList: FileList) {
    if (!RAILWAY || fileList.length === 0) return;
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
      const res = await fetch(`${RAILWAY}/photo-upload/analyze/stream`, { method: "POST", body: fd });
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
            const perfect = m.matches.filter((x: ProductMatchItem) => x.similarity >= 0.99);
            const rest = m.matches.filter((x: ProductMatchItem) => x.similarity < 0.99);
            const sel: ProductMatchItem[] = perfect.length > 0 ? perfect : (m.matches.length > 0 ? [m.matches[0]] : []);
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
      setPhotoError(e instanceof Error ? e.message : String(e));
      setPhotoPhase("idle");
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
      .flatMap((i: ReviewItem) => i.selected.map((p: ProductMatchItem) => ({ filename: i.filename, product_id: p.product_id, product_name: p.name })));
    if (confirmed.length === 0) return;

    let localResults: UploadResultItem[] = confirmed.map((c: { filename: string; product_id: string; product_name: string }) => ({ filename: c.filename, product_name: c.product_name, status: "pending" as const }));
    setPhotoPhase("uploading");
    setUploadResults(localResults);
    setPhotoStatusMsg(t.photo.connectingFP);

    try {
      const res = await fetch(`${RAILWAY}/photo-upload/execute/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: photoSessionId, confirmed, lang }),
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
      setPhotoError(e instanceof Error ? e.message : String(e));
      setPhotoPhase("review");
    }
  }

  return (
    <div>
      <div className="p-6">
      <div className="card-enter mb-6 flex items-end justify-between" style={{ animationDelay: "0ms" }}>
        <div>
          <h2 className="text-2xl font-bold text-ink tracking-tight">{t.nav.photoUploader}</h2>
          <p className="text-sm text-ink-3 mt-1">{t.photo.description}</p>
        </div>
        {photoPhase !== "idle" && (
          <button onClick={resetPhotoUploader} className="text-xs text-ink-3 hover:text-ink border border-border rounded-lg px-3 py-1.5 bg-surface hover:bg-muted transition-colors flex-shrink-0">
            {t.photo.startOver}
          </button>
        )}
      </div>

      {photoError && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          ⚠ {photoError}
        </div>
      )}

      {/* idle — drop zone */}
      {photoPhase === "idle" && (
        <div
          className="card-enter bg-surface border-2 border-dashed border-border rounded-2xl p-16 text-center hover:border-emerald hover:bg-emerald-light/30 transition-all cursor-pointer"
          style={{ animationDelay: "60ms" }}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); if (e.dataTransfer.files.length) analyzePhotos(e.dataTransfer.files); }}
          onClick={() => document.getElementById("photo-file-input")?.click()}
        >
          <input
            id="photo-file-input"
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={e => { if (e.target.files?.length) analyzePhotos(e.target.files); }}
          />
          <p className="text-4xl mb-3">📷</p>
          <p className="text-sm font-medium text-neutral-700">{t.photo.dropTitle}</p>
          <p className="text-xs text-neutral-400 mt-1">{t.photo.dropHint}</p>
          {photoAnalyzing && (
            <div className="mt-4 flex items-center justify-center gap-2 text-sm text-emerald">
              <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
              <span>{photoStatusMsg ?? t.photo.analyzing}</span>
            </div>
          )}
        </div>
      )}

      {/* analyzing — spinner */}
      {photoPhase === "analyzing" && (
        <div className="bg-white border border-neutral-200 rounded-xl p-12 text-center">
          <svg className="animate-spin h-8 w-8 mx-auto text-emerald mb-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          <p className="text-sm text-neutral-600">{photoStatusMsg ?? t.photo.analyzing}</p>
        </div>
      )}

      {/* review — confirmation table */}
      {photoPhase === "review" && reviewItems.length > 0 && (() => {
        const approvedItems = reviewItems.filter(i => i.approved && i.selected.length > 0);
        const totalAssignments = approvedItems.reduce((s: number, i: ReviewItem) => s + i.selected.length, 0);
        const uploadLabel = t.photo.uploadBtn(approvedItems.length, totalAssignments);
        return (
          <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-neutral-100 flex items-center justify-between">
              <p className="text-sm font-medium text-neutral-800">
                {t.photo.reviewTitle}
                <span className="ml-2 text-xs text-neutral-400">{t.photo.photosCount(reviewItems.length)}</span>
              </p>
              <div className="flex items-center gap-3">
                <span className="text-xs text-neutral-500">{approvedItems.length} {t.photo.approved}</span>
                <button
                  onClick={executePhotoUpload}
                  disabled={totalAssignments === 0}
                  className="bg-ember hover:bg-ember-dark disabled:opacity-40 text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  {uploadLabel}
                </button>
              </div>
            </div>
            <div className="divide-y divide-neutral-50">
              {reviewItems.map((item, idx) => (
                <div key={item.filename} className={`flex items-start gap-3 px-4 py-3 ${!item.approved ? "opacity-50" : ""}`}>
                  <div className="w-10 h-10 rounded-lg overflow-hidden bg-neutral-100 flex-shrink-0 mt-0.5">
                    {item.thumbnailUrl
                      ? <img src={item.thumbnailUrl} alt="" className="w-full h-full object-cover" />
                      : <span className="text-xl flex items-center justify-center h-full">🖼</span>
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-neutral-700 leading-snug">{item.filename.replace(/\.[^.]+$/, "")}</p>
                    <p className="text-xs text-neutral-400 mb-1.5">{item.normalized_name}</p>
                    {item.selected.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {item.selected.map((p: ProductMatchItem) => (
                          <span key={p.product_id} className="inline-flex items-center gap-1 text-xs bg-emerald-light border border-emerald/30 text-emerald px-2 py-0.5 rounded-full">
                            <span>{p.name}</span>
                            <button
                              onClick={() => setReviewItems((prev: ReviewItem[]) => prev.map((r: ReviewItem, i: number) => i !== idx ? r : {
                                ...r,
                                selected: r.selected.filter((s: ProductMatchItem) => s.product_id !== p.product_id),
                                alternatives: [p, ...r.alternatives],
                                approved: r.selected.length > 1,
                              }))}
                              className="flex-shrink-0 leading-none hover:text-red-500 transition-colors"
                              title="Remove"
                            >×</button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-neutral-400 italic">{t.photo.noMatch}</p>
                    )}
                    {item.alternatives.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {item.alternatives.map((alt: ProductMatchItem) => (
                          <button
                            key={alt.product_id}
                            onClick={() => setReviewItems((prev: ReviewItem[]) => prev.map((r: ReviewItem, i: number) => i !== idx ? r : {
                              ...r,
                              selected: [...r.selected, alt],
                              alternatives: r.alternatives.filter((a: ProductMatchItem) => a.product_id !== alt.product_id),
                              approved: true,
                            }))}
                            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-dashed border-neutral-300 text-neutral-500 hover:border-emerald hover:text-emerald transition-colors"
                          >
                            <span className="text-neutral-300">+</span>
                            <span>{alt.name}</span>
                            <span className={`${alt.similarity >= 0.8 ? "text-green-500" : alt.similarity >= 0.5 ? "text-amber-500" : "text-red-400"}`}>
                              {Math.round(alt.similarity * 100)}%
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => setReviewItems(prev => prev.map((r, i) => i === idx ? { ...r, approved: !r.approved } : r))}
                    disabled={item.selected.length === 0}
                    className={`flex-shrink-0 w-8 h-8 rounded-lg border text-sm font-medium transition-colors mt-0.5 ${
                      item.approved
                        ? "bg-green-50 border-green-200 text-green-600 hover:bg-red-50 hover:border-red-200 hover:text-red-500"
                        : "bg-neutral-50 border-neutral-200 text-neutral-400 hover:bg-green-50 hover:border-green-200 hover:text-green-600"
                    }`}
                  >
                    {item.approved ? "✓" : "✗"}
                  </button>
                </div>
              ))}
            </div>
            <div className="px-5 py-3 bg-neutral-50 border-t border-neutral-100 flex justify-end gap-2">
              <button onClick={resetPhotoUploader} className="text-xs text-neutral-500 border border-neutral-200 rounded-lg px-3 py-2 hover:bg-neutral-100">
                {t.photo.cancelUpload}
              </button>
              <button
                onClick={executePhotoUpload}
                disabled={totalAssignments === 0}
                className="bg-ember hover:bg-ember-dark disabled:opacity-40 text-white text-xs font-medium px-4 py-2 rounded-lg transition-colors"
              >
                {uploadLabel} {t.photo.uploadToFP}
              </button>
            </div>
          </div>
        );
      })()}

      {/* uploading — per-file progress */}
      {photoPhase === "uploading" && (
        <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-neutral-100 flex items-center gap-2">
            <svg className="animate-spin h-4 w-4 text-emerald" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            <p className="text-sm font-medium text-neutral-700">{photoStatusMsg ?? t.photo.uploadingStatus}</p>
          </div>
          <div className="divide-y divide-neutral-50">
            {uploadResults.map(r => (
              <div key={r.filename} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                <span className={`w-5 text-center flex-shrink-0 ${r.status === "ok" ? "text-green-500" : r.status === "error" ? "text-red-500" : "text-neutral-300"}`}>
                  {r.status === "ok" ? "✓" : r.status === "error" ? "✗" : "·"}
                </span>
                <span className="text-neutral-700 truncate flex-1">{r.product_name}</span>
                <span className="text-xs text-neutral-400 truncate max-w-40">{r.filename}</span>
                {r.status === "error" && r.message && (
                  <span className="text-xs text-red-500 truncate max-w-32">{r.message}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* done — summary */}
      {photoPhase === "done" && (() => {
        const ok = uploadResults.filter(r => r.status === "ok").length;
        const err = uploadResults.filter(r => r.status === "error").length;
        return (
          <div className="space-y-3">
            <div className={`rounded-xl px-5 py-4 border text-sm font-medium ${err === 0 ? "bg-green-50 border-green-200 text-green-700" : "bg-amber-50 border-amber-200 text-amber-800"}`}>
              {err === 0 ? t.photo.allOk(ok) : t.photo.uploadDone(ok, err)}
            </div>
            <div className="bg-white border border-neutral-200 rounded-xl overflow-hidden">
              <div className="divide-y divide-neutral-50">
                {uploadResults.map(r => (
                  <div key={r.filename} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                    <span className={`w-5 text-center flex-shrink-0 font-medium ${r.status === "ok" ? "text-green-500" : "text-red-500"}`}>
                      {r.status === "ok" ? "✓" : "✗"}
                    </span>
                    <span className="text-neutral-700 truncate flex-1">{r.product_name}</span>
                    <span className="text-xs text-neutral-400 truncate max-w-40">{r.filename}</span>
                    {r.status === "error" && r.message && (
                      <span className="text-xs text-red-500 truncate max-w-32">{r.message}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <button onClick={resetPhotoUploader} className="text-sm text-ember hover:text-ember-dark border border-ember/30 rounded-xl px-4 py-2 bg-ember-light hover:bg-ember/10 transition-colors">
              {t.photo.uploadMore}
            </button>
          </div>
        );
      })()}
      </div>
    </div>
  );
}
