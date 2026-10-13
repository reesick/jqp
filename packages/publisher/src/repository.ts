import { createHash } from "node:crypto";
import {
  getDb,
  decryptSecret,
  encryptSecret,
  AuthError,
  loadEnv,
  type PostRow,
  type PostMediaRow,
  type PostStatus,
  type ContainerStatus,
  type CampaignRow,
  type CampaignSyncStatus,
  type IgAccountRow
} from "@jqp/core";
import { normalizeMessageText, normalizeOptionalMessage } from "./message-text.js";

// --------------------------------------------------------------------
// posts
// --------------------------------------------------------------------

/**
 * Inserts a DISCOVERED row for a scanned folder, or returns the
 * existing row untouched if one already exists for this campaign_id.
 * This is the idempotency boundary for ingestion (plan section 48):
 * scanning the same folder twice never creates a duplicate post or
 * resets an already-published one.
 */
export async function upsertDiscoveredPost(params: {
  campaignId: string;
  folderName: string;
  folderPath: string;
  caption: string;
  mediaType: "IMAGE" | "CAROUSEL";
}): Promise<PostRow> {
  const sql = getDb();
  const rows = await sql<PostRow[]>`
    insert into posts (campaign_id, folder_name, folder_path, caption, media_type, status)
    values (${params.campaignId}, ${params.folderName}, ${params.folderPath}, ${params.caption}, ${params.mediaType}, 'DISCOVERED')
    on conflict (campaign_id) do nothing
    returning *
  `;
  if (rows[0]) return rows[0];

  const existing = await sql<PostRow[]>`select * from posts where campaign_id = ${params.campaignId}`;
  if (!existing[0]) throw new Error(`upsertDiscoveredPost: conflict but no existing row found for ${params.campaignId}`);
  return existing[0];
}

export async function getPost(postId: string): Promise<PostRow | null> {
  const sql = getDb();
  const rows = await sql<PostRow[]>`select * from posts where id = ${postId}`;
  return rows[0] ?? null;
}

export async function getPostByCampaignId(campaignId: string): Promise<PostRow | null> {
  const sql = getDb();
  const rows = await sql<PostRow[]>`select * from posts where campaign_id = ${campaignId}`;
  return rows[0] ?? null;
}

export async function listPosts(): Promise<PostRow[]> {
  const sql = getDb();
  return sql<PostRow[]>`select * from posts order by created_at desc`;
}

/** Newest posts only. The overview needs a handful, not the whole table. */
export async function listRecentPosts(limit = 5): Promise<PostRow[]> {
  const sql = getDb();
  return sql<PostRow[]>`select * from posts order by created_at desc limit ${limit}`;
}

/** Posts that need a human: failed pipeline runs and failed validations. */
export async function listFailedPosts(limit = 5): Promise<PostRow[]> {
  const sql = getDb();
  return sql<PostRow[]>`
    select * from posts
    where status in ('FAILED', 'VALIDATION_FAILED')
    order by updated_at desc
    limit ${limit}
  `;
}

export interface PostStatusUpdate {
  status: PostStatus;
  errorMessage?: string | null;
  instagramMediaId?: string;
  carouselContainerId?: string;
  publishedAt?: Date;
}

/**
 * Moves a post to a new status. With `from`, the move only happens if the post is still in one of those
 * statuses (compare-and-set), and the return value says whether it did. That is how two runners that picked up
 * the same post cannot both advance it past a checkpoint.
 */
export async function updatePostStatus(postId: string, update: PostStatusUpdate, options: { from?: PostStatus[] } = {}): Promise<boolean> {
  const sql = getDb();
  const from = options.from;
  const rows = await sql<{ id: string }[]>`
    update posts set
      status = ${update.status},
      error_message = ${update.errorMessage ?? null},
      instagram_media_id = coalesce(${update.instagramMediaId ?? null}, instagram_media_id),
      carousel_container_id = coalesce(${update.carouselContainerId ?? null}, carousel_container_id),
      published_at = coalesce(${update.publishedAt ?? null}, published_at)
    where id = ${postId}
      ${from ? sql`and status::text = any(${from})` : sql``}
    returning id
  `;
  return rows.length > 0;
}

/**
 * True if a post OTHER than `excludePostId` already carries this Instagram media id (so a lookup never claims
 * another post's media, but a post's own recorded media id does not count against itself).
 */
export async function isInstagramMediaIdUsed(mediaId: string, excludePostId?: string): Promise<boolean> {
  const sql = getDb();
  const rows = await sql<{ id: string }[]>`
    select id from posts where instagram_media_id = ${mediaId} and id::text <> ${excludePostId ?? ""} limit 1
  `;
  return rows.length > 0;
}

