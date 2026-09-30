"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { CampaignRow } from "@jqp/core";
import { useToast } from "./toast";

/**
 * Optimistic enable/disable switch for one campaign row.
 *
 * Uses the same upsert endpoint as the form (POST /api/campaigns) and resends
 * every field of the row: PATCH /api/campaigns/[id] does not carry the
 * opening-DM fields, so using it here would silently switch that feature off.
 */
export function CampaignToggle({ campaign }: { campaign: CampaignRow }) {
  const router = useRouter();
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(campaign.enabled);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  // Follow server truth after a refresh (e.g. the form edited this campaign).
  useEffect(() => {
    if (!inFlight.current) setEnabled(campaign.enabled);
  }, [campaign.enabled]);

  async function apply(next: boolean) {
    if (inFlight.current) return;
    inFlight.current = true;
    const previous = enabled;
    setEnabled(next); // optimistic
    setPending(true);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          postId: campaign.post_id,
          triggerKeywords: campaign.trigger_keywords.join(", "),
          matchMode: campaign.match_mode,
          dmMessage: campaign.dm_message,
          destinationUrl: campaign.destination_url ?? "",
          publicReplyEnabled: campaign.public_reply_enabled,
          publicReplyMessage: campaign.public_reply_message ?? "",
          openingDmEnabled: campaign.opening_dm_enabled,
          openingDmMessage: campaign.opening_dm_message ?? "",
          openingDmButtonLabel: campaign.opening_dm_button_label ?? "",
          enabled: next
        })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error ?? `Request failed (${res.status})`);
      toast(next ? "Campaign enabled" : "Campaign paused");
      router.refresh();
    } catch {
      setEnabled(previous); // roll back
      toast(next ? "Couldn't enable campaign" : "Couldn't pause campaign", {
        kind: "error",
        action: { label: "Retry", onClick: () => void apply(next) }
      });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`${enabled ? "Pause" : "Enable"} campaign ${campaign.trigger_keywords.join(", ") || "(any word)"}`}
      aria-busy={pending}
      className={`toggle${enabled ? " on" : ""}`}
      onClick={() => void apply(!enabled)}
    >
      <span className="toggle-thumb" />
    </button>
  );
}
