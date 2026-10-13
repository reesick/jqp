import { getDb, type CampaignRow, type PostRow } from "@jqp/core";
import { dmTextWithLink, normalizeMessageText } from "./message-text.js";
import { getCampaignByPostId, getPost, listCampaigns, listIgAccounts, listPostMedia, resolveIgUserIdForPost } from "./repository.js";
import { getSystemSnapshot } from "./system.js";

/**
 * A go / no-go review of one post and its campaign, built from what is actually saved and what is actually running.
 * It changes nothing. The same function is meant to be the gate for any future automatic launch: automation may only
 * proceed when `verdict` is "ready" (or "warnings" if a person has accepted them) and never when it is "blocked".
 */

export type LaunchLevel = "ok" | "warn" | "block" | "manual";

export interface LaunchCheck {
  key: string;
  group: "Post" | "Campaign" | "Account and systems" | "Check by hand";
  level: LaunchLevel;
  label: string;
  detail: string;
}

export interface LaunchInput {
  post: Pick<PostRow, "status" | "caption">;
  mediaCount: number;
  campaign: CampaignRow | null;
  /** null when no Instagram account is connected for this post. */
  account: { username: string | null; daysLeft: number | null } | null;
  /** null when OpenReply could not be read. */
  openReply: { registered: boolean; webhookSubscribed: boolean } | null;
  system: { workerUp: boolean; queueBacklog: number; hourlySent: number; hourlyLimit: number };
  otherEnabledCampaigns: number;
}

export interface LaunchReview {
  checks: LaunchCheck[];
  verdict: "ready" | "warnings" | "blocked";
  counts: { block: number; warn: number; ok: number; manual: number };
}

const AUTOMATED = /(automat|bot\b|assistant)/i;
const LONG_DASH = /[—–]/;
const EMOJI = /\p{Extended_Pictographic}/u;
const URL_IN_TEXT = /https?:\/\/\S+/i;

