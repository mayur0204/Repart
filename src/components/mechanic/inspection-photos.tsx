"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormAction } from "@/components/forms/action-form";
import { Badge } from "@/components/ui/display";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { photoFileProblem, PHOTO_TYPES } from "@/lib/listing";

type Shot = { shotType: string; label: string; required: boolean };
type Photo = { id: string; shotType: string; ready: boolean; url: string | null };

const fd = (fields: Record<string, string | number>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, String(v));
  return f;
};

/**
 * Inspection photos from the category's photo guide. Files go straight to the private inspection bucket through a
 * short-lived signed URL; the server then removes EXIF/GPS. Thumbnails use short-lived signed URLs.
 */
export function InspectionPhotos({ inspectionId, shots, photos, actions }: { inspectionId: string; shots: Shot[]; photos: Photo[]; actions: { request: FormAction; confirm: FormAction } }) {
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const router = useRouter();

  async function upload(file: File | undefined, shotType: string) {
    if (!file) return;
    const problem = photoFileProblem(file);
    if (problem) return toast(problem, "error");
    setBusy(shotType);
    try {
      const slot = await actions.request(null, fd({ inspectionId, shotType, size: file.size, type: file.type }));
      if (!slot?.ok || !slot.data) return toast(slot?.message ?? "Couldn't start the upload. Try again.", "error");
      const { uploadUrl, photoId } = slot.data as { uploadUrl: string; photoId: string };
      const put = await fetch(uploadUrl, { method: "PUT", body: file, headers: { "content-type": file.type } });
      if (!put.ok) return toast("The upload didn't finish. Check your connection and try again.", "error");
      const done = await actions.confirm(null, fd({ photoId }));
      if (!done?.ok) toast(done?.message ?? "That file couldn't be used.", "error");
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {shots.map((s) => {
        const p = photos.find((x) => x.shotType === s.shotType && x.ready);
        return (
          <li key={s.shotType} className="flex flex-col gap-2 border border-rule bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{s.label}</span>
              {s.required ? <Badge tone="neutral" icon={false}>Required</Badge> : null}
              {p ? <Badge tone="fit">Added</Badge> : null}
            </div>
            {p?.url ? (
              // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL from private storage
              <img loading="lazy" decoding="async" src={p.url} alt={s.label} className="aspect-square w-full border border-rule object-cover" />
            ) : null}
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 border border-ink bg-surface px-4 font-semibold hover:bg-page has-focus-visible:outline-2 has-focus-visible:outline-action">
              <input type="file" accept={PHOTO_TYPES.join(",")} capture="environment" className="sr-only" disabled={busy !== null} onChange={(e) => void upload(e.target.files?.[0], s.shotType)} />
              <Icon name="plus" size="sm" />
              {busy === s.shotType ? "Uploading" : p ? "Replace photo" : "Take photo"}
            </label>
          </li>
        );
      })}
    </ul>
  );
}
