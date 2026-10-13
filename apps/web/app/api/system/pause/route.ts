import { NextRequest, NextResponse } from "next/server";
import { listCampaigns, upsertCampaign } from "@jqp/publisher";
import { apiError } from "../../_lib/api-error";

export const dynamic = "force-dynamic";

/**
 * Emergency stop: switches every enabled campaign off through the normal off path, which deactivates the OpenReply
 * automation first and only then saves enabled=false. Nothing is deleted. Turning a campaign back on is a deliberate
 * per-campaign action. Requires { confirm: true } so a stray request cannot trigger it.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { confirm?: boolean } | null;
  if (body?.confirm !== true) return NextResponse.json({ success: false, error: "Send { confirm: true } to pause all campaigns." }, { status: 400 });

  try {
    const enabled = (await listCampaigns()).filter((c) => c.enabled);
    const failed: string[] = [];
    let paused = 0;
    for (const c of enabled) {
      try {
        await upsertCampaign({
          postId: c.post_id,
          triggerKeywords: c.trigger_keywords,
          matchMode: c.match_mode,
          dmMessage: c.dm_message,
          destinationUrl: c.destination_url,
          publicReplyEnabled: c.public_reply_enabled,
          publicReplyMessage: c.public_reply_message,
          openingDmEnabled: c.opening_dm_enabled,
          openingDmMessage: c.opening_dm_message,
          openingDmButtonLabel: c.opening_dm_button_label,
          enabled: false
        });
        paused += 1;
      } catch {
        failed.push(c.id);
      }
    }
    if (failed.length > 0) {
      return NextResponse.json({ success: false, error: `Paused ${paused} but ${failed.length} could not be switched off. Press the button again.`, data: { paused, failed } }, { status: 500 });
    }
    return NextResponse.json({ success: true, data: { paused } });
  } catch (err) {
    return apiError("pause_all_failed", err, { publicMessage: "Could not pause the campaigns. Try again." });
  }
}