/** True if another post that is not published yet has the same caption (whitespace-insensitive). Template captions make a caption match ambiguous. */
export async function hasOtherUnpublishedPostWithCaption(postId: string, caption: string): Promise<boolean> {
  const sql = getDb();
  const wanted = caption.replace(/\s+/g, " ").trim();
  const rows = await sql<{ id: string }[]>`
    select id from posts
    where id::text <> ${postId} and status::text <> 'PUBLISHED'
      and trim(regexp_replace(caption, '[[:space:]]+', ' ', 'g')) = ${wanted}
    limit 1
  `;
  return rows.length > 0;
}

/** Marker at the start of a failure message that means "a human must look at Instagram before this post is retried". */
export const LIVE_CHECK_REQUIRED = "LIVE_CHECK_REQUIRED:";

/** A stable UUID for a campaign's automation (name-based, version 5 layout), so creating it twice yields the same row. */
export function automationIdForCampaign(campaignId: string): string {
  const hash = createHash("sha1").update(`jqp-automation:${campaignId}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Resets a FAILED/VALIDATION_FAILED post back to DISCOVERED so the pipeline runs again from the top. Used by the
 * dashboard's manual Retry action — never called automatically (plan section 64).
 *
 * The old containers are cleared too: Instagram containers expire after about a day and an errored one stays errored,
 * so reusing them made a failed post fail the same way on every retry. A post that already has an Instagram media id
 * is live and is never reset. A post whose failure says LIVE_CHECK_REQUIRED (Instagram may already show it) is
 * not reset either, unless the caller passes confirmNotLive after looking at the profile. Returns true if reset.
 */
export async function resetPostForRetry(postId: string, options: { confirmNotLive?: boolean } = {}): Promise<boolean> {
  const sql = getDb();
  const liveCheck = `${LIVE_CHECK_REQUIRED}%`;
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      update posts set status = 'DISCOVERED', error_message = null, carousel_container_id = null
      where id = ${postId} and status in ('FAILED', 'VALIDATION_FAILED') and instagram_media_id is null
        and (${options.confirmNotLive === true} or coalesce(error_message, '') not like ${liveCheck})
      returning id
    `;
    if (rows.length === 0) return false;
    await tx`update post_media set child_container_id = null, container_status = 'PENDING' where post_id = ${postId}`;
    return true;
  }) as Promise<boolean>;
}

// --------------------------------------------------------------------
// post_media
// --------------------------------------------------------------------

export async function listPostMedia(postId: string): Promise<PostMediaRow[]> {
  const sql = getDb();
  return sql<PostMediaRow[]>`select * from post_media where post_id = ${postId} order by sequence asc`;
}

export async function upsertPostMedia(params: { postId: string; sequence: number; originalFilename: string }): Promise<PostMediaRow> {
  const sql = getDb();
  const rows = await sql<PostMediaRow[]>`
    insert into post_media (post_id, sequence, original_filename, storage_path)
    values (${params.postId}, ${params.sequence}, ${params.originalFilename}, '')
    on conflict (post_id, sequence) do update set original_filename = excluded.original_filename
    returning *
  `;
  const row = rows[0];
  if (!row) throw new Error(`upsertPostMedia: insert returned no row for post ${params.postId} sequence ${params.sequence}`);
  return row;
}

export async function setPostMediaStorage(id: string, storagePath: string, publicUrl: string): Promise<void> {
  const sql = getDb();
  await sql`update post_media set storage_path = ${storagePath}, public_url = ${publicUrl} where id = ${id}`;
}

export async function setPostMediaContainer(id: string, childContainerId: string, status: ContainerStatus): Promise<void> {
  const sql = getDb();
  await sql`update post_media set child_container_id = ${childContainerId}, container_status = ${status} where id = ${id}`;
}

export async function setPostMediaContainerStatus(id: string, status: ContainerStatus): Promise<void> {
  const sql = getDb();
  await sql`update post_media set container_status = ${status} where id = ${id}`;
}

// --------------------------------------------------------------------
// access token resolution
// --------------------------------------------------------------------

export interface ResolvedAccount {
  igUserId: string;
  accessToken: string;
  /** Set when a stored token was chosen and the env bootstrap token is also available, so a rejected stored token can fall back. */
  envFallbackToken?: string;
}

/**
 * Resolves the Instagram account + decrypted access token to publish
 * with. Falls back to META_LONG_LIVED_ACCESS_TOKEN / META_IG_USER_ID
 * (plan's Phase 2 bootstrap path, before OAuth is wired up) when the
 * post has no ig_account_id yet.
 */
