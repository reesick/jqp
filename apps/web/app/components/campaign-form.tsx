"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PostRow } from "@jqp/core";
import { Toggle } from "./toggle";
import { Spinner } from "./spinner";

interface Props {
  posts: PostRow[];
  defaultPostId?: string;
  existing?: {
    post_id: string;
    trigger_keywords: string[];
    match_mode: string;
    dm_message: string;
    destination_url: string | null;
    public_reply_enabled: boolean;
    public_reply_message: string | null;
    enabled: boolean;
  };
}

export function CampaignForm({ posts, defaultPostId, existing }: Props) {
  const router = useRouter();
  const [postId, setPostId] = useState(existing?.post_id ?? defaultPostId ?? posts[0]?.id ?? "");
  const [keywords, setKeywords] = useState(existing?.trigger_keywords.join(", ") ?? "");
  const [matchMode, setMatchMode] = useState(existing?.match_mode ?? "WHOLE_WORD");
  const [dmMessage, setDmMessage] = useState(existing?.dm_message ?? "");
  const [destinationUrl, setDestinationUrl] = useState(existing?.destination_url ?? "");
  const [publicReplyEnabled, setPublicReplyEnabled] = useState(existing?.public_reply_enabled ?? false);
  const [publicReplyMessage, setPublicReplyMessage] = useState(existing?.public_reply_message ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          postId,
          triggerKeywords: keywords,
          matchMode,
          dmMessage,
          destinationUrl,
          publicReplyEnabled,
          publicReplyMessage,
          enabled
        })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        setError(json.error ?? `Request failed (${res.status})`);
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
    <form onSubmit={onSubmit} className="card">
      <label>
        Post
        <select value={postId} onChange={(e) => setPostId(e.target.value)} required>
          {posts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.campaign_id} ({p.status})
            </option>
          ))}
        </select>
      </label>

      <label>
        Trigger keywords
        <span className="hint">Comma-separated, e.g. INFO, LINK, PRICE</span>
        <input type="text" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="INFO, LINK" />
      </label>

      <label>
        Match mode
        <select value={matchMode} onChange={(e) => setMatchMode(e.target.value)}>
          <option value="WHOLE_WORD">Whole word</option>
          <option value="PARTIAL">Partial</option>
          <option value="EXACT">Exact</option>
        </select>
      </label>

      <label>
        DM message
        <textarea value={dmMessage} onChange={(e) => setDmMessage(e.target.value)} rows={3} required />
      </label>

      <label>
        Destination link (optional)
        <input type="url" value={destinationUrl} onChange={(e) => setDestinationUrl(e.target.value)} placeholder="https://example.com/product" />
      </label>

      <Toggle id="public-reply-toggle" checked={publicReplyEnabled} onChange={setPublicReplyEnabled} label="Also post a public reply" />
      {publicReplyEnabled ? (
        <label>
          Public reply message
          <input type="text" value={publicReplyMessage} onChange={(e) => setPublicReplyMessage(e.target.value)} />
        </label>
      ) : null}

      <Toggle
        id="enabled-toggle"
        checked={enabled}
        onChange={setEnabled}
        label="Enabled (only enabled + published campaigns sync to OpenReply)"
      />

      <button type="submit" disabled={pending} aria-busy={pending}>
        {pending ? (
          <>
            <Spinner size={13} /> Saving…
          </>
        ) : (
          "Save campaign"
        )}
      </button>
      {error ? <div className="error-box">{error}</div> : null}
    </form>
  );
}
