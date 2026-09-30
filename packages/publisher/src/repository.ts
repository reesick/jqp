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

export interface PostStatusUpdate {
  status: PostStatus;
  errorMessage?: string | null;
  instagramMediaId?: string;
  carouselContainerId?: string;
  publishedAt?: Date;
}

export async function updatePostStatus(postId: string, update: PostStatusUpdate): Promise<void> {
  const sql = getDb();
  await sql`
    update posts set
      status = ${update.status},
      error_message = ${update.errorMessage ?? null},
      instagram_media_id = coalesce(${update.instagramMediaId ?? null}, instagram_media_id),
      carousel_container_id = coalesce(${update.carouselContainerId ?? null}, carousel_container_id),
      published_at = coalesce(${update.publishedAt ?? null}, published_at)
    where id = ${postId}
  `;
}

/** Resets a FAILED/VALIDATION_FAILED post back to DISCOVERED so the pipeline runs again from the top. Used by the dashboard's manual Retry action — never called automatically (plan section 64: failures require an explicit retry, not silent auto-resurrection). */
export async function resetPostForRetry(postId: string): Promise<void> {
  const sql = getDb();
  await sql`
    update posts set status = 'DISCOVERED', error_message = null
    where id = ${postId} and status in ('FAILED', 'VALIDATION_FAILED')
  `;
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
}

/**
 * Resolves the Instagram account + decrypted access token to publish
 * with. Falls back to META_LONG_LIVED_ACCESS_TOKEN / META_IG_USER_ID
 * (plan's Phase 2 bootstrap path, before OAuth is wired up) when the
 * post has no ig_account_id yet.
 */
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

/** Creates or updates the staged campaign for a post (one campaign per post — plan section 21). Does NOT touch OpenReply; that only happens via the sync-campaign-to-openreply job (T12). */
export async function upsertCampaign(params: UpsertCampaignParams): Promise<CampaignRow> {
  const sql = getDb();
  // Opening-DM text fields are normalised to NULL when the toggle is off, not
  // left as empty strings — OpenReply's dm-worker gates the two-step flow on all
  // three columns being truthy, so a stray "" would read the same as NULL there
  // but differ in our own UI round-trip. Same normalisation their own builder does.
  const openingDmEnabled = params.openingDmEnabled ?? false;
  const openingDmMessage = openingDmEnabled ? params.openingDmMessage || null : null;
  const openingDmButtonLabel = openingDmEnabled ? params.openingDmButtonLabel || null : null;

  const rows = await sql<CampaignRow[]>`
    insert into campaigns (post_id, trigger_keywords, match_mode, dm_message, destination_url, public_reply_enabled, public_reply_message, opening_dm_enabled, opening_dm_message, opening_dm_button_label, enabled)
    values (${params.postId}, ${params.triggerKeywords}, ${params.matchMode}, ${params.dmMessage}, ${params.destinationUrl ?? null}, ${params.publicReplyEnabled}, ${params.publicReplyMessage ?? null}, ${openingDmEnabled}, ${openingDmMessage}, ${openingDmButtonLabel}, ${params.enabled})
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
