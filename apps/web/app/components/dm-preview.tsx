"use client";

import { useEffect, useState } from "react";

interface Props {
  openingDmEnabled: boolean;
  openingDmMessage: string;
  openingDmButtonLabel: string;
  dmMessage: string;
  destinationUrl: string;
  publicReplyEnabled: boolean;
  publicReplyMessage: string;
}

interface Preview {
  opening: string | null;
  button: string | null;
  dm: string;
  publicReply: string | null;
  warnings: string[];
}

/** Shows what a commenter will actually get, cleaned the same way a saved campaign is. Nothing is sent or saved. */
export function DmPreview(props: Props) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/campaigns/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(props),
          signal: controller.signal
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) {
          setError(json.error ?? "Could not build the preview.");
          return;
        }
        setError(null);
        setPreview(json.data as Preview);
      } catch {
        /* aborted or offline: keep the last preview */
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [props.openingDmEnabled, props.openingDmMessage, props.openingDmButtonLabel, props.dmMessage, props.destinationUrl, props.publicReplyEnabled, props.publicReplyMessage]);

  return (
    <div className="dm-preview" aria-live="polite">
      <div className="dm-preview-label">What the commenter receives</div>
      {error ? <p className="muted u-text-sm">{error}</p> : null}
      {preview ? (
        <>
          {preview.publicReply ? (
            <>
              <div className="dm-preview-label">Public reply under their comment</div>
              <div className="dm-bubble">{preview.publicReply}</div>
            </>
          ) : null}
          {preview.opening ? (
            <>
              <div className="dm-bubble">{preview.opening.replace(/\{username\}/gi, "Alex")}</div>
              {preview.button ? <div className="dm-button">{preview.button}</div> : null}
              <div className="dm-bubble reply">{preview.button ?? "Tap"}</div>
            </>
          ) : null}
          <div className="dm-bubble">{preview.dm ? preview.dm.replace(/\{username\}/gi, "Alex") : "(empty)"}</div>
          {preview.warnings.length > 0 ? (
            <ul className="dm-warnings">
              {preview.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : error ? null : (
        <p className="muted u-text-sm">Building preview…</p>
      )}
    </div>
  );
}
