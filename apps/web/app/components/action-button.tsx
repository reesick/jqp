"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Spinner } from "./spinner";

export function ActionButton({
  href,
  method = "POST",
  body,
  label,
  icon,
  confirmMessage,
  secondary
}: {
  href: string;
  method?: "POST" | "PATCH";
  body?: unknown;
  label: string;
  icon?: React.ReactNode;
  confirmMessage?: string;
  secondary?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(href, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        setError(json.error ?? `Request failed (${res.status})`);
        setPending(false);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
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
      {error ? <div className="error-box">{error}</div> : null}
    </span>
  );
}
