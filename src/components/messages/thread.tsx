"use client";

import { useEffect, useRef, useState } from "react";
import type { FormAction } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

type Message = { id: string; body: string; mine: boolean; wasMasked: boolean; createdAt: string };
type Actions = { send: FormAction; markRead: FormAction; report: FormAction };

const fd = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const time = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/**
 * Message thread: history, composer, report, and polling every 3 s with back-off (PLAN.md §1.2
 * "Real-time-ish UI"). Masking happens on the server; this only shows the stored, masked text.
 */
export function Thread({ conversationId, initial, reasons, actions }: { conversationId: string; initial: Message[]; reasons: Record<string, string>; actions: Actions }) {
  const [messages, setMessages] = useState(initial);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const toast = useToast();
  const endRef = useRef<HTMLDivElement>(null);
  const lastAt = messages.at(-1)?.createdAt;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
    void actions.markRead(null, fd({ conversationId }));
  }, [messages.length, conversationId, actions]);

  useEffect(() => {
    let delay = 3000;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch(`/api/messages/${conversationId}${lastAt ? `?after=${encodeURIComponent(lastAt)}` : ""}`, { cache: "no-store" });
        if (res.ok) {
          const fresh = ((await res.json()) as { messages: Message[] }).messages;
          if (fresh.length) setMessages((m) => [...m, ...fresh.filter((f) => !m.some((x) => x.id === f.id))]);
          delay = 3000;
        }
      } catch {
        delay = Math.min(delay * 2, 30_000); // back off while offline
      }
      timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, delay);
    return () => clearTimeout(timer);
  }, [conversationId, lastAt]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    const r = await actions.send(null, fd({ conversationId, body: draft }));
    setSending(false);
    if (!r?.ok) return setError(r?.fieldErrors?.body ?? r?.message ?? "Your message wasn't sent. Try again.");
    const sent = (r.data as { message: Message }).message;
    setMessages((m) => (m.some((x) => x.id === sent.id) ? m : [...m, sent]));
    setDraft("");
    if (sent.wasMasked) toast("Contact details were hidden from your message", "neutral");
  }

  async function report(messageId: string, reason: string) {
    const r = await actions.report(null, fd({ messageId, reason }));
    toast(r?.message ?? "Report sent", r?.ok ? "success" : "error");
  }

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-3" aria-live="polite">
        {messages.length === 0 ? <li className="text-steel">No messages yet. Ask the seller about fit, condition or delivery.</li> : null}
        {messages.map((m) => (
          <li key={m.id} className={cn("flex max-w-[85%] flex-col gap-1 rounded-lg border p-3 lg:max-w-[70%]", m.mine ? "self-end border-action bg-surface" : "self-start border-rule bg-surface")}>
            <p className="whitespace-pre-line break-words">{m.body}</p>
            {m.wasMasked ? (
              <p className="flex items-start gap-1 text-sm text-steel">
                <Icon name="lock" size="sm" className="mt-0.5 shrink-0" />
                Contact details were hidden. Keep talking and paying on RePart so you&apos;re both protected.
              </p>
            ) : null}
            <span className="flex flex-wrap items-center gap-2 text-sm text-steel">
              {m.mine ? "You" : "Them"}, {time(m.createdAt)}
              {!m.mine ? (
                <details className="inline">
                  <summary className="cursor-pointer underline-offset-4 hover:underline">Report</summary>
                  <span className="mt-1 flex flex-col items-start gap-1">
                    {Object.entries(reasons).map(([k, label]) => (
                      <Button key={k} variant="tertiary" onClick={() => void report(m.id, k)}>{label}</Button>
                    ))}
                  </span>
                </details>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      <div ref={endRef} />
      <form onSubmit={send} className="flex flex-col gap-2 border-t border-rule pt-3">
        <label htmlFor="msg" className="text-sm font-semibold">Message</label>
        <textarea
          id="msg"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          maxLength={2000}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "msg-error" : undefined}
          className={cn("block w-full rounded-lg border bg-surface px-3 py-2", error ? "border-danger" : "border-rule")}
        />
        {error ? <p id="msg-error" role="alert" className="text-sm text-danger">{error}</p> : null}
        <div>
          <Button type="submit" disabled={sending || !draft.trim()}>Send message</Button>
        </div>
      </form>
    </div>
  );
}
