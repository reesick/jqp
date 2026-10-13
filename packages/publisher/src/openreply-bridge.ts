import { randomUUID } from "node:crypto";
import { getDb, rootLogger, NonRetryableError, RetryableError, type MatchMode } from "@jqp/core";
import { deactivateOpenReplyAutomation, getCampaign, getPost, resolveIgUserIdForPost, updateCampaignSync } from "./repository.js";

/**
 * Writes directly into OpenReply's own `"Automation"` and
 * `"InstagramAccount"` tables (vendor/openreply) rather than calling
 * their /api/automations HTTP endpoint, because that endpoint requires
 * an authenticated NextAuth dashboard session and has no
 * service-to-service auth path. This still uses OpenReply's exact
 * schema/columns/semantics — verified against their real migration
 * history in vendor/openreply/prisma/migrations, not guessed — so
 * their worker, webhook handler, and dashboard all see a completely
 * ordinary campaign row, indistinguishable from one a human created
 * by hand in their UI.
 *
 * Lives in the SAME `public` Postgres schema as our own tables, not an
 * isolated one — an isolated-schema approach was tried first and
 * reverted, because Prisma's query engine hardcodes `public.` on every
 * generated query unless the schema is declared inside
 * vendor/openreply/prisma/schema.prisma itself (Prisma's multiSchema
 * feature), which would mean editing vendored code. Verified zero
 * table-name collisions instead: our tables are all snake_case
 * (posts, campaigns, ig_accounts, ...), OpenReply's are all PascalCase
 * model names (User, Automation, InstagramAccount, ...) — see
 * scripts/sync-openreply-env.ts for the full explanation.
 *
 * If OpenReply's schema changes in a future pull of that repo, this
 * file is the one place that needs updating (plan section 38's whole
 * argument for keeping this as a thin bridge rather than a deep
 * integration).
 */

interface OpenReplyAccount {
  id: string;
  workspaceId: string;
}

async function resolveOpenReplyAccount(igUserId: string): Promise<OpenReplyAccount> {
  const sql = getDb();
  const rows = await sql<{ id: string; workspaceId: string }[]>`
    select "id", "workspaceId" from "InstagramAccount" where "instagramId" = ${igUserId}
  `;
  const account = rows[0];
  if (!account) {
    throw new NonRetryableError(
      `No OpenReply InstagramAccount found for Instagram account ${igUserId}. Connect this account in OpenReply's dashboard (Settings -> Connect Instagram) before campaigns can sync.`,
      "OPENREPLY_ACCOUNT_NOT_CONNECTED",
      { igUserId }
    );
  }
  return account;
}

function toWholeWordMatch(matchMode: MatchMode): boolean {
  // OpenReply only supports whole-word vs. partial matching, not our EXACT mode.
  // EXACT maps to wholeWordMatch=true as the closer of the two available options —
  // documented limitation, not a bug: verify this is still acceptable if match_mode
  // usage expands beyond WHOLE_WORD/PARTIAL in practice.
  return matchMode !== "PARTIAL";
}

/**
 * Pushes one of our staged campaigns into OpenReply as an Automation.
 * Guards (plan section 35): does nothing — not an error, just a no-op —
 * unless the post is PUBLISHED with a real instagram_media_id AND the
 * campaign is enabled. Idempotent: re-running after a previous
 * success UPDATEs the existing Automation row (tracked via
 * campaigns.openreply_automation_id) instead of creating a duplicate.
 */
