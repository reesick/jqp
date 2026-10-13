import { NextRequest, NextResponse } from "next/server";
import { dmTextWithLink, normalizeMessageText, normalizeOptionalMessage } from "@jqp/publisher";

export const dynamic = "force-dynamic";

interface PreviewBody {
  openingDmEnabled?: boolean;
  openingDmMessage?: string;
  openingDmButtonLabel?: string;
  dmMessage?: string;
  destinationUrl?: string;
  publicReplyEnabled?: boolean;
  publicReplyMessage?: string;
}

const OPENING_MAX = 640;
const BUTTON_MAX = 20;
const DM_MAX = 1000;

/**
 * What a commenter will actually receive, after the same cleaning every campaign write applies. Read-only: nothing is
 * saved or sent. The form shows this next to its inputs so the copy can be checked before it is saved.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as PreviewBody | null;
  if (!body) return NextResponse.json({ success: false, error: "Invalid body" }, { status: 400 });

  try {
    const warnings: string[] = [];
    const opening = body.openingDmEnabled ? normalizeOptionalMessage(body.openingDmMessage) : null;
    const button = body.openingDmEnabled ? normalizeOptionalMessage(body.openingDmButtonLabel, { singleLine: true }) : null;
    const dm = dmTextWithLink(normalizeMessageText(body.dmMessage ?? ""), body.destinationUrl);
    const publicReply = body.publicReplyEnabled ? normalizeOptionalMessage(body.publicReplyMessage) : null;

    if (body.openingDmEnabled) {
      if (!opening) warnings.push("The opening DM is empty, so this campaign would send the link DM directly.");
      else if (!/(automat|bot|assistant)/i.test(opening)) warnings.push("The opening DM does not say it is automated. Meta expects automated messages to say so.");
      if (opening && opening.length > OPENING_MAX) warnings.push(`The opening DM is ${opening.length} characters; ${OPENING_MAX} is the limit, the rest is cut off.`);
      if (!button) warnings.push("The button needs a label, or the two-step flow is skipped.");
      if (button && button.length > BUTTON_MAX) warnings.push(`The button label is ${button.length} characters; ${BUTTON_MAX} is the limit, the rest is cut off.`);
    } else if (dm && !/(automat|bot|assistant)/i.test(dm)) {
      warnings.push("This DM does not say it is automated. Meta expects automated messages to say so; the two-step opening DM is the easiest place for it.");
    }
    if (!dm.trim()) warnings.push("The link DM is empty.");
    if (dm.length > DM_MAX) warnings.push(`The link DM is ${dm.length} characters; ${DM_MAX} is the limit, the rest is cut off.`);
    if (body.destinationUrl?.trim() && !normalizeMessageText(body.dmMessage ?? "").includes(body.destinationUrl.trim())) {
      warnings.push("The destination link is added to the end of the DM automatically.");
    }
    if (!body.destinationUrl?.trim() && !/https?:\/\//i.test(dm)) warnings.push("There is no link anywhere in this DM.");

    return NextResponse.json({ success: true, data: { opening, button, dm, publicReply, warnings } });
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : "Could not build the preview." }, { status: 400 });
  }
}
