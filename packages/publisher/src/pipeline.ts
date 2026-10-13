import { readFile } from "node:fs/promises";
import { rootLogger, loadEnv, ValidationError, NonRetryableError, AuthError, type Logger, type PostRow } from "@jqp/core";
import { recordEvent } from "./events.js";
import { uploadPostMedia, preflightMediaUrl, deletePostMedia } from "@jqp/storage";
import {
  createChildContainer,
  createSingleImageContainer,
  createCarouselContainer,
  pollContainerUntilReady,
  publishMedia,
  getContainerStatus,
  listRecentMedia,
  resolveInstagramAccount
} from "@jqp/meta";
import { enqueueSyncCampaign } from "@jqp/queue";
import { scanPostFolder } from "./scanner.js";
import { validatePost } from "./validator.js";
import {
  upsertDiscoveredPost,
  getPost,
  updatePostStatus,
  listPostMedia,
  upsertPostMedia,
  setPostMediaStorage,
  setPostMediaContainer,
  resolveAccountForPost,
  getCampaignByPostId,
  isInstagramMediaIdUsed
} from "./repository.js";

/** Thrown when another runner advanced the same post first; this runner stops quietly and leaves the post to it. */
export class ConcurrentRunError extends Error {
  constructor(postId: string) {
    super(`Post ${postId} was advanced by another runner`);
    this.name = "ConcurrentRunError";
  }
}

const identityCache = new Map<string, number>();
const IDENTITY_TTL_MS = 10 * 60_000;

/**
 * resolveAccountForPost plus a check that the token really belongs to the account we think we are posting to.
 * Without it, a token from the previous account left in an env file would publish to the wrong profile.
 * The answer is cached for 10 minutes per token so a post does not cost one call per step.
 */
async function resolveVerifiedAccount(post: PostRow): Promise<{ igUserId: string; accessToken: string }> {
  const account = await resolveAccountForPost(post);
  if (loadEnv().MOCK_META) return account;
  const key = `${account.igUserId}:${account.accessToken.slice(-10)}`;
  const seen = identityCache.get(key);
  if (seen && Date.now() - seen < IDENTITY_TTL_MS) return account;

  const actual = await resolveInstagramAccount(account.accessToken);
  if (actual.igUserId !== account.igUserId) {
    throw new NonRetryableError(
      `The Instagram token belongs to ${actual.username ? "@" + actual.username : "account " + actual.igUserId}, but this post is set to publish as account ${account.igUserId}. Nothing was published. Run: npm run connect-account`,
      "TOKEN_ACCOUNT_MISMATCH",
      { expected: account.igUserId, actual: actual.igUserId }
    );
  }
  identityCache.set(key, Date.now());
  return account;
}

/** Test hook: forget which tokens were verified. */
export function __resetIdentityCacheForTests(): void {
  identityCache.clear();
}

/**
 * Scans a folder and ensures a DISCOVERED post row exists for it.
 * Idempotent (plan section 48): calling this again for a folder that
 * already has a post row — at any status, including PUBLISHED — is a
 * no-op that returns the existing row untouched.
 */
export async function ingestPostFolder(folderPath: string): Promise<PostRow> {
  const scanned = await scanPostFolder(folderPath);
  const mediaType = scanned.images.length === 1 ? "IMAGE" : "CAROUSEL";
  return upsertDiscoveredPost({
    campaignId: scanned.campaignId,
    folderName: scanned.campaignId,
    folderPath,
    caption: scanned.caption,
    mediaType
  });
}

/**
 * Drives one post through DISCOVERED -> PUBLISHED, persisting every
 * transition to Postgres before moving to the next step. Safe to call
 * repeatedly on the same postId: an already-PUBLISHED post returns
 * immediately (plan section 48), and a post that crashed mid-pipeline
 * resumes from its last persisted status rather than restarting
 * (plan section 66) — this function always re-reads current state
 * from the DB first rather than trusting in-memory state from a
 * previous attempt.
 *
 * This intentionally runs the whole pipeline — including Meta's
 * container polling — inside one call. That's only safe because the
 * caller (apps/worker) is a persistent process, not a short-lived
 * serverless function (plan section 25).
 */
