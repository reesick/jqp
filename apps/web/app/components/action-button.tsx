"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Spinner } from "./spinner";
import { useToast } from "./toast";

// Toast copy for the known endpoints; anything else falls back to the label.
// Publishing is queued (the local worker does the actual upload), so the
// success message says so rather than claiming the post is already live.
function copyFor(href: string, label: string): { done: string; failed: string } {
  if (href.endsWith("/publish")) return { done: "Post queued for publishing", failed: "Couldn't publish post" };
  if (href.endsWith("/retry")) return { done: "Retry queued", failed: "Couldn't retry post" };
  return { done: `${label} done`, failed: `Couldn't ${label.toLowerCase()}` };
}

export function ActionButton({
  href,
  method = "POST",
  body,
  label,
  icon,
  confirmMessage,
  secondary,
  successMessage,
  failureMessage
}: {
  href: string;
  method?: "POST" | "PATCH";
  body?: unknown;
  label: string;
  icon?: React.ReactNode;
  confirmMessage?: string;
  secondary?: boolean;
  successMessage?: string;
  failureMessage?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = copyFor(href, label);
  // Latest run() for the toast's Retry action (avoids a stale closure).
  const runRef = useRef<() => Promise<void>>(async () => {});

  async function run(extra?: Record<string, unknown>) {
    setPending(true);
    setError(null);
    try {
      const payload = extra ? { ...(body as Record<string, unknown> | undefined), ...extra } : body;
      const res = await fetch(href, {
        method,
        headers: payload ? { "content-type": "application/json" } : undefined,
        body: payload ? JSON.stringify(payload) : undefined
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        const message = json.error ?? `Request failed (${res.status})`;
        // A failed post that Instagram may already show: ask a person to check the profile, then resend with the confirmation.
        if (res.status === 409 && href.endsWith("/retry") && !extra && typeof message === "string" && message.includes("confirmNotLive")) {
          setPending(false);
          if (window.confirm("Open the Instagram profile and check this post is NOT already there. Retrying while it is live would post it twice. Is it definitely not live?")) {
            await run({ confirmNotLive: true });
          } else {
            setError("Not retried. Check the Instagram profile first; if the post is not there, press Retry again and confirm.");
          }
          return;
        }
        setError(message);
        toast(failureMessage ?? copy.failed, { kind: "error", action: { label: "Retry", onClick: () => void runRef.current() } });
        return;
      }
      toast(successMessage ?? copy.done);
      router.refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      toast(failureMessage ?? copy.failed, { kind: "error", action: { label: "Retry", onClick: () => void runRef.current() } });
    } finally {
      setPending(false);
    }
  }
  runRef.current = run;

  async function onClick() {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    await run();
  }

  return (
    <span className="action-button">
      <button className={secondary ? "secondary" : ""} onClick={onClick} disabled={pending} aria-busy={pending}>
        {pending ? (
          <>
            <Spinner size={13} /> Working…
          </>
        ) : (
          <>
            {icon}
            {label}
          </>
        )}
      </button>
      {error ? (
        <div className="error-box" role="alert">
          {error}
        </div>
      ) : null}
    </span>
  );
}
