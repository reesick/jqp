import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostRow, PostMediaRow } from "@jqp/core";

// The pipeline reads MOCK_META through loadEnv(); the unit tests have no full env, so give it a minimal one.
vi.mock("@jqp/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jqp/core")>();
  return { ...actual, loadEnv: () => ({ MOCK_META: false }) };
});

const repo = {
  isInstagramMediaIdUsed: vi.fn(),
  getPost: vi.fn(),
  updatePostStatus: vi.fn(),
  listPostMedia: vi.fn(),
  upsertPostMedia: vi.fn(),
  setPostMediaStorage: vi.fn(),
  setPostMediaContainer: vi.fn(),
  resolveAccountForPost: vi.fn(),
  upsertDiscoveredPost: vi.fn(),
  getCampaignByPostId: vi.fn()
};
vi.mock("./repository.js", () => repo);

const queueMock = { enqueueSyncCampaign: vi.fn() };
vi.mock("@jqp/queue", () => queueMock);

const meta = {
  createChildContainer: vi.fn(),
  createSingleImageContainer: vi.fn(),
  createCarouselContainer: vi.fn(),
  pollContainerUntilReady: vi.fn(),
  publishMedia: vi.fn(),
  getContainerStatus: vi.fn(),
  listRecentMedia: vi.fn(),
  resolveInstagramAccount: vi.fn()
};
vi.mock("@jqp/meta", () => meta);

const storage = {
  uploadPostMedia: vi.fn(),
  preflightMediaUrl: vi.fn()
};
vi.mock("@jqp/storage", () => storage);

const scannerMock = { scanPostFolder: vi.fn() };
vi.mock("./scanner.js", () => scannerMock);

const validatorMock = { validatePost: vi.fn() };
vi.mock("./validator.js", () => validatorMock);

const { runPublishPipeline, __resetIdentityCacheForTests } = await import("./pipeline.js");
const { NonRetryableError, RetryableError } = await import("@jqp/core");

function basePost(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: "post_1",
    campaign_id: "POST_001",
    folder_name: "POST_001",
    folder_path: "/fake",
    ig_account_id: null,
    caption: "hello",
    media_type: "CAROUSEL",
    status: "DISCOVERED",
    instagram_media_id: null,
    carousel_container_id: null,
    published_at: null,
    error_message: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  scannerMock.scanPostFolder.mockResolvedValue({
    campaignId: "POST_001",
    folderPath: "/fake",
    images: [],
    caption: "hello",
    captionPath: "/fake/caption.md",
    unexpectedFiles: []
  });
  repo.resolveAccountForPost.mockResolvedValue({ igUserId: "ig_1", accessToken: "token" });
  repo.getCampaignByPostId.mockResolvedValue(null);
  // Compare-and-set succeeds unless a test says another runner got there first.
  repo.updatePostStatus.mockResolvedValue(true);
  repo.isInstagramMediaIdUsed.mockResolvedValue(false);
  meta.getContainerStatus.mockResolvedValue({ status: "FINISHED" });
  meta.listRecentMedia.mockResolvedValue([]);
  meta.resolveInstagramAccount.mockResolvedValue({ igUserId: "ig_1", username: "acct" });
  __resetIdentityCacheForTests();
});

describe("runPublishPipeline — terminal state short-circuits", () => {
  it("does nothing for an already-PUBLISHED post", async () => {
    repo.getPost.mockResolvedValue(basePost({ status: "PUBLISHED" }));
    await runPublishPipeline("post_1", "/fake");
    expect(repo.updatePostStatus).not.toHaveBeenCalled();
  });

  it("does nothing for a FAILED post (requires explicit retry, not auto-resume)", async () => {
    repo.getPost.mockResolvedValue(basePost({ status: "FAILED" }));
    await runPublishPipeline("post_1", "/fake");
    expect(repo.updatePostStatus).not.toHaveBeenCalled();
  });
});