export async function runPublishPipeline(postId: string, folderPathOverride?: string): Promise<void> {
  const log = rootLogger.child({ postId });
  let post = await getPost(postId);
  if (!post) throw new Error(`runPublishPipeline: no post found for id ${postId}`);

  // Callers that already have the row (or a test fixture) may pass folderPath
  // explicitly; otherwise fall back to the path captured at ingestion time.
  const folderPath = folderPathOverride ?? post.folder_path;

  if (post.status === "PUBLISHED") {
    log.info("post_already_published_skipping");
    return;
  }
  if (post.status === "FAILED" || post.status === "VALIDATION_FAILED") {
    log.info("post_in_terminal_failed_state_skipping", { status: post.status });
    return;
  }

  try {
    if (post.status === "DISCOVERED") {
      post = await stepValidate(post, folderPath, log);
    }
    if (post.status === "UPLOADING") {
      post = await stepUpload(post, folderPath, log);
    }
    if (post.status === "CREATING_CHILDREN") {
      post = await stepCreateChildren(post, log);
    }
    if (post.status === "WAITING_FOR_CHILDREN") {
      post = await stepWaitForChildren(post, log);
    }
    if (post.status === "CREATING_CAROUSEL") {
      post = await stepCreateCreatable(post, log);
    }
    if (post.status === "WAITING_FOR_CAROUSEL") {
      post = await stepWaitForCreatable(post, log);
    }
    if (post.status === "PUBLISHING") {
      post = await stepPublish(post, log);
    }
    log.info("publish_pipeline_finished", { status: post.status });
  } catch (err) {
    if (err instanceof ConcurrentRunError) {
      log.warn("publish_pipeline_concurrent_run_stopped", { error: err.message });
      return;
    }
    if (err instanceof ValidationError) {
      // Should have been caught inside stepValidate already, but guard here too.
      await updatePostStatus(postId, { status: "VALIDATION_FAILED", errorMessage: err.message });
      log.warn("publish_pipeline_validation_failed", { error: err.message });
      void recordEvent({ level: "warn", source: "publish", code: "post_validation_failed", message: err.message, meta: { postId } });
      return;
    }
    // NonRetryableError covers AuthError too (AuthError extends NonRetryableError) — both are terminal, a retry cannot fix either.
    if (err instanceof NonRetryableError) {
      const message = err.message;
      await updatePostStatus(postId, { status: "FAILED", errorMessage: message });
      log.error("publish_pipeline_failed_terminal", { error: message });
      void recordEvent({ level: "error", source: "publish", code: "post_publish_failed", message, meta: { postId } });
      return;
    }
    // Retryable — leave status where it is (already persisted at the top of the failed step) and rethrow so pg-boss retries the job.
    log.warn("publish_pipeline_retryable_error", { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

async function stepValidate(post: PostRow, folderPath: string, log: Logger): Promise<PostRow> {
  await updatePostStatus(post.id, { status: "VALIDATING" });
  const scanned = await scanPostFolder(folderPath);
  const result = await validatePost(scanned);

  if (!result.valid) {
    const message = result.issues.map((i) => `${i.code}: ${i.message}`).join("; ");
    await updatePostStatus(post.id, { status: "VALIDATION_FAILED", errorMessage: message });
    log.warn("post_validation_failed", { issues: result.issues });
    return { ...post, status: "VALIDATION_FAILED", error_message: message };
  }

  for (const img of result.images) {
    await upsertPostMedia({ postId: post.id, sequence: img.sequence, originalFilename: img.originalFilename });
  }

  await updatePostStatus(post.id, { status: "UPLOADING" });
  log.info("post_validated", { imageCount: result.images.length });
  return { ...post, status: "UPLOADING" };
}

async function stepUpload(post: PostRow, folderPath: string, log: Logger): Promise<PostRow> {
  const media = await listPostMedia(post.id);
  const scanned = await scanPostFolder(folderPath);
  const validated = await validatePost(scanned);
  const bySequence = new Map(validated.images.map((img) => [img.sequence, img]));

  for (const row of media) {
    if (row.public_url) continue; // already uploaded — resume-safe
    const img = bySequence.get(row.sequence);
    if (!img) throw new Error(`stepUpload: no validated image for post ${post.id} sequence ${row.sequence} (folder contents changed since validation?)`);

    const { storagePath, publicUrl } = await uploadPostMedia({
      campaignId: post.campaign_id,
      sequence: row.sequence,
      originalFilename: row.original_filename,
      fileBuffer: img.buffer
    });
    await preflightMediaUrl(publicUrl);
    await setPostMediaStorage(row.id, storagePath, publicUrl);
    log.info("image_uploaded", { sequence: row.sequence, storagePath });
  }

  const nextStatus = post.media_type === "IMAGE" ? "CREATING_CAROUSEL" : "CREATING_CHILDREN";
  await updatePostStatus(post.id, { status: nextStatus });
  return { ...post, status: nextStatus };
}

async function stepCreateChildren(post: PostRow, log: Logger): Promise<PostRow> {
  const { igUserId, accessToken } = await resolveVerifiedAccount(post);
  const media = await listPostMedia(post.id);

  for (const row of media) {
    if (row.child_container_id) continue; // resume-safe
    if (!row.public_url) throw new Error(`stepCreateChildren: post_media ${row.id} has no public_url yet`);

    const container = await createChildContainer({ igUserId, imageUrl: row.public_url, accessToken });
    await setPostMediaContainer(row.id, container.id, "IN_PROGRESS");
    log.info("child_container_created", { sequence: row.sequence, containerId: container.id });
  }

  await updatePostStatus(post.id, { status: "WAITING_FOR_CHILDREN" });
  return { ...post, status: "WAITING_FOR_CHILDREN" };
}

async function stepWaitForChildren(post: PostRow, log: Logger): Promise<PostRow> {
  const { accessToken } = await resolveAccountForPost(post);
  const media = await listPostMedia(post.id);

  await Promise.all(
    media.map(async (row) => {
      if (!row.child_container_id) throw new Error(`stepWaitForChildren: post_media ${row.id} has no child_container_id`);
      await pollContainerUntilReady(row.child_container_id, { accessToken });
    })
  );

  log.info("all_children_ready", { count: media.length });
  await updatePostStatus(post.id, { status: "CREATING_CAROUSEL" });
  return { ...post, status: "CREATING_CAROUSEL" };
}

/** Despite the name (kept consistent with the plan's status enum), this creates the single publishable container — a carousel container for multi-image posts, or the one image container for a single-image post (plan section 69's simpler Phase 2 path). */
async function stepCreateCreatable(post: PostRow, log: Logger): Promise<PostRow> {
  const { igUserId, accessToken } = await resolveVerifiedAccount(post);
  const media = await listPostMedia(post.id);

  let creationId: string;
  if (post.media_type === "IMAGE") {
    const only = media[0];
    if (!only?.public_url) throw new Error(`stepCreateCreatable: single-image post ${post.id} has no uploaded image`);
    const container = await createSingleImageContainer({ igUserId, imageUrl: only.public_url, caption: post.caption, accessToken });
    creationId = container.id;
  } else {
    const childIds = media.map((m) => m.child_container_id);
    if (childIds.some((id) => !id)) throw new Error(`stepCreateCreatable: post ${post.id} has a media row with no child_container_id`);
    const container = await createCarouselContainer({ igUserId, childContainerIds: childIds as string[], caption: post.caption, accessToken });
    creationId = container.id;
  }

  await updatePostStatus(post.id, { status: "WAITING_FOR_CAROUSEL", carouselContainerId: creationId });
  log.info("creatable_container_created", { creationId, mediaType: post.media_type });
  return { ...post, status: "WAITING_FOR_CAROUSEL", carousel_container_id: creationId };
}

async function stepWaitForCreatable(post: PostRow, log: Logger): Promise<PostRow> {
  const { accessToken } = await resolveAccountForPost(post);
  if (!post.carousel_container_id) throw new Error(`stepWaitForCreatable: post ${post.id} has no carousel_container_id`);

  await pollContainerUntilReady(post.carousel_container_id, { accessToken });

  log.info("creatable_container_ready");
  // Compare-and-set: only one runner can move the post into PUBLISHING, so two runners that picked up
  // the same post cannot both go on to publish it.
  const moved = await updatePostStatus(post.id, { status: "PUBLISHING" }, { from: ["WAITING_FOR_CAROUSEL"] });
  if (!moved) throw new ConcurrentRunError(post.id);
  return { ...post, status: "PUBLISHING" };
}

const normalizeCaption = (text: string): string => text.replace(/\s+/g, " ").trim();
// Instagram writes timestamps like 2026-10-13T12:00:00+0000; make the offset parseable everywhere.
const parseInstagramTime = (ts: string): number => Date.parse(ts.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));

/**
 * Looks for a post that is already live on the account for this folder: same caption, published after our
 * row was created, and not already recorded against another post. This is what makes a publish whose answer
 * got lost (or a Retry of a post that did go out) safe: the pipeline records the live post instead of
 * publishing a second copy.
 */
async function findLiveMedia(post: PostRow, igUserId: string, accessToken: string): Promise<string | null> {
  const since = Date.parse(post.created_at);
  const wanted = normalizeCaption(post.caption);
  const recent = await listRecentMedia(igUserId, accessToken, 25);
  for (const item of recent) {
    if (!item.caption || normalizeCaption(item.caption) !== wanted) continue;
    if (item.timestamp && Number.isFinite(since) && parseInstagramTime(item.timestamp) < since) continue;
    if (await isInstagramMediaIdUsed(item.id)) continue;
    return item.id;
  }
  return null;
}

async function stepPublish(post: PostRow, log: Logger): Promise<PostRow> {
  const { igUserId, accessToken } = await resolveVerifiedAccount(post);
  if (!post.carousel_container_id) throw new Error(`stepPublish: post ${post.id} has no carousel_container_id`);

  // 1. Is this post (or this container) already live? Meta gives no way to take a publish back, so check before
  //    publishing, not after. A failed status lookup is a retryable error and stops here: never publish blind.
  let mediaId: string | null = null;
  const container = await getContainerStatus(post.carousel_container_id, accessToken);
  if (container.status === "PUBLISHED") {
    mediaId = await findLiveMedia(post, igUserId, accessToken);
    if (!mediaId) {
      throw new NonRetryableError(
        "Instagram says this container was already published, but the post could not be found in the account's recent media. Nothing more was published. Check the Instagram profile, then fix the post by hand.",
        "PUBLISHED_MEDIA_NOT_FOUND",
        { postId: post.id }
      );
    }
    log.warn("container_already_published_recording_existing_media", { instagramMediaId: mediaId });
  } else {
    mediaId = await findLiveMedia(post, igUserId, accessToken);
    if (mediaId) log.warn("matching_post_already_live_not_publishing_again", { instagramMediaId: mediaId });
  }

  // 2. Publish (a single HTTP attempt; see publishMedia).
  if (!mediaId) {
    try {
      mediaId = (await publishMedia({ igUserId, creationId: post.carousel_container_id, accessToken })).id;
    } catch (err) {
      // A 4xx can also mean "that container is already published". Look before giving up on the post.
      if (err instanceof NonRetryableError && !(err instanceof AuthError)) {
        const live = await findLiveMedia(post, igUserId, accessToken);
        if (!live) throw err;
        log.warn("publish_rejected_but_post_is_live", { instagramMediaId: live });
        mediaId = live;
      } else {
        throw err;
      }
    }
  }

  const recorded = await updatePostStatus(
    post.id,
    { status: "PUBLISHED", instagramMediaId: mediaId, publishedAt: new Date() },
    { from: ["PUBLISHING"] }
  );
  if (!recorded) {
    // Another runner already finished this post. Nothing is lost; do not run the follow-ups twice.
    log.warn("post_already_recorded_by_another_runner", { instagramMediaId: mediaId });
    return { ...post, status: "PUBLISHED", instagram_media_id: mediaId };
  }
  log.info("post_published", { instagramMediaId: mediaId });

  // Instagram now holds its own copy, so ours is dead weight sitting in a
  // public bucket at a guessable path. Purge the bytes but keep the post_media
  // rows (storage_path / public_url) for audit history.
  //
  // Best-effort by design: the post is already live on Instagram at this point,
  // and no storage failure should turn a successful publish into a failed one.
  try {
    const media = await listPostMedia(post.id);
    const paths = media.map((m) => m.storage_path).filter((p): p is string => Boolean(p));
    const { removed, error } = await deletePostMedia(paths);
    if (error) log.warn("post_media_cleanup_failed", { error, pathCount: paths.length });
    else log.info("post_media_cleaned_up", { removed });
  } catch (err) {
    log.warn("post_media_cleanup_failed", { error: err instanceof Error ? err.message : String(err) });
  }

  // Plan section 77 (automatic campaign registration): if the user already
  // staged a campaign for this post and enabled it, kick off the sync now —
  // otherwise it stays DM_SYNC_PENDING until they enable it from the dashboard.
  // Never fails the job: the post is live, and a retry would return early at PUBLISHED and never run this
  // again. A failure is recorded so it shows up on the System page, and the sync can be re-run from the campaign.
  try {
    const campaign = await getCampaignByPostId(post.id);
    if (campaign && campaign.enabled) {
      await enqueueSyncCampaign({ campaignId: campaign.id });
      log.info("sync_campaign_enqueued", { campaignId: campaign.id });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("sync_campaign_enqueue_failed", { error: message });
    void recordEvent({
      level: "error",
      source: "publish",
      code: "campaign_sync_enqueue_failed",
      message: "The post is live but its campaign could not be queued for sync. Re-save the campaign to retry.",
      meta: { postId: post.id }
    });
  }

  return { ...post, status: "PUBLISHED", instagram_media_id: mediaId };
}

// Re-export for callers that only need to read a folder's caption for display without running the pipeline.
export async function readCaptionOnly(captionPath: string): Promise<string> {
  return readFile(captionPath, "utf-8");
}
