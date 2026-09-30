import { NextRequest, NextResponse } from "next/server";
import { getCampaign, upsertCampaign, getPost } from "@jqp/publisher";
import { enqueueSyncCampaign } from "@jqp/queue";
import { apiError } from "../../_lib/api-error";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const campaign = await getCampaign(id);
    if (!campaign) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
    return NextResponse.json({ success: true, data: campaign });
  } catch (err) {
    return apiError("campaign_fetch_failed", err, { status: 503, publicMessage: "Database unavailable.", fields: { campaignId: id } });
  }
}

interface PatchBody {
  triggerKeywords?: string;
  matchMode?: "WHOLE_WORD" | "PARTIAL" | "EXACT";
  dmMessage?: string;
  destinationUrl?: string;
  publicReplyEnabled?: boolean;
  publicReplyMessage?: string;
  enabled?: boolean;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const existing = await getCampaign(id);
    if (!existing) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });

    const body = (await request.json().catch(() => null)) as PatchBody | null;
    if (!body) return NextResponse.json({ success: false, error: "Invalid body" }, { status: 400 });

    // A blank dmMessage would sync to OpenReply as an empty private reply —
    // reject it explicitly rather than letting `??` silently accept "" as a
    // real value (`??` only falls back on null/undefined, not on "").
    if (body.dmMessage !== undefined && body.dmMessage.trim().length === 0) {
      return NextResponse.json({ success: false, error: "dmMessage cannot be empty" }, { status: 400 });
    }

    const keywords = body.triggerKeywords !== undefined ? body.triggerKeywords.split(",").map((k) => k.trim()).filter(Boolean) : existing.trigger_keywords;

    const updated = await upsertCampaign({
      postId: existing.post_id,
      triggerKeywords: keywords,
      matchMode: body.matchMode ?? existing.match_mode,
      dmMessage: body.dmMessage ?? existing.dm_message,
      destinationUrl: body.destinationUrl ?? existing.destination_url,
      publicReplyEnabled: body.publicReplyEnabled ?? existing.public_reply_enabled,
      publicReplyMessage: body.publicReplyMessage ?? existing.public_reply_message,
      // Not editable through PATCH, so carry them over. Omitting them made
      // upsertCampaign reset the two-step DM flow to off on every PATCH.
      openingDmEnabled: existing.opening_dm_enabled,
      openingDmMessage: existing.opening_dm_message,
      openingDmButtonLabel: existing.opening_dm_button_label,
      enabled: body.enabled ?? existing.enabled
    });

    // If this update just enabled the campaign (or edited an already-enabled
    // one) and the post is already published, (re)sync it into OpenReply now
    // rather than waiting for the next publish event (there won't be one).
    if (updated.enabled) {
      const post = await getPost(updated.post_id);
      if (post?.status === "PUBLISHED") {
        await enqueueSyncCampaign({ campaignId: updated.id });
      }
    }

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    return apiError("campaign_update_failed", err, { publicMessage: "Could not update that campaign." });
  }
}
