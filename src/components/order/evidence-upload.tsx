"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormAction } from "@/components/forms/action-form";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { photoFileProblem, PHOTO_TYPES } from "@/lib/listing";

const fd = (fields: Record<string, string | number>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, String(v));
  return f;
};

/**
 * Adds a dispute photo: straight to the private dispute-evidence bucket through a short-lived signed URL, then the
 * server removes EXIF/GPS. `remaining` is how many more this person may add (max 5 each).
 */
export function EvidenceUpload({ disputeId, remaining, actions }: { disputeId: string; remaining: number; actions: { request: FormAction; confirm: FormAction } }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const router = useRouter();

  async function upload(file: File | undefined) {
    if (!file) return;
    const problem = photoFileProblem(file);
    if (problem) return toast(problem, "error");
    setBusy(true);
    try {
      const slot = await actions.request(null, fd({ disputeId, size: file.size, type: file.type }));
      if (!slot?.ok || !slot.data) return toast(slot?.message ?? "Couldn't start the upload. Try again.", "error");
      const { uploadUrl, evidenceId } = slot.data as { uploadUrl: string; evidenceId: string };
      const put = await fetch(uploadUrl, { method: "PUT", body: file, headers: { "content-type": file.type } });
      if (!put.ok) return toast("The upload didn't finish. Check your connection and try again.", "error");
      const done = await actions.confirm(null, fd({ evidenceId }));
      if (!done?.ok) toast(done?.message ?? "That file couldn't be used.", "error");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (remaining <= 0) return <p className="text-sm text-steel">You&apos;ve added the maximum of 5 photos.</p>;
  return (
    <label className="inline-flex min-h-11 w-fit cursor-pointer items-center gap-2 rounded-md border border-ink bg-surface px-4 font-semibold hover:bg-page has-focus-visible:outline-2 has-focus-visible:outline-action">
      <input type="file" accept={PHOTO_TYPES.join(",")} className="sr-only" disabled={busy} onChange={(e) => void upload(e.target.files?.[0])} />
      <Icon name="plus" size="sm" />
      {busy ? "Uploading" : `Add a photo (${remaining} left)`}
    </label>
  );
}
