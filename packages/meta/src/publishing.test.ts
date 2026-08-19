import { beforeEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError, RetryableError } from "@jqp/core";

const graphRequestMock = vi.fn();
vi.mock("./client.js", () => ({
  graphRequest: (...args: unknown[]) => graphRequestMock(...args)
}));

const { pollContainerUntilReady, createCarouselContainer } = await import("./publishing.js");

beforeEach(() => {
  graphRequestMock.mockReset();
});

describe("pollContainerUntilReady", () => {
  it("resolves immediately when status is FINISHED", async () => {
    graphRequestMock.mockResolvedValueOnce({ status_code: "FINISHED" });
    await expect(pollContainerUntilReady("c1", { accessToken: "t", intervalMs: 1 })).resolves.toBeUndefined();
    expect(graphRequestMock).toHaveBeenCalledTimes(1);
  });

  it("polls through IN_PROGRESS then resolves on FINISHED", async () => {
    graphRequestMock
      .mockResolvedValueOnce({ status_code: "IN_PROGRESS" })
      .mockResolvedValueOnce({ status_code: "IN_PROGRESS" })
      .mockResolvedValueOnce({ status_code: "FINISHED" });

    await pollContainerUntilReady("c1", { accessToken: "t", intervalMs: 1 });
    expect(graphRequestMock).toHaveBeenCalledTimes(3);
  });

  it("throws NonRetryableError on ERROR status", async () => {
    graphRequestMock.mockResolvedValueOnce({ status_code: "ERROR", status: "media processing failed" });
    await expect(pollContainerUntilReady("c1", { accessToken: "t", intervalMs: 1 })).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("throws NonRetryableError on EXPIRED status", async () => {
    graphRequestMock.mockResolvedValueOnce({ status_code: "EXPIRED" });
    await expect(pollContainerUntilReady("c1", { accessToken: "t", intervalMs: 1 })).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("throws RetryableError after exhausting maxAttempts still IN_PROGRESS", async () => {
    graphRequestMock.mockResolvedValue({ status_code: "IN_PROGRESS" });
    await expect(pollContainerUntilReady("c1", { accessToken: "t", intervalMs: 1, maxAttempts: 3 })).rejects.toBeInstanceOf(RetryableError);
    expect(graphRequestMock).toHaveBeenCalledTimes(3);
  });
});

describe("createCarouselContainer", () => {
  it("rejects fewer than 2 children", async () => {
    await expect(
      createCarouselContainer({ igUserId: "u1", childContainerIds: ["only-one"], caption: "hi", accessToken: "t" })
    ).rejects.toBeInstanceOf(NonRetryableError);
    expect(graphRequestMock).not.toHaveBeenCalled();
  });

  it("rejects more than 10 children", async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `child_${i}`);
    await expect(createCarouselContainer({ igUserId: "u1", childContainerIds: eleven, caption: "hi", accessToken: "t" })).rejects.toBeInstanceOf(
      NonRetryableError
    );
    expect(graphRequestMock).not.toHaveBeenCalled();
  });

  it("preserves child order in the children param", async () => {
    graphRequestMock.mockResolvedValueOnce({ id: "carousel_1" });
    await createCarouselContainer({ igUserId: "u1", childContainerIds: ["c1", "c2", "c3"], caption: "hi", accessToken: "t" });
    const [, options] = graphRequestMock.mock.calls[0] as [string, { params: { children: string } }];
    expect(options.params.children).toBe("c1,c2,c3");
  });
});
