import { NextRequest, NextResponse } from "next/server";
import { listCampaigns, upsertCampaign, getPost } from "@jqp/publisher";
import { enqueueSyncCampaign } from "@jqp/queue";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const campaigns = await listCampaigns();
    return NextResponse.json({ success: true, data: campaigns });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: `Database unavailable: ${message}` }, { status: 503 });
  }
}

interface UpsertBody {
  postId: string;
  triggerKeywords: string; // comma-separated from the form
  matchMode: "WHOLE_WORD" | "PARTIAL" | "EXACT";
  dmMessage: string;
  destinationUrl?: string;
  publicReplyEnabled?: boolean;
  publicReplyMessage?: string;
  openingDmEnabled?: boolean;
  openingDmMessage?: string;
  openingDmButtonLabel?: string;
  enabled?: boolean;
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as UpsertBody | null;
  if (!body?.postId || !body.dmMessage) {
    return NextResponse.json({ success: false, error: "postId and dmMessage are required" }, { status: 400 });
  }

  try {
    const post = await getPost(body.postId);
    if (!post) return NextResponse.json({ success: false, error: "Post not found" }, { status: 404 });

    const keywords = body.triggerKeywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    // The two-step flow needs both the message and the button label; enabling it
    // with either missing would silently fall back to a one-shot DM at send time,
    // which is confusing to debug from the dashboard. Reject it here instead.
    if (body.openingDmEnabled && (!body.openingDmMessage?.trim() || !body.openingDmButtonLabel?.trim())) {
      return NextResponse.json(
        { success: false, error: "An opening DM needs both a message and a button label." },
        { status: 400 }
      );
    }

    const campaign = await upsertCampaign({
      postId: body.postId,
      triggerKeywords: keywords,
      matchMode: body.matchMode ?? "WHOLE_WORD",
      dmMessage: body.dmMessage,
      destinationUrl: body.destinationUrl || null,
      publicReplyEnabled: Boolean(body.publicReplyEnabled),
      publicReplyMessage: body.publicReplyMessage || null,
      openingDmEnabled: Boolean(body.openingDmEnabled),
      openingDmMessage: body.openingDmMessage || null,
      openingDmButtonLabel: body.openingDmButtonLabel || null,
      enabled: Boolean(body.enabled)
    });

    // Same rule as the PATCH route: a newly-created campaign that's already
    // enabled, for a post that's already PUBLISHED, needs its sync kicked
    // off now — the pipeline's own auto-sync (packages/publisher/src/pipeline.ts)
    // only fires at the moment PUBLISHING completes, which already happened
    // for this post before the campaign existed.
    if (campaign.enabled && post.status === "PUBLISHED") {
      await enqueueSyncCampaign({ campaignId: campaign.id });
    }

    return NextResponse.json({ success: true, data: campaign }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
