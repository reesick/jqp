"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PostRow } from "@jqp/core";
import { Toggle } from "./toggle";
import { Spinner } from "./spinner";
import { useToast } from "./toast";

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
    opening_dm_enabled: boolean;
    opening_dm_message: string | null;
    opening_dm_button_label: string | null;
    enabled: boolean;
  };
}

// Meta's hard caps for a button-template message. OpenReply's client truncates
// to exactly these at send time (text.slice(0, 640), title.slice(0, 20)), so
// anything longer is silently cut mid-word — enforce them at the input instead.
const OPENING_DM_MAX = 640;
const BUTTON_LABEL_MAX = 20;

const DEFAULT_OPENING_DM =
  "Hey {username}, this is an automated reply. Tap below and I'll send your link.";

// Meta requires automated chat experiences to disclose they're automated at the
// start of a conversation. The opening DM is that start, so this warns (never
// blocks — the operator owns their own copy) when no disclosure phrase is present.
const DISCLOSURE_HINTS = ["automated", "auto-reply", "auto reply", "bot", "automation"];
function looksUndisclosed(message: string): boolean {
  const lower = message.toLowerCase();
  return message.trim().length > 0 && !DISCLOSURE_HINTS.some((hint) => lower.includes(hint));
}

export function CampaignForm({ posts, defaultPostId, existing }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [postId, setPostId] = useState(existing?.post_id ?? defaultPostId ?? posts[0]?.id ?? "");
  const [keywords, setKeywords] = useState(existing?.trigger_keywords.join(", ") ?? "");
  const [matchMode, setMatchMode] = useState(existing?.match_mode ?? "WHOLE_WORD");
  const [dmMessage, setDmMessage] = useState(existing?.dm_message ?? "");
  const [destinationUrl, setDestinationUrl] = useState(existing?.destination_url ?? "");
  const [publicReplyEnabled, setPublicReplyEnabled] = useState(existing?.public_reply_enabled ?? false);
  const [publicReplyMessage, setPublicReplyMessage] = useState(existing?.public_reply_message ?? "");
  const [openingDmEnabled, setOpeningDmEnabled] = useState(existing?.opening_dm_enabled ?? false);
  const [openingDmMessage, setOpeningDmMessage] = useState(existing?.opening_dm_message ?? DEFAULT_OPENING_DM);
  const [openingDmButtonLabel, setOpeningDmButtonLabel] = useState(existing?.opening_dm_button_label ?? "Send the link");
  const [enabled, setEnabled] = useState(existing?.enabled ?? false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await save();
  }

  async function save() {
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
          openingDmEnabled,
          openingDmMessage,
          openingDmButtonLabel,
          enabled
        })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        setError(json.error ?? `Request failed (${res.status})`);
        toast("Couldn't save campaign", { kind: "error", action: { label: "Retry", onClick: () => void save() } });
        return;
      }
      toast(existing ? "Campaign updated" : "Campaign saved");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      toast("Couldn't save campaign", { kind: "error", action: { label: "Retry", onClick: () => void save() } });
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

      <Toggle
        id="opening-dm-toggle"
        checked={openingDmEnabled}
        onChange={setOpeningDmEnabled}
        label="Send an opening DM with a button first"
      />
      {openingDmEnabled ? (
        <>
          <p className="muted u-text-sm">
            They get this message with a tappable button. The DM below, the one with your link, is only sent
            after they tap it.
          </p>
          <label>
            Opening DM message
            <span className="hint">
              {"{username}"} inserts their name. {openingDmMessage.length}/{OPENING_DM_MAX}
            </span>
            <textarea
              value={openingDmMessage}
              onChange={(e) => setOpeningDmMessage(e.target.value)}
              maxLength={OPENING_DM_MAX}
              rows={3}
              required
            />
          </label>
          {looksUndisclosed(openingDmMessage) ? (
            <p className="muted u-text-sm">
              Heads up: Meta requires automated chat experiences to say they&rsquo;re automated at the start of a
              conversation. Consider mentioning it here.
            </p>
          ) : null}
          <label>
            Button label
            <span className="hint">
              {openingDmButtonLabel.length}/{BUTTON_LABEL_MAX}. Instagram cuts anything longer.
            </span>
            <input
              type="text"
              value={openingDmButtonLabel}
              onChange={(e) => setOpeningDmButtonLabel(e.target.value)}
              maxLength={BUTTON_LABEL_MAX}
              placeholder="Send the link"
              required
            />
          </label>
        </>
      ) : null}

      <label>
        {openingDmEnabled ? "DM message (sent after they tap)" : "DM message"}
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
      {error ? (
        <div className="error-box" role="alert">
          Couldn&rsquo;t save this campaign: {error}
        </div>
      ) : null}
    </form>
  );
}
