"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FormAction } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/display";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { brightness, laplacianVariance, MAX_LISTING_PHOTOS, photoFileProblem, PHOTO_TYPES, qualityWarnings } from "@/lib/listing";

type Shot = { shotType: string; label: string; instructions: string; required: boolean };
type Photo = { id: string; shotType: string; sortOrder: number; status: "processing" | "ready" | "failed"; url: string | null };
type Thresholds = { minBrightness: number; maxBrightness: number; blurThreshold: number };
type Actions = { request: FormAction; confirm: FormAction; remove: FormAction; move: FormAction };

const METRIC_EDGE = 512; // must match METRIC_EDGE_PX on the server

/** Brightness and blur measured on the device before upload (brief §9 step 4), on the same scale as the server. */
async function measure(file: File) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, METRIC_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(3, Math.round(bitmap.width * scale));
  const h = Math.max(3, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0; i < gray.length; i++) gray[i] = 0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!;
  return { brightness: brightness(gray), blur: laplacianVariance(gray, w, h) };
}

const fd = (fields: Record<string, string | number>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, String(v));
  return f;
};

/**
 * Step 4: the category's shot list plus extra photos. Files go straight to private storage through a
 * signed URL; the server then removes EXIF/GPS and checks the file. Thumbnails use short-lived signed URLs.
 */
export function PhotoUploader({
  listingId,
  initialPhotos,
  shots,
  minPhotos,
  thresholds,
  actions,
}: {
  listingId: string;
  initialPhotos: Photo[];
  shots: Shot[];
  minPhotos: number;
  thresholds: Thresholds;
  actions: Actions;
}) {
  const [photos, setPhotos] = useState<Photo[]>(initialPhotos);
  const [busy, setBusy] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<Record<string, string[]>>({});
  const toast = useToast();
  const pending = useRef<{ file: File; shotType: string; replaces?: string } | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/listings/${listingId}/photos`, { cache: "no-store" });
    if (res.ok) setPhotos(((await res.json()) as { photos: Photo[] }).photos);
  }, [listingId]);

  // Poll while any photo is still being processed.
  useEffect(() => {
    if (!photos.some((p) => p.status === "processing")) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [photos, refresh]);

  async function upload(file: File, shotType: string, replaces?: string) {
    const problem = photoFileProblem(file);
    if (problem) return toast(problem, "error");
    setBusy(shotType);
    try {
      const slot = await actions.request(null, fd({ listingId, shotType, size: file.size, type: file.type }));
      if (!slot?.ok || !slot.data) return toast(slot?.message ?? "Couldn't start the upload. Try again.", "error");
      const { uploadUrl, photoId } = slot.data as { uploadUrl: string; photoId: string };
      const put = await fetch(uploadUrl, { method: "PUT", body: file, headers: { "content-type": file.type } });
      if (!put.ok) {
        await actions.remove(null, fd({ photoId }));
        return toast("The upload didn't finish. Check your connection and try again.", "error");
      }
      await actions.confirm(null, fd({ photoId }));
      if (replaces) await actions.remove(null, fd({ photoId: replaces }));
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function choose(file: File | undefined, shotType: string, replaces?: string) {
    if (!file) return;
    const problem = photoFileProblem(file);
    if (problem) return toast(problem, "error");
    let found: string[] = [];
    try {
      found = qualityWarnings(await measure(file), thresholds);
    } catch {
      // Some browsers can't decode every format on-device; the server still checks the file.
    }
    if (found.length) {
      pending.current = { file, shotType, replaces };
      setWarnings((w) => ({ ...w, [shotType]: found }));
      return;
    }
    setWarnings((w) => ({ ...w, [shotType]: [] }));
    await upload(file, shotType, replaces);
  }

  async function run(action: FormAction, fields: Record<string, string>) {
    const r = await action(null, fd(fields));
    if (r && !r.ok && r.message) toast(r.message, "error");
    await refresh();
  }

  const ready = photos.filter((p) => p.status === "ready").length;
  const slotFor = (shotType: string) => photos.find((p) => p.shotType === shotType);
  const extras = photos.filter((p) => !shots.some((s) => s.shotType === p.shotType) || p.shotType === "extra");

  const picker = (shotType: string, label: string, replaces?: string) => (
    <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 border border-ink bg-surface px-4 font-semibold hover:bg-page has-focus-visible:outline-2 has-focus-visible:outline-action">
      <input type="file" accept={PHOTO_TYPES.join(",")} className="sr-only" disabled={busy !== null} onChange={(e) => void choose(e.target.files?.[0], shotType, replaces)} />
      <Icon name="plus" size="sm" />
      {busy === shotType ? "Uploading" : label}
    </label>
  );

  const thumb = (p: Photo, index: number) => (
    <div className="flex flex-col gap-2">
      <div className="flex aspect-square w-full items-center justify-center border border-rule bg-page">
        {p.status === "ready" && p.url ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL from private storage
          <img loading="lazy" decoding="async" src={p.url} alt={`Photo ${index + 1}`} className="h-full w-full object-cover" />
        ) : p.status === "processing" ? (
          <span className="text-sm text-steel">Checking photo</span>
        ) : (
          <span className="p-2 text-center text-sm text-danger">This file couldn&apos;t be used. Remove it and try another photo.</span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-2">
        {index === 0 ? <Badge tone="neutral" icon={false}>Main photo</Badge> : <Button variant="tertiary" onClick={() => void run(actions.move, { photoId: p.id, to: "first" })}>Make main photo</Button>}
        <Button variant="tertiary" onClick={() => void run(actions.remove, { photoId: p.id })}>Remove</Button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <p className="num text-steel" aria-live="polite">
        {ready} of at least {minPhotos} photos ready. Up to {MAX_LISTING_PHOTOS} in total.
      </p>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {shots.map((s) => {
          const p = slotFor(s.shotType);
          const index = p ? photos.indexOf(p) : -1;
          return (
            <li key={s.shotType} className="flex flex-col gap-2 border border-rule bg-surface p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{s.label}</span>
                {s.required ? <Badge tone="neutral" icon={false}>Required</Badge> : null}
              </div>
              <p className="text-sm text-steel">{s.instructions}</p>
              {p ? thumb(p, index) : null}
              {warnings[s.shotType]?.length ? (
                <div role="alert" className="flex flex-col gap-2 border border-caution bg-caution-tint p-2 text-sm text-caution">
                  {warnings[s.shotType]!.map((w) => <p key={w}>{w}</p>)}
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => { const q = pending.current; setWarnings((w) => ({ ...w, [s.shotType]: [] })); if (q) void upload(q.file, q.shotType, q.replaces); }}>Use it anyway</Button>
                  </div>
                </div>
              ) : null}
              {picker(s.shotType, p ? "Replace photo" : "Add photo", p?.id)}
            </li>
          );
        })}
      </ul>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg">More photos (optional)</h2>
        {extras.length ? (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {extras.map((p) => <li key={p.id}>{thumb(p, photos.indexOf(p))}</li>)}
          </ul>
        ) : null}
        {warnings.extra?.length ? (
          <div role="alert" className="flex flex-col gap-2 border border-caution bg-caution-tint p-2 text-sm text-caution">
            {warnings.extra.map((w) => <p key={w}>{w}</p>)}
            <Button variant="secondary" onClick={() => { const q = pending.current; setWarnings((w) => ({ ...w, extra: [] })); if (q) void upload(q.file, "extra"); }}>Use it anyway</Button>
          </div>
        ) : null}
        {photos.length < MAX_LISTING_PHOTOS ? <div>{picker("extra", "Add another photo")}</div> : null}
      </section>
    </div>
  );
}
