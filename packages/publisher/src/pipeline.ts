import { readFile } from "node:fs/promises";
import { rootLogger, ValidationError, NonRetryableError, type Logger, type PostRow } from "@jqp/core";
import { uploadPostMedia, preflightMediaUrl, deletePostMedia } from "@jqp/storage";
import { createChildContainer, createSingleImageContainer, createCarouselContainer, pollContainerUntilReady, publishMedia } from "@jqp/meta";
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
  getCampaignByPostId
} from "./repository.js";

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
    if (err instanceof ValidationError) {
      // Should have been caught inside stepValidate already, but guard here too.
      await updatePostStatus(postId, { status: "VALIDATION_FAILED", errorMessage: err.message });
      log.warn("publish_pipeline_validation_failed", { error: err.message });
      return;
    }
    // NonRetryableError covers AuthError too (AuthError extends NonRetryableError) — both are terminal, a retry cannot fix either.
    if (err instanceof NonRetryableError) {
      const message = err.message;
      await updatePostStatus(postId, { status: "FAILED", errorMessage: message });
      log.error("publish_pipeline_failed_terminal", { error: message });
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
  const { igUserId, accessToken } = await resolveAccountForPost(post);
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
  const { igUserId, accessToken } = await resolveAccountForPost(post);
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
  await updatePostStatus(post.id, { status: "PUBLISHING" });
  return { ...post, status: "PUBLISHING" };
}

async function stepPublish(post: PostRow, log: Logger): Promise<PostRow> {
  const { igUserId, accessToken } = await resolveAccountForPost(post);
  if (!post.carousel_container_id) throw new Error(`stepPublish: post ${post.id} has no carousel_container_id`);

  const result = await publishMedia({ igUserId, creationId: post.carousel_container_id, accessToken });

  await updatePostStatus(post.id, { status: "PUBLISHED", instagramMediaId: result.id, publishedAt: new Date() });
  log.info("post_published", { instagramMediaId: result.id });

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
  const campaign = await getCampaignByPostId(post.id);
  if (campaign && campaign.enabled) {
    await enqueueSyncCampaign({ campaignId: campaign.id });
    log.info("sync_campaign_enqueued", { campaignId: campaign.id });
  }

  return { ...post, status: "PUBLISHED", instagram_media_id: result.id };
}

// Re-export for callers that only need to read a folder's caption for display without running the pipeline.
export async function readCaptionOnly(captionPath: string): Promise<string> {
  return readFile(captionPath, "utf-8");
}