export async function syncCampaignToOpenReply(campaignId: string): Promise<void> {
  const log = rootLogger.child({ campaignId });
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new NonRetryableError(`syncCampaignToOpenReply: no campaign found for id ${campaignId}`, "CAMPAIGN_NOT_FOUND");

  // Off means off: if an automation already exists for this campaign, make sure it is inactive.
  // Normally upsertCampaign did this already; this covers a sync job queued before the switch-off
  // and any edit made straight in the database.
  if (!campaign.enabled && campaign.openreply_automation_id) {
    await deactivateOpenReplyAutomation(campaign.openreply_automation_id);
    await updateCampaignSync(campaignId, { syncStatus: "DM_SYNCED", syncError: null });
    log.info("automation_deactivated", { automationId: campaign.openreply_automation_id });
    return;
  }

  const post = await getPost(campaign.post_id);
  if (!post) throw new NonRetryableError(`syncCampaignToOpenReply: no post found for campaign ${campaignId}`, "POST_NOT_FOUND");

  if (post.status !== "PUBLISHED" || !post.instagram_media_id) {
    log.info("sync_skipped_post_not_published_yet", { postStatus: post.status });
    return;
  }
  if (!campaign.enabled) {
    log.info("sync_skipped_campaign_not_enabled");
    return;
  }

  await updateCampaignSync(campaignId, { syncStatus: "DM_SYNCING" });

  try {
    const igUserId = await resolveIgUserIdForPost(post);
    const account = await resolveOpenReplyAccount(igUserId);
    const sql = getDb();
    const now = new Date();

    const publicReplyMessages = campaign.public_reply_message ? [campaign.public_reply_message] : [];
    const wholeWordMatch = toWholeWordMatch(campaign.match_mode);
    // OpenReply's own /api/automations validation requires matchAnyWord ||
    // keywords.length >= 1 — a campaign with neither matches nothing and
    // silently never fires. We bypass their API (and its validation) by
    // writing SQL directly, so we have to enforce the same rule ourselves:
    // empty keywords here means "match any word", not "match nothing".
    const matchAnyWord = campaign.trigger_keywords.length === 0;

    // Two-step reveal. OpenReply's dm-worker (processComment, `useOpeningDm`)
    // engages the button flow only when all three of these are truthy, so an
    // enabled campaign missing either text field must fall back to the plain
    // one-shot DM rather than half-engage. Meta's own caps are applied here
    // rather than trusted from the form: their client truncates button text at
    // 640 and the title at 20, silently, so anything longer would be cut
    // mid-word at send time with no record of it.
    const openingDmReady = Boolean(campaign.opening_dm_enabled && campaign.opening_dm_message && campaign.opening_dm_button_label);
    const openingDmEnabled = openingDmReady;
    const openingDmMessage = openingDmReady ? campaign.opening_dm_message!.slice(0, 640) : null;
    const openingDmButtonLabel = openingDmReady ? campaign.opening_dm_button_label!.slice(0, 20) : null;
    if (campaign.opening_dm_enabled && !openingDmReady) {
      log.warn("opening_dm_incomplete_falling_back_to_single_dm", {
        hasMessage: Boolean(campaign.opening_dm_message),
        hasButtonLabel: Boolean(campaign.opening_dm_button_label)
      });
    }

    if (campaign.openreply_automation_id) {
      await sql`
        update "Automation" set
          "postId" = ${post.instagram_media_id},
          "keywords" = ${campaign.trigger_keywords},
          "matchAnyWord" = ${matchAnyWord},
          "wholeWordMatch" = ${wholeWordMatch},
          "dmMessage" = ${campaign.dm_message},
          "publicReplyEnabled" = ${campaign.public_reply_enabled},
          "publicReplyMessage" = ${campaign.public_reply_message ?? null},
          "publicReplyMessages" = ${publicReplyMessages},
          "openingDmEnabled" = ${openingDmEnabled},
          "openingDmMessage" = ${openingDmMessage},
          "openingDmButtonLabel" = ${openingDmButtonLabel},
          "isActive" = ${campaign.enabled},
          "updatedAt" = ${now}
        where "id" = ${campaign.openreply_automation_id}
      `;
      log.info("automation_updated", { automationId: campaign.openreply_automation_id });
      await updateCampaignSync(campaignId, {
        syncStatus: "DM_SYNCED",
        syncError: null,
        instagramMediaId: post.instagram_media_id,
        openreplyAutomationId: campaign.openreply_automation_id
      });
      return;
    }

    const automationId = randomUUID();
    await sql`
      insert into "Automation" (
        "id", "workspaceId", "instagramAccountId", "name", "postId",
        "keywords", "matchAnyWord", "matchAnyPost", "pendingNextReel", "wholeWordMatch",
        "dmMessage", "dmTriggerEnabled", "publicReplyEnabled", "publicReplyMessage", "publicReplyMessages",
        "openingDmEnabled", "openingDmMessage", "openingDmButtonLabel",
        "isActive", "createdAt", "updatedAt"
      ) values (
        ${automationId}, ${account.workspaceId}, ${account.id}, ${`jqp: ${post.campaign_id}`}, ${post.instagram_media_id},
        ${campaign.trigger_keywords}, ${matchAnyWord}, false, false, ${wholeWordMatch},
        ${campaign.dm_message}, false, ${campaign.public_reply_enabled}, ${campaign.public_reply_message ?? null}, ${publicReplyMessages},
        ${openingDmEnabled}, ${openingDmMessage}, ${openingDmButtonLabel},
        ${campaign.enabled}, ${now}, ${now}
      )
    `;
    log.info("automation_created", { automationId });
    await updateCampaignSync(campaignId, {
      syncStatus: "DM_SYNCED",
      syncError: null,
      instagramMediaId: post.instagram_media_id,
      openreplyAutomationId: automationId
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateCampaignSync(campaignId, { syncStatus: "DM_SYNC_FAILED", syncError: message });
    log.error("sync_failed", { error: message });
    if (err instanceof NonRetryableError) return; // terminal — needs a human fix (e.g. connect the account in OpenReply), not a retry
    throw err instanceof RetryableError ? err : new RetryableError(message, "OPENREPLY_SYNC_ERROR");
  }
}