describe("runPublishPipeline — single-image path skips carousel steps", () => {
  it("goes UPLOADING -> CREATING_CAROUSEL directly for an IMAGE post, calling createSingleImageContainer not createCarouselContainer", async () => {
    // Stateful mock DB row so each pipeline step sees the previous step's writes, same as real Postgres would.
    const mediaRow: Partial<PostMediaRow> = { id: "m1", sequence: 1, original_filename: "1.jpg", public_url: null, child_container_id: null };
    let currentStatus = "UPLOADING";
    let carouselContainerId: string | null = null;

    repo.getPost.mockImplementation(async () => basePost({ status: currentStatus as PostRow["status"], media_type: "IMAGE", carousel_container_id: carouselContainerId }));
    repo.listPostMedia.mockImplementation(async () => [mediaRow as PostMediaRow]);
    repo.setPostMediaStorage.mockImplementation(async (_id: string, _path: string, publicUrl: string) => {
      mediaRow.public_url = publicUrl;
    });
    repo.updatePostStatus.mockImplementation(async (_id: string, update: { status: string; carouselContainerId?: string }) => {
      currentStatus = update.status;
      if (update.carouselContainerId) carouselContainerId = update.carouselContainerId;
      return true;
    });

    validatorMock.validatePost.mockResolvedValue({ valid: true, issues: [], images: [{ sequence: 1, originalFilename: "1.jpg", buffer: Buffer.from("x"), width: 10, height: 10 }], caption: "hello" });
    storage.uploadPostMedia.mockResolvedValue({ storagePath: "POST_001/1-1.jpg", publicUrl: "https://example.com/1.jpg" });
    storage.preflightMediaUrl.mockResolvedValue(undefined);
    meta.createSingleImageContainer.mockResolvedValue({ id: "container_1" });
    meta.pollContainerUntilReady.mockResolvedValue(undefined);
    meta.publishMedia.mockResolvedValue({ id: "media_1" });

    await runPublishPipeline("post_1", "/fake");

    expect(meta.createSingleImageContainer).toHaveBeenCalledTimes(1);
    expect(meta.createCarouselContainer).not.toHaveBeenCalled();
    expect(meta.publishMedia).toHaveBeenCalledWith(expect.objectContaining({ creationId: "container_1" }));
  });
});

describe("runPublishPipeline — bridge trigger", () => {
  it("enqueues sync-campaign when publish succeeds and an enabled campaign exists for the post", async () => {
    const post = basePost({ status: "PUBLISHING", carousel_container_id: "c1" });
    repo.getPost.mockResolvedValue(post);
    repo.getCampaignByPostId.mockResolvedValue({ id: "campaign_1", enabled: true });
    meta.publishMedia.mockResolvedValue({ id: "media_1" });

    await runPublishPipeline("post_1", "/fake");

    expect(queueMock.enqueueSyncCampaign).toHaveBeenCalledWith({ campaignId: "campaign_1" });
  });

  it("does not enqueue sync-campaign when no campaign is staged for the post", async () => {
    const post = basePost({ status: "PUBLISHING", carousel_container_id: "c1" });
    repo.getPost.mockResolvedValue(post);
    repo.getCampaignByPostId.mockResolvedValue(null);
    meta.publishMedia.mockResolvedValue({ id: "media_1" });

    await runPublishPipeline("post_1", "/fake");

    expect(queueMock.enqueueSyncCampaign).not.toHaveBeenCalled();
  });

  it("does not enqueue sync-campaign when a campaign is staged but not enabled", async () => {
    const post = basePost({ status: "PUBLISHING", carousel_container_id: "c1" });
    repo.getPost.mockResolvedValue(post);
    repo.getCampaignByPostId.mockResolvedValue({ id: "campaign_1", enabled: false });
    meta.publishMedia.mockResolvedValue({ id: "media_1" });

    await runPublishPipeline("post_1", "/fake");

    expect(queueMock.enqueueSyncCampaign).not.toHaveBeenCalled();
  });
});

describe("runPublishPipeline — error classification", () => {
  it("sets status to FAILED on a NonRetryableError and does not rethrow", async () => {
    const post = basePost({ status: "PUBLISHING", carousel_container_id: "c1" });
    repo.getPost.mockResolvedValue(post);
    meta.publishMedia.mockRejectedValue(new NonRetryableError("container expired", "CONTAINER_EXPIRED"));

    await expect(runPublishPipeline("post_1", "/fake")).resolves.toBeUndefined();
    expect(repo.updatePostStatus).toHaveBeenCalledWith("post_1", expect.objectContaining({ status: "FAILED" }));
  });

  it("rethrows a RetryableError without marking the post FAILED", async () => {
    const post = basePost({ status: "PUBLISHING", carousel_container_id: "c1" });
    repo.getPost.mockResolvedValue(post);
    meta.publishMedia.mockRejectedValue(new RetryableError("rate limited"));

    await expect(runPublishPipeline("post_1", "/fake")).rejects.toBeInstanceOf(RetryableError);
    expect(repo.updatePostStatus).not.toHaveBeenCalledWith("post_1", expect.objectContaining({ status: "FAILED" }));
  });
});