type StoredAccountRow = { ig_user_id: string; access_token_encrypted: string | null; access_token_iv: string | null; access_token_tag: string | null; is_active: boolean };

export async function resolveAccountForPost(post: PostRow): Promise<ResolvedAccount> {
  const env = loadEnv();
  const sql = getDb();

  if (post.ig_account_id) {
    const rows = await sql<{ ig_user_id: string; access_token_encrypted: string | null; access_token_iv: string | null; access_token_tag: string | null; is_active: boolean }[]>`
      select ig_user_id, access_token_encrypted, access_token_iv, access_token_tag, is_active
      from ig_accounts where id = ${post.ig_account_id}
    `;
    const account = rows[0];
    if (!account || !account.is_active) {
      throw new AuthError(`Instagram account for post ${post.campaign_id} is missing or inactive — reconnect it`, { postId: post.id });
    }
    if (!account.access_token_encrypted || !account.access_token_iv || !account.access_token_tag) {
      throw new AuthError(`Instagram account for post ${post.campaign_id} has no stored access token — reconnect it`, { postId: post.id });
    }
    let accessToken: string;
    try {
      accessToken = decryptSecret({
        ciphertext: account.access_token_encrypted,
        iv: account.access_token_iv,
        authTag: account.access_token_tag
      });
    } catch (err) {
      // Same class of failure as the two guards above (permanent, requires
      // reconnecting the account) — classify it the same way, not as a
      // generic error the pipeline would otherwise retry pointlessly.
      const message = err instanceof Error ? err.message : String(err);
      throw new AuthError(`Stored access token for post ${post.campaign_id} could not be decrypted (${message}) — ENCRYPTION_KEY may have changed; reconnect the account`, {
        postId: post.id
      });
    }
    return { igUserId: account.ig_user_id, accessToken };
  }

  // No account chosen on the post: use the default account. If its token is stored (and kept fresh by the weekly
  // refresh job) that wins over the bootstrap env token, which never renews itself. A stored token that cannot be
  // decrypted falls back to the env token rather than blocking publishing.
  if (env.META_IG_USER_ID) {
    const stored = await sql<StoredAccountRow[]>`
      select ig_user_id, access_token_encrypted, access_token_iv, access_token_tag, is_active
      from ig_accounts
      where ig_user_id = ${env.META_IG_USER_ID} and is_active and (token_expires_at is null or token_expires_at > now())
    `;
    const row = stored[0];
    if (row?.access_token_encrypted && row.access_token_iv && row.access_token_tag) {
      try {
        const accessToken = decryptSecret({ ciphertext: row.access_token_encrypted, iv: row.access_token_iv, authTag: row.access_token_tag });
        return { igUserId: row.ig_user_id, accessToken, envFallbackToken: env.META_LONG_LIVED_ACCESS_TOKEN || undefined };
      } catch {
        /* fall through to the bootstrap token */
      }
    }
  }

  if (env.META_LONG_LIVED_ACCESS_TOKEN) {
    return { igUserId: env.META_IG_USER_ID, accessToken: env.META_LONG_LIVED_ACCESS_TOKEN };
  }

  throw new AuthError(`No Instagram account connected for post ${post.campaign_id}, and no META_LONG_LIVED_ACCESS_TOKEN bootstrap token is set`, {
    postId: post.id
  });
}

/** Same resolution as resolveAccountForPost, but returns only the ig_user_id (no token needed) — used by the OpenReply bridge to look up the matching InstagramAccount row on their side. */
export async function resolveIgUserIdForPost(post: PostRow): Promise<string> {
  const env = loadEnv();
  if (post.ig_account_id) {
    const sql = getDb();
    const rows = await sql<{ ig_user_id: string }[]>`select ig_user_id from ig_accounts where id = ${post.ig_account_id}`;
    if (rows[0]) return rows[0].ig_user_id;
  }
  if (env.META_IG_USER_ID) return env.META_IG_USER_ID;
  throw new AuthError(`Cannot resolve an Instagram account ID for post ${post.campaign_id}`, { postId: post.id });
}

// --------------------------------------------------------------------
// campaigns (our staging table — see supabase/migrations/0001_init.sql)
// --------------------------------------------------------------------

export async function getCampaign(campaignId: string): Promise<CampaignRow | null> {
  const sql = getDb();
  const rows = await sql<CampaignRow[]>`select * from campaigns where id = ${campaignId}`;
  return rows[0] ?? null;
}