export function evaluateLaunchReview(input: LaunchInput): LaunchReview {
  const checks: LaunchCheck[] = [];
  const add = (key: string, group: LaunchCheck["group"], level: LaunchLevel, label: string, detail: string) => checks.push({ key, group, level, label, detail });

  // ---- Post
  const caption = input.post.caption ?? "";
  const chars = [...caption].length;
  const hashtags = (caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  if (input.post.status === "PUBLISHED") add("post-status", "Post", "warn", "Post is already live", "It was published already. Changing the campaign now affects a live post.");
  else if (input.post.status === "FAILED" || input.post.status === "VALIDATION_FAILED") add("post-status", "Post", "block", "Post failed earlier", "Fix the reason shown on the post page, then retry.");
  else add("post-status", "Post", "ok", "Post is ready to publish", `Status ${input.post.status}.`);

  if (input.mediaCount < 2 || input.mediaCount > 10) add("slides", "Post", "block", "Slide count", `${input.mediaCount} images. A carousel needs 2 to 10.`);
  else add("slides", "Post", "ok", "Slide count", `${input.mediaCount} images.`);

  if (!caption.trim()) add("caption", "Post", "warn", "Caption", "There is no caption.");
  else if (chars > 2200) add("caption", "Post", "block", "Caption length", `${chars} characters. Instagram allows 2,200.`);
  else add("caption", "Post", "ok", "Caption length", `${chars} of 2,200 characters.`);
  if (hashtags > 30) add("hashtags", "Post", "block", "Hashtags", `${hashtags} hashtags. Instagram allows 30.`);
  if (LONG_DASH.test(caption)) add("caption-dash", "Post", "warn", "Caption style", "The caption has a long dash, which reads as AI-written. Replace it with a comma or full stop.");

  // ---- Campaign
  const c = input.campaign;
  if (!c) {
    add("campaign", "Campaign", "warn", "No campaign yet", "Comments on this post will not get DMs until you create and enable one.");
  } else {
    const link = dmTextWithLink(normalizeMessageText(c.dm_message ?? ""), c.destination_url);
    const opening = c.opening_dm_enabled ? normalizeMessageText(c.opening_dm_message ?? "") : "";
    const button = c.opening_dm_enabled ? normalizeMessageText(c.opening_dm_button_label ?? "", { singleLine: true }) : "";

    if (c.trigger_keywords.length === 0) add("keywords", "Campaign", "block", "Trigger keywords", "No keyword is set, so every comment, including emoji and spam, would get a DM.");
    else add("keywords", "Campaign", "ok", "Trigger keywords", c.trigger_keywords.join(", "));
    if (c.match_mode === "PARTIAL") add("match", "Campaign", "warn", "Match mode", "Partial matching also fires inside longer words. Whole word is safer.");

    if (!link.trim()) add("dm", "Campaign", "block", "Link DM", "The DM that carries your link is empty.");
    else if (link.length > 1000) add("dm", "Campaign", "block", "Link DM length", `${link.length} characters. Instagram allows 1,000.`);
    else add("dm", "Campaign", "ok", "Link DM", `${link.length} characters.`);
    if (link.trim() && !URL_IN_TEXT.test(link)) add("link", "Campaign", "block", "Link", "There is no link in the DM or in the destination link field.");
    else if (c.destination_url && !/^https:\/\//i.test(c.destination_url.trim())) add("link-https", "Campaign", "warn", "Link security", "The destination link is not https.");

    if (c.opening_dm_enabled) {
      if (!opening || !button) add("opening", "Campaign", "block", "Opening DM", "The opening message or the button label is empty, so the two-step flow would not run.");
      else {
        if (opening.length > 640) add("opening-len", "Campaign", "block", "Opening DM length", `${opening.length} characters. The limit is 640.`);
        if (button.length > 20) add("button-len", "Campaign", "block", "Button label length", `${button.length} characters. The limit is 20.`);
        if (!AUTOMATED.test(opening)) add("disclosure", "Campaign", "block", "Says it is automated", "The opening DM does not say it is automated. Meta expects automated messages to disclose that.");
        else add("disclosure", "Campaign", "ok", "Says it is automated", "The opening DM discloses it.");
      }
    } else if (!AUTOMATED.test(link)) {
      add("disclosure", "Campaign", "warn", "Says it is automated", "This single DM does not say it is automated. The two-step opening DM is the easiest place for that line.");
    }
    if (LONG_DASH.test(link) || LONG_DASH.test(opening) || EMOJI.test(link) || EMOJI.test(opening)) {
      add("copy-style", "Campaign", "warn", "Copy style", "The DM copy has a long dash or an emoji. Remove them to keep it sounding human.");
    }

    if (c.public_reply_enabled) {
      if (!c.public_reply_message?.trim()) add("public-reply", "Campaign", "block", "Public reply", "Public reply is on but its text is empty.");
      else add("public-reply", "Campaign", "warn", "Public reply", "One identical reply under many comments looks repetitive to Meta's spam systems. Keep public replies off until there are several variants.");
    } else {
      add("public-reply", "Campaign", "ok", "Public reply", "Off, which is the safe default.");
    }

    add("enabled", "Campaign", "ok", "Campaign switch", c.enabled ? "Enabled: it will start answering comments once the post is live." : "Saved but off. It only answers comments after you switch it on.");
  }

  // ---- Account and systems
  if (!input.account) add("account", "Account and systems", "block", "Instagram account", "No connected account for this post.");
  else if (input.account.daysLeft !== null && input.account.daysLeft < 0) add("account", "Account and systems", "block", "Instagram token", `@${input.account.username ?? "account"} token expired. Reconnect it.`);
  else if (input.account.daysLeft !== null && input.account.daysLeft < 14) add("account", "Account and systems", "warn", "Instagram token", `@${input.account.username ?? "account"} token expires in ${input.account.daysLeft} days.`);
  else add("account", "Account and systems", "ok", "Instagram account", `@${input.account.username ?? "account"}${input.account.daysLeft !== null ? `, token valid ${input.account.daysLeft} more days` : ""}.`);

  if (!input.openReply) add("openreply", "Account and systems", "warn", "DM engine", "Could not read OpenReply, so account registration is unverified.");
  else if (!input.openReply.registered) add("openreply", "Account and systems", "block", "DM engine account", "This account is not registered in OpenReply, so no campaign can sync.");
  else if (!input.openReply.webhookSubscribed) add("openreply", "Account and systems", "warn", "Webhook subscription", "OpenReply says this account is not subscribed to comment webhooks.");
  else add("openreply", "Account and systems", "ok", "DM engine account", "Registered and subscribed to webhooks.");

  add("worker", "Account and systems", input.system.workerUp ? "ok" : "warn", "DM worker", input.system.workerUp ? "Running." : "Not running. Posting works, but no DMs go out until you start the worker.");
  add("queue", "Account and systems", input.system.queueBacklog > 0 ? "warn" : "ok", "DM queue", input.system.queueBacklog > 0 ? `${input.system.queueBacklog} jobs are waiting. Review them before starting the worker, or old comments get DMs in a burst.` : "Empty.");
  const used = input.system.hourlyLimit > 0 ? input.system.hourlySent / input.system.hourlyLimit : 0;
  add("rate", "Account and systems", used >= 0.7 ? "warn" : "ok", "Hourly send limit", `${input.system.hourlySent} of ${input.system.hourlyLimit} used this hour.`);
  if (input.otherEnabledCampaigns > 0) add("others", "Account and systems", "warn", "Other campaigns are on", `${input.otherEnabledCampaigns} other campaign(s) are still enabled. Switch off any old ones you do not want answering.`);

  // ---- Things only a person can confirm in Meta's console. Never reported as passing.
  add("meta-live", "Check by hand", "manual", "Meta app is Live", "In the Meta app's top bar. Development mode delivers no real webhooks.");
  add("meta-fields", "Check by hand", "manual", "Webhook fields in Meta", "comments and messages subscribed; messaging_seen left off.");
  add("meta-stranger", "Check by hand", "manual", "Test with a stranger", "Comment the keyword from an account with no role on your app. Meta's docs say comment webhooks need Advanced Access; whether Live mode alone is enough is unverified.");

  const counts = { block: 0, warn: 0, ok: 0, manual: 0 };
  for (const k of checks) counts[k.level] += 1;
  const verdict: LaunchReview["verdict"] = counts.block > 0 ? "blocked" : counts.warn > 0 ? "warnings" : "ready";
  return { checks, verdict, counts };
}

/** Gathers the real state for one post and evaluates it. Reads only. */
export async function getLaunchReview(postId: string): Promise<{ post: PostRow; campaign: CampaignRow | null; mediaCount: number; review: LaunchReview } | null> {
  const post = await getPost(postId);
  if (!post) return null;
  const [media, campaign, accounts, snapshot, allCampaigns] = await Promise.all([listPostMedia(postId), getCampaignByPostId(postId), listIgAccounts(), getSystemSnapshot(), listCampaigns()]);

  let igUserId: string | null = null;
  try {
    igUserId = await resolveIgUserIdForPost(post);
  } catch {
    igUserId = null;
  }
  const acct = igUserId ? accounts.find((a) => a.ig_user_id === igUserId) : undefined;
  const daysLeft = acct?.token_expires_at ? Math.floor((new Date(acct.token_expires_at).getTime() - Date.now()) / 86_400_000) : null;

  let openReply: LaunchInput["openReply"] = null;
  if (igUserId) {
    try {
      const sql = getDb();
      const rows = await sql<{ webhookSubscribed: boolean }[]>`select "webhookSubscribed" from "InstagramAccount" where "instagramId" = ${igUserId}`;
      openReply = { registered: rows.length > 0, webhookSubscribed: rows[0]?.webhookSubscribed ?? false };
    } catch {
      openReply = null;
    }
  }

  const worker = snapshot.services.find((s) => s.key === "dm-worker");
  const queue = snapshot.queue;
  const review = evaluateLaunchReview({
    post,
    mediaCount: media.length,
    campaign,
    account: igUserId && acct ? { username: acct.username, daysLeft } : igUserId ? { username: null, daysLeft: null } : null,
    openReply,
    system: {
      workerUp: worker?.state === "ok",
      queueBacklog: (queue?.waiting ?? 0) + (queue?.delayed ?? 0),
      hourlySent: snapshot.dm.lastHourSent,
      hourlyLimit: snapshot.dm.hourlyLimit
    },
    otherEnabledCampaigns: allCampaigns.filter((x) => x.enabled && x.post_id !== postId).length
  });
  return { post, campaign, mediaCount: media.length, review };
}
