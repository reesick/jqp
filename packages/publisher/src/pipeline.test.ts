import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostRow, PostMediaRow } from "@jqp/core";

const repo = {
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
  publishMedia: vi.fn()
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

const { runPublishPipeline } = await import("./pipeline.js");
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