export async function getCampaignByPostId(postId: string): Promise<CampaignRow | null> {
  const sql = getDb();
  const rows = await sql<CampaignRow[]>`select * from campaigns where post_id = ${postId}`;
  return rows[0] ?? null;
}

export interface CampaignWithPost extends CampaignRow {
  campaign_id: string; // the post's campaign_id (folder name), for display
  post_status: PostStatus;
}

export async function listCampaigns(): Promise<CampaignWithPost[]> {
  const sql = getDb();
  return sql<CampaignWithPost[]>`
    select c.*, p.campaign_id, p.status as post_status
    from campaigns c
    join posts p on p.id = c.post_id
    order by c.created_at desc
  `;
}

export interface UpsertCampaignParams {
  postId: string;
  triggerKeywords: string[];
  matchMode: CampaignRow["match_mode"];
  dmMessage: string;
  destinationUrl?: string | null;
  publicReplyEnabled: boolean;
  publicReplyMessage?: string | null;
  openingDmEnabled?: boolean;
  openingDmMessage?: string | null;
  openingDmButtonLabel?: string | null;
  enabled: boolean;
}

/**
 * Switches one OpenReply automation off. OpenReply's worker only answers comments, button taps
 * and follow-ups for automations with isActive = true, so this is what actually stops the DMs.
 * Idempotent. It throws if the update fails, because "off" must never be reported when it did
 * not happen.
 */
export async function deactivateOpenReplyAutomation(automationId: string): Promise<void> {
  const sql = getDb();
  await sql`update "Automation" set "isActive" = false, "updatedAt" = ${new Date()} where "id" = ${automationId}`;
}

/**
 * Creates or updates the staged campaign for a post (one campaign per post — plan section 21).
 * Turning a campaign OFF is applied to OpenReply here, immediately and before our own row changes,
 * so it works from every caller (dashboard, REST API, Claude Code tools) and does not depend on a
 * worker being up. Turning one ON still goes through the sync-campaign-to-openreply job (T12).
 */
export async function upsertCampaign(params: UpsertCampaignParams): Promise<CampaignRow> {
  if (!params.enabled) {
    const existing = await getCampaignByPostId(params.postId);
    // If this throws, nothing has changed on our side, the caller sees an error, and the campaign
    // stays enabled. The reverse order could show "off" while OpenReply kept sending.
    if (existing?.openreply_automation_id) await deactivateOpenReplyAutomation(existing.openreply_automation_id);
    // A sync that created the automation but failed before saving its id leaves no ledger entry. The id is derived
    // from the campaign, so switch that one off too (a no-op when it does not exist).
    if (existing && existing.openreply_automation_id !== automationIdForCampaign(existing.id)) {
      await deactivateOpenReplyAutomation(automationIdForCampaign(existing.id));
    }
  }
  const sql = getDb();
  // Opening-DM text fields are normalised to NULL when the toggle is off, not
  // left as empty strings — OpenReply's dm-worker gates the two-step flow on all
  // three columns being truthy, so a stray "" would read the same as NULL there
  // but differ in our own UI round-trip. Same normalisation their own builder does.
  const openingDmEnabled = params.openingDmEnabled ?? false;
  // Every piece of copy is stripped of Markdown / escaped-newline debris here, the
  // one choke point all writers share (form, REST API, Claude Code tools), so none
  // of it can reach a recipient as literal "**", "\n" or "--".
  const openingDmMessage = openingDmEnabled ? normalizeOptionalMessage(params.openingDmMessage) : null;
  const openingDmButtonLabel = openingDmEnabled ? normalizeOptionalMessage(params.openingDmButtonLabel, { singleLine: true }) : null;
  const dmMessage = normalizeMessageText(params.dmMessage);
  const publicReplyMessage = normalizeOptionalMessage(params.publicReplyMessage);

  const rows = await sql<CampaignRow[]>`
    insert into campaigns (post_id, trigger_keywords, match_mode, dm_message, destination_url, public_reply_enabled, public_reply_message, opening_dm_enabled, opening_dm_message, opening_dm_button_label, enabled)
    values (${params.postId}, ${params.triggerKeywords}, ${params.matchMode}, ${dmMessage}, ${params.destinationUrl ?? null}, ${params.publicReplyEnabled}, ${publicReplyMessage}, ${openingDmEnabled}, ${openingDmMessage}, ${openingDmButtonLabel}, ${params.enabled})
    on conflict (post_id) do update set
      trigger_keywords = excluded.trigger_keywords,
      match_mode = excluded.match_mode,
      dm_message = excluded.dm_message,
      destination_url = excluded.destination_url,
      public_reply_enabled = excluded.public_reply_enabled,
      public_reply_message = excluded.public_reply_message,
      opening_dm_enabled = excluded.opening_dm_enabled,
      opening_dm_message = excluded.opening_dm_message,
      opening_dm_button_label = excluded.opening_dm_button_label,
      enabled = excluded.enabled
    returning *
  `;
  const row = rows[0];
  if (!row) throw new Error(`upsertCampaign: insert/update returned no row for post ${params.postId}`);
  return row;
}

