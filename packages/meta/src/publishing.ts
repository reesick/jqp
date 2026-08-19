import { NonRetryableError, RetryableError } from "@jqp/core";
import { graphRequest } from "./client.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --------------------------------------------------------------------
// Step 1/2 — child + single-image containers (plan sections 11-12, 69)
// --------------------------------------------------------------------

export interface CreateChildContainerParams {
  igUserId: string;
  imageUrl: string;
  accessToken: string;
}

/** Creates an item container for one image of a carousel (is_carousel_item=true, no caption — captions only go on the carousel/single container, plan section 12). */
export async function createChildContainer(params: CreateChildContainerParams): Promise<{ id: string }> {
  const { igUserId, imageUrl, accessToken } = params;
  return graphRequest(`/${igUserId}/media`, {
    method: "POST",
    accessToken,
    params: {
      image_url: imageUrl,
      is_carousel_item: true
    }
  });
}

export interface CreateSingleImageContainerParams {
  igUserId: string;
  imageUrl: string;
  caption: string;
  accessToken: string;
}

/** Phase 2 (plan section 69): a standalone single-image post — no carousel involved. */
export async function createSingleImageContainer(params: CreateSingleImageContainerParams): Promise<{ id: string }> {
  const { igUserId, imageUrl, caption, accessToken } = params;
  return graphRequest(`/${igUserId}/media`, {
    method: "POST",
    accessToken,
    params: { image_url: imageUrl, caption }
  });
}

// --------------------------------------------------------------------
// Step 3 — container status polling (plan section 13)
// --------------------------------------------------------------------

export type ContainerStatusCode = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";

export interface ContainerStatusResult {
  status: ContainerStatusCode;
  statusDetail?: string;
}

export async function getContainerStatus(containerId: string, accessToken: string): Promise<ContainerStatusResult> {
  const result = await graphRequest<{ status_code: ContainerStatusCode; status?: string }>(`/${containerId}`, {
    accessToken,
    params: { fields: "status_code,status" }
  });
  return { status: result.status_code, statusDetail: result.status };
}

export interface PollOptions {
  accessToken: string;
  intervalMs?: number;
  maxAttempts?: number;
}

/**
 * Polls a container until FINISHED/PUBLISHED, or throws.
 * ERROR/EXPIRED are non-retryable (the container is dead, a fresh one
 * must be created — plan section 13's state model). Exhausting
 * maxAttempts while still IN_PROGRESS throws RetryableError so the
 * job queue can back off and try the whole poll again later rather
 * than blocking a worker slot indefinitely.
 */
export async function pollContainerUntilReady(containerId: string, options: PollOptions): Promise<void> {
  const { accessToken, intervalMs = 2000, maxAttempts = 30 } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { status, statusDetail } = await getContainerStatus(containerId, accessToken);

    if (status === "FINISHED" || status === "PUBLISHED") return;

    if (status === "ERROR") {
      throw new NonRetryableError(`Container ${containerId} failed processing (status: ${statusDetail ?? "ERROR"})`, "CONTAINER_ERROR", { containerId });
    }
    if (status === "EXPIRED") {
      throw new NonRetryableError(`Container ${containerId} expired before it could be published`, "CONTAINER_EXPIRED", { containerId });
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  throw new RetryableError(`Container ${containerId} still IN_PROGRESS after ${maxAttempts} polls`, "CONTAINER_POLL_TIMEOUT", { containerId });
}

// --------------------------------------------------------------------
// Step 4 — carousel container (plan section 14)
// --------------------------------------------------------------------

export interface CreateCarouselContainerParams {
  igUserId: string;
  childContainerIds: string[]; // must already be in 1.jpg, 2.jpg, ... order
  caption: string;
  accessToken: string;
}

export async function createCarouselContainer(params: CreateCarouselContainerParams): Promise<{ id: string }> {
  const { igUserId, childContainerIds, caption, accessToken } = params;

  if (childContainerIds.length < 2 || childContainerIds.length > 10) {
    throw new NonRetryableError(`Carousel must have between 2 and 10 children, got ${childContainerIds.length}`, "INVALID_CAROUSEL_SIZE", {
      count: childContainerIds.length
    });
  }

  return graphRequest(`/${igUserId}/media`, {
    method: "POST",
    accessToken,
    params: {
      media_type: "CAROUSEL",
      children: childContainerIds.join(","),
      caption
    }
  });
}

// --------------------------------------------------------------------
// Step 5 — publish (plan section 15)
// --------------------------------------------------------------------

export interface PublishMediaParams {
  igUserId: string;
  creationId: string;
  accessToken: string;
}

export async function publishMedia(params: PublishMediaParams): Promise<{ id: string }> {
  const { igUserId, creationId, accessToken } = params;
  return graphRequest(`/${igUserId}/media_publish`, {
    method: "POST",
    accessToken,
    params: { creation_id: creationId }
  });
}

export async function getMediaPermalink(mediaId: string, accessToken: string): Promise<string | undefined> {
  const result = await graphRequest<{ permalink?: string }>(`/${mediaId}`, {
    accessToken,
    params: { fields: "permalink" }
  });
  return result.permalink;
}