describe("runPublishPipeline — resumability", () => {
  it("resuming at WAITING_FOR_CAROUSEL does not re-create the container", async () => {
    const post = basePost({ status: "WAITING_FOR_CAROUSEL", carousel_container_id: "existing_container" });
    repo.getPost.mockResolvedValue(post);
    meta.pollContainerUntilReady.mockResolvedValue(undefined);
    meta.publishMedia.mockResolvedValue({ id: "media_1" });

    await runPublishPipeline("post_1", "/fake");

    expect(meta.createCarouselContainer).not.toHaveBeenCalled();
    expect(meta.createSingleImageContainer).not.toHaveBeenCalled();
    expect(meta.pollContainerUntilReady).toHaveBeenCalledWith("existing_container", expect.anything());
    expect(meta.publishMedia).toHaveBeenCalledWith(expect.objectContaining({ creationId: "existing_container" }));
  });

  it("skips already-uploaded media (public_url set) during the UPLOADING step", async () => {
    // Stateful mock rows: sequence 1 starts already uploaded AND already has a
    // child container (simulating a resume after a crash mid-pipeline);
    // sequence 2 starts with neither, so only it should go through upload + child creation.
    const rows: PostMediaRow[] = [
      { id: "m1", sequence: 1, original_filename: "1.jpg", public_url: "https://already.uploaded/1.jpg", child_container_id: "child_existing" } as unknown as PostMediaRow,
      { id: "m2", sequence: 2, original_filename: "2.jpg", public_url: null, child_container_id: null } as unknown as PostMediaRow
    ];
    let currentStatus = "UPLOADING";
    let carouselContainerId: string | null = null;

    repo.getPost.mockImplementation(async () => basePost({ status: currentStatus as PostRow["status"], media_type: "CAROUSEL", carousel_container_id: carouselContainerId }));
    repo.listPostMedia.mockImplementation(async () => rows);
    repo.setPostMediaStorage.mockImplementation(async (id: string, _path: string, publicUrl: string) => {
      const row = rows.find((r) => r.id === id);
      if (row) row.public_url = publicUrl;
    });
    repo.setPostMediaContainer.mockImplementation(async (id: string, childContainerId: string) => {
      const row = rows.find((r) => r.id === id);
      if (row) row.child_container_id = childContainerId;
    });
    repo.updatePostStatus.mockImplementation(async (_id: string, update: { status: string; carouselContainerId?: string }) => {
      currentStatus = update.status;
      if (update.carouselContainerId) carouselContainerId = update.carouselContainerId;
      return true;
    });

    validatorMock.validatePost.mockResolvedValue({
      valid: true,
      issues: [],
      images: [
        { sequence: 1, originalFilename: "1.jpg", buffer: Buffer.from("a"), width: 10, height: 10 },
        { sequence: 2, originalFilename: "2.jpg", buffer: Buffer.from("b"), width: 10, height: 10 }
      ],
      caption: "hello"
    });
    storage.uploadPostMedia.mockResolvedValue({ storagePath: "POST_001/2-2.jpg", publicUrl: "https://example.com/2.jpg" });
    storage.preflightMediaUrl.mockResolvedValue(undefined);
    meta.createChildContainer.mockResolvedValue({ id: "child_2" });
    meta.pollContainerUntilReady.mockResolvedValue(undefined);
    meta.createCarouselContainer.mockResolvedValue({ id: "carousel_1" });
    meta.publishMedia.mockResolvedValue({ id: "media_1" });

    await runPublishPipeline("post_1", "/fake");

    // Only the un-uploaded image (sequence 2) should be uploaded, and only it should get a new child container.
    expect(storage.uploadPostMedia).toHaveBeenCalledTimes(1);
    expect(storage.uploadPostMedia).toHaveBeenCalledWith(expect.objectContaining({ sequence: 2 }));
    expect(meta.createChildContainer).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Publish safety: Meta cannot take a publish back, so the pipeline must never publish a second copy.
// ---------------------------------------------------------------------------------------------

const liveTimestamp = () => new Date(Date.now() + 5000).toISOString().replace("Z", "+0000");
const liveItem = (overrides: Record<string, unknown> = {}) => ({ id: "live_1", caption: "hello", timestamp: liveTimestamp(), ...overrides });
const publishing = () => basePost({ status: "PUBLISHING", carousel_container_id: "c1" });

describe("publish safety", () => {
  it("records the live post and does NOT publish again when Meta says the container is already published", async () => {
    repo.getPost.mockResolvedValue(publishing());
    meta.getContainerStatus.mockResolvedValue({ status: "PUBLISHED" });
    meta.listRecentMedia.mockResolvedValue([liveItem()]);

    await runPublishPipeline("post_1", "/fake");

    expect(meta.publishMedia).not.toHaveBeenCalled();
    expect(repo.updatePostStatus).toHaveBeenCalledWith("post_1", expect.objectContaining({ status: "PUBLISHED", instagramMediaId: "live_1" }), { from: ["PUBLISHING"] });
  });

  it("fails the post, without publishing, when the container is published but the media cannot be found", async () => {
    repo.getPost.mockResolvedValue(publishing());
    meta.getContainerStatus.mockResolvedValue({ status: "PUBLISHED" });
    meta.listRecentMedia.mockResolvedValue([]);

    await expect(runPublishPipeline("post_1", "/fake")).resolves.toBeUndefined();

    expect(meta.publishMedia).not.toHaveBeenCalled();
    expect(repo.updatePostStatus).toHaveBeenCalledWith("post_1", expect.objectContaining({ status: "FAILED" }));
  });

  it("does not publish a second copy when a post with the same caption is already live (Retry after a lost answer)", async () => {
    repo.getPost.mockResolvedValue(publishing());
    meta.listRecentMedia.mockResolvedValue([liveItem({ caption: "  hello  " })]);

    await runPublishPipeline("post_1", "/fake");

    expect(meta.publishMedia).not.toHaveBeenCalled();
    expect(repo.updatePostStatus).toHaveBeenCalledWith("post_1", expect.objectContaining({ status: "PUBLISHED", instagramMediaId: "live_1" }), { from: ["PUBLISHING"] });
  });

  it("publishes normally when the account has no matching post", async () => {
    repo.getPost.mockResolvedValue(publishing());
    meta.listRecentMedia.mockResolvedValue([liveItem({ caption: "something else" })]);
    meta.publishMedia.mockResolvedValue({ id: "new_1" });

    await runPublishPipeline("post_1", "/fake");

    expect(meta.publishMedia).toHaveBeenCalledTimes(1);
    expect(repo.updatePostStatus).toHaveBeenCalledWith("post_1", expect.objectContaining({ status: "PUBLISHED", instagramMediaId: "new_1" }), { from: ["PUBLISHING"] });
  });

  it("ignores media that is older than the post row", async () => {
    repo.getPost.mockResolvedValue(publishing());
    meta.listRecentMedia.mockResolvedValue([liveItem({ timestamp: "2020-01-01T00:00:00+0000" })]);
    meta.publishMedia.mockResolvedValue({ id: "new_1" });

    await runPublishPipeline("post_1", "/fake");

    expect(meta.publishMedia).toHaveBeenCalledTimes(1);
  });

  it("never claims media that is already recorded against another post", async () => {
    repo.getPost.mockResolvedValue(publishing());
    meta.listRecentMedia.mockResolvedValue([liveItem()]);
    repo.isInstagramMediaIdUsed.mockResolvedValue(true);
    meta.publishMedia.mockResolvedValue({ id: "new_1" });

    await runPublishPipeline("post_1", "/fake");

    expect(meta.publishMedia).toHaveBeenCalledTimes(1);
    expect(repo.updatePostStatus).toHaveBeenCalledWith("post_1", expect.objectContaining({ instagramMediaId: "new_1" }), { from: ["PUBLISHING"] });
  });

  it("treats a 4xx from publish as success when the post is in fact live", async () => {
    repo.getPost.mockResolvedValue(publishing());
    // first lookup (before publishing): nothing; second lookup (after the rejection): the post is there
    meta.listRecentMedia.mockResolvedValueOnce([]).mockResolvedValueOnce([liveItem()]);
    meta.publishMedia.mockRejectedValue(new NonRetryableError("already published", "ALREADY_PUBLISHED"));

    await runPublishPipeline("post_1", "/fake");

    expect(repo.updatePostStatus).toHaveBeenCalledWith("post_1", expect.objectContaining({ status: "PUBLISHED", instagramMediaId: "live_1" }), { from: ["PUBLISHING"] });
    expect(repo.updatePostStatus).not.toHaveBeenCalledWith("post_1", expect.objectContaining({ status: "FAILED" }));
  });

  it("still fails the post on a 4xx when nothing is live", async () => {
    repo.getPost.mockResolvedValue(publishing());
    meta.publishMedia.mockRejectedValue(new NonRetryableError("bad container", "BAD"));

    await runPublishPipeline("post_1", "/fake");

    expect(repo.updatePostStatus).toHaveBeenCalledWith("post_1", expect.objectContaining({ status: "FAILED" }));
  });

  it("does not publish if the container status lookup fails (never publish blind)", async () => {
    repo.getPost.mockResolvedValue(publishing());
    meta.getContainerStatus.mockRejectedValue(new RetryableError("network"));

    await expect(runPublishPipeline("post_1", "/fake")).rejects.toBeInstanceOf(RetryableError);

    expect(meta.publishMedia).not.toHaveBeenCalled();
  });

  it("stops quietly, without publishing, when another runner already moved the post on", async () => {
    repo.getPost.mockResolvedValue(basePost({ status: "WAITING_FOR_CAROUSEL", carousel_container_id: "c1" }));
    meta.pollContainerUntilReady.mockResolvedValue(undefined);
    repo.updatePostStatus.mockResolvedValue(false);

    await expect(runPublishPipeline("post_1", "/fake")).resolves.toBeUndefined();

    expect(meta.publishMedia).not.toHaveBeenCalled();
    expect(repo.updatePostStatus).not.toHaveBeenCalledWith("post_1", expect.objectContaining({ status: "FAILED" }));
  });

  it("does not run the follow-ups twice if another runner already recorded the publish", async () => {
    repo.getPost.mockResolvedValue(publishing());
    meta.publishMedia.mockResolvedValue({ id: "new_1" });
    repo.updatePostStatus.mockResolvedValue(false);
    repo.getCampaignByPostId.mockResolvedValue({ id: "campaign_1", enabled: true });

    await runPublishPipeline("post_1", "/fake");

    expect(queueMock.enqueueSyncCampaign).not.toHaveBeenCalled();
  });

  it("keeps the job successful when queuing the campaign sync fails after the post is live", async () => {
    repo.getPost.mockResolvedValue(publishing());
    meta.publishMedia.mockResolvedValue({ id: "new_1" });
    repo.getCampaignByPostId.mockResolvedValue({ id: "campaign_1", enabled: true });
    queueMock.enqueueSyncCampaign.mockRejectedValue(new Error("db blip"));

    await expect(runPublishPipeline("post_1", "/fake")).resolves.toBeUndefined();

    expect(repo.updatePostStatus).toHaveBeenCalledWith("post_1", expect.objectContaining({ status: "PUBLISHED" }), { from: ["PUBLISHING"] });
  });
});

describe("wrong-account guard", () => {
  it("publishes nothing and fails the post when the token belongs to a different account", async () => {
    repo.getPost.mockResolvedValue(basePost({ status: "CREATING_CHILDREN", media_type: "CAROUSEL" }));
    meta.resolveInstagramAccount.mockResolvedValue({ igUserId: "someone_else", username: "old_account" });

    await runPublishPipeline("post_1", "/fake");

    expect(meta.createChildContainer).not.toHaveBeenCalled();
    expect(meta.publishMedia).not.toHaveBeenCalled();
    expect(repo.updatePostStatus).toHaveBeenCalledWith("post_1", expect.objectContaining({ status: "FAILED", errorMessage: expect.stringContaining("@old_account") }));
  });

  it("checks the account only once per token, not once per step", async () => {
    repo.getPost.mockResolvedValue(publishing());
    meta.publishMedia.mockResolvedValue({ id: "new_1" });

    await runPublishPipeline("post_1", "/fake");
    await runPublishPipeline("post_1", "/fake");

    expect(meta.resolveInstagramAccount).toHaveBeenCalledTimes(1);
  });
});