export interface CampaignSyncUpdate {
  syncStatus: CampaignSyncStatus;
  syncError?: string | null;
  instagramMediaId?: string;
  openreplyAutomationId?: string;
}

export async function updateCampaignSync(campaignId: string, update: CampaignSyncUpdate): Promise<void> {
  const sql = getDb();
  await sql`
    update campaigns set
      sync_status = ${update.syncStatus},
      sync_error = ${update.syncError ?? null},
      instagram_media_id = coalesce(${update.instagramMediaId ?? null}, instagram_media_id),
      openreply_automation_id = coalesce(${update.openreplyAutomationId ?? null}, openreply_automation_id)
    where id = ${campaignId}
  `;
}

// --------------------------------------------------------------------
// ig_accounts
// --------------------------------------------------------------------

export async function listIgAccounts(): Promise<IgAccountRow[]> {
  const sql = getDb();
  return sql<IgAccountRow[]>`select * from ig_accounts order by connected_at desc nulls last`;
}

/** Accounts that have a stored token, for the refresh job. Returns decrypted tokens in memory only; never log them. */
export async function listAccountsWithTokens(): Promise<{ igUserId: string; username: string | null; accessToken: string; tokenExpiresAt: string | null }[]> {
  const sql = getDb();
  const rows = await sql<(StoredAccountRow & { username: string | null; token_expires_at: string | null })[]>`
    select ig_user_id, username, access_token_encrypted, access_token_iv, access_token_tag, token_expires_at, is_active
    from ig_accounts where is_active and access_token_encrypted is not null
  `;
  const out: { igUserId: string; username: string | null; accessToken: string; tokenExpiresAt: string | null }[] = [];
  for (const row of rows) {
    if (!row.access_token_encrypted || !row.access_token_iv || !row.access_token_tag) continue;
    try {
      out.push({
        igUserId: row.ig_user_id,
        username: row.username,
        accessToken: decryptSecret({ ciphertext: row.access_token_encrypted, iv: row.access_token_iv, authTag: row.access_token_tag }),
        tokenExpiresAt: row.token_expires_at
      });
    } catch {
      /* an undecryptable token is skipped; the refresh job reports it */
    }
  }
  return out;
}

/** Replaces one account's stored token and expiry after a refresh. */
export async function updateIgAccountToken(igUserId: string, accessToken: string, expiresInSeconds: number): Promise<void> {
  const sql = getDb();
  const encrypted = encryptSecret(accessToken);
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  await sql`
    update ig_accounts set
      access_token_encrypted = ${encrypted.ciphertext}, access_token_iv = ${encrypted.iv}, access_token_tag = ${encrypted.authTag},
      token_expires_at = ${expiresAt}
    where ig_user_id = ${igUserId}
  `;
}

/** Stores a newly connected (or reconnected) Instagram account, encrypting its access token before it ever touches the database. */
export async function upsertIgAccount(params: { igUserId: string; username?: string; accessToken: string; expiresInSeconds?: number }): Promise<IgAccountRow> {
  const sql = getDb();
  const encrypted = encryptSecret(params.accessToken);
  const expiresAt = params.expiresInSeconds ? new Date(Date.now() + params.expiresInSeconds * 1000) : null;

  const rows = await sql<IgAccountRow[]>`
    insert into ig_accounts (ig_user_id, username, access_token_encrypted, access_token_iv, access_token_tag, token_expires_at, connected_at, is_active)
    values (${params.igUserId}, ${params.username ?? null}, ${encrypted.ciphertext}, ${encrypted.iv}, ${encrypted.authTag}, ${expiresAt}, now(), true)
    on conflict (ig_user_id) do update set
      username = excluded.username,
      access_token_encrypted = excluded.access_token_encrypted,
      access_token_iv = excluded.access_token_iv,
      access_token_tag = excluded.access_token_tag,
      token_expires_at = excluded.token_expires_at,
      connected_at = now(),
      is_active = true
    returning *
  `;
  const row = rows[0];
  if (!row) throw new Error(`upsertIgAccount: insert/update returned no row for ${params.igUserId}`);
  return row;
}
