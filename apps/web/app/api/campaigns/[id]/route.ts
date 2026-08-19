import { NextRequest, NextResponse } from "next/server";
import { getCampaign, upsertCampaign, getPost } from "@jqp/publisher";
import { enqueueSyncCampaign } from "@jqp/queue";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const campaign = await getCampaign(id);
    if (!campaign) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
    return NextResponse.json({ success: true, data: campaign });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: `Database unavailable: ${message}` }, { status: 503 });
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
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
