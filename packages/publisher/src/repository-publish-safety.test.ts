import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PostRow } from "@jqp/core";

interface SqlCall {
  text: string;
  values: unknown[];
}
const calls: SqlCall[] = [];
let nextRows: unknown[][] = [];

// A tagged-template stand-in for postgres.js. Nested fragments (sql`...` inside sql`...`) come back as
// their own call; the outer text is what the assertions read.
function mockSql(strings: TemplateStringsArray, ...values: unknown[]) {
  const text = strings.join("?");
  // A fragment (the optional "and status ..." clause) is not a query: it must not use up a queued result.
  if (text === "" || text.startsWith("and ")) {
    calls.push({ text, values });
    return Promise.resolve([]);
  }
  calls.push({ text, values });
  return Promise.resolve(nextRows.shift() ?? []);
}

// postgres.js transactions: run the callback with the same tagged-template function.
(mockSql as unknown as { begin: (fn: (tx: typeof mockSql) => unknown) => unknown }).begin = async (fn) => fn(mockSql);

vi.mock("@jqp/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jqp/core")>();
  return {
    ...actual,
    getDb: () => mockSql,
    loadEnv: () => ({ META_IG_USER_ID: "ig_default", META_LONG_LIVED_ACCESS_TOKEN: "env_token" }),
    decryptSecret: ({ ciphertext }: { ciphertext: string }) => (ciphertext === "bad" ? (() => { throw new Error("bad key"); })() : `decrypted:${ciphertext}`)
  };
});

const { updatePostStatus, resetPostForRetry, resolveAccountForPost, isInstagramMediaIdUsed } = await import("./repository.js");

const post = { id: "post_1", campaign_id: "POST_001", ig_account_id: null } as unknown as PostRow;

beforeEach(() => {
  calls.length = 0;
  nextRows = [];
});

describe("updatePostStatus compare-and-set", () => {
  it("reports whether the change happened, and compares the current status as text", async () => {
    nextRows = [[{ id: "post_1" }]];
    expect(await updatePostStatus("post_1", { status: "PUBLISHING" }, { from: ["WAITING_FOR_CAROUSEL"] })).toBe(true);
    expect(calls.some((c) => c.text.includes("status::text = any"))).toBe(true);
    expect(calls.find((c) => c.text.includes("status::text = any"))!.values).toEqual([["WAITING_FOR_CAROUSEL"]]);

    calls.length = 0;
    nextRows = [[]];
    expect(await updatePostStatus("post_1", { status: "PUBLISHING" }, { from: ["WAITING_FOR_CAROUSEL"] })).toBe(false);
  });

  it("still works without a condition", async () => {
    nextRows = [[{ id: "post_1" }]];
    expect(await updatePostStatus("post_1", { status: "UPLOADING" })).toBe(true);
  });
});

describe("resetPostForRetry", () => {
  it("clears the old containers and only touches posts that are failed and not live", async () => {
    nextRows = [[{ id: "post_1" }], []];
    expect(await resetPostForRetry("post_1")).toBe(true);

    const reset = calls[0]!;
    expect(reset.text).toContain("instagram_media_id is null");
    expect(reset.text).toContain("carousel_container_id = null");
    expect(calls[1]!.text).toContain("update post_media set child_container_id = null");
  });

  it("will not reset a post whose failure says Instagram may already show it, unless the caller confirms", async () => {
    nextRows = [[]];
    expect(await resetPostForRetry("post_1")).toBe(false);
    const call = calls[0]!;
    expect(call.text).toContain("not like");
    expect(call.values).toContain("LIVE_CHECK_REQUIRED:%");
    expect(call.values).toContain(false); // confirmNotLive not given

    calls.length = 0;
    nextRows = [[{ id: "post_1" }], []];
    expect(await resetPostForRetry("post_1", { confirmNotLive: true })).toBe(true);
    expect(calls[0]!.values).toContain(true);
  });

  it("does nothing, and clears no containers, for a post that is not in a failed state or is already live", async () => {
    nextRows = [[]];
    expect(await resetPostForRetry("post_1")).toBe(false);
    expect(calls.some((c) => c.text.includes("post_media"))).toBe(false);
  });
});

describe("isInstagramMediaIdUsed", () => {
  it("is true when a post already carries the media id", async () => {
    nextRows = [[{ id: "other" }]];
    expect(await isInstagramMediaIdUsed("m1")).toBe(true);
    nextRows = [[]];
    expect(await isInstagramMediaIdUsed("m2")).toBe(false);
  });
});

describe("resolveAccountForPost default account", () => {
  it("prefers the stored (refreshed) token of the default account over the env token", async () => {
    nextRows = [[{ ig_user_id: "ig_default", access_token_encrypted: "stored", access_token_iv: "iv", access_token_tag: "tag", is_active: true }]];
    expect(await resolveAccountForPost(post)).toEqual({ igUserId: "ig_default", accessToken: "decrypted:stored", envFallbackToken: "env_token" });
  });

  it("falls back to the env token when nothing is stored", async () => {
    nextRows = [[]];
    expect(await resolveAccountForPost(post)).toEqual({ igUserId: "ig_default", accessToken: "env_token" });
  });

  it("falls back to the env token when the stored one cannot be decrypted", async () => {
    nextRows = [[{ ig_user_id: "ig_default", access_token_encrypted: "bad", access_token_iv: "iv", access_token_tag: "tag", is_active: true }]];
    expect(await resolveAccountForPost(post)).toEqual({ igUserId: "ig_default", accessToken: "env_token" });
  });
});
