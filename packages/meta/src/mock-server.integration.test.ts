import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { __resetEnvCacheForTests } from "@jqp/core";
import { createMockMetaServer, type MockMetaServer } from "./testing/mock-server.js";

/**
 * Drives the REAL packages/meta client functions (not mocks of them)
 * against the fake Meta server in ./testing/mock-server.ts. This is
 * the strongest local verification available without live Instagram
 * credentials — it proves the request shapes, param encoding, and
 * response parsing this package sends/expects actually round-trip
 * correctly, end to end, for every Meta call the publish pipeline and
 * OAuth flow make.
 */

let mock: MockMetaServer;
const ACCESS_TOKEN = "mock-token";
const IG_USER_ID = "mock-ig-user";

beforeAll(async () => {
  mock = createMockMetaServer();
  await new Promise<void>((resolve) => mock.server.listen(0, resolve));

  process.env.MOCK_META = "true";
  process.env.MOCK_META_PORT = String(mock.port());
  process.env.APP_BASE_URL ??= "http://localhost:3000";
  process.env.DASHBOARD_SHARED_SECRET ??= "test-secret";
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-key";
  process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/postgres";
  process.env.META_APP_ID ??= "123";
  process.env.META_APP_SECRET ??= "secret";
  process.env.META_GRAPH_VERSION ??= "v25.0";
  process.env.META_API_BASE ??= "https://graph.instagram.com";
  process.env.META_IG_USER_ID ??= IG_USER_ID;
  process.env.META_OAUTH_REDIRECT_URI ??= "http://localhost:3000/api/meta/oauth/callback";
  process.env.META_WEBHOOK_VERIFY_TOKEN ??= "verify-me";
  process.env.ENCRYPTION_KEY ??= "a".repeat(64);
  process.env.BRIDGE_SHARED_SECRET ??= "bridge-secret";
  __resetEnvCacheForTests();
});

afterAll(async () => {
  await new Promise<void>((resolve) => mock.server.close(() => resolve()));
});

beforeEach(() => {
  mock.reset();
});

describe("full publish flow against mock Meta", () => {
  it("carousel: children -> poll -> carousel -> poll -> publish -> permalink", async () => {
    const { createChildContainer, pollContainerUntilReady, createCarouselContainer, publishMedia, getMediaPermalink } = await import("./publishing.js");

    const c1 = await createChildContainer({ igUserId: IG_USER_ID, imageUrl: "https://example.com/1.jpg", accessToken: ACCESS_TOKEN });
    const c2 = await createChildContainer({ igUserId: IG_USER_ID, imageUrl: "https://example.com/2.jpg", accessToken: ACCESS_TOKEN });

    await pollContainerUntilReady(c1.id, { accessToken: ACCESS_TOKEN, intervalMs: 5 });
    await pollContainerUntilReady(c2.id, { accessToken: ACCESS_TOKEN, intervalMs: 5 });

    const carousel = await createCarouselContainer({ igUserId: IG_USER_ID, childContainerIds: [c1.id, c2.id], caption: "hello", accessToken: ACCESS_TOKEN });
    await pollContainerUntilReady(carousel.id, { accessToken: ACCESS_TOKEN, intervalMs: 5 });

    const published = await publishMedia({ igUserId: IG_USER_ID, creationId: carousel.id, accessToken: ACCESS_TOKEN });
    expect(published.id).toBeTruthy();

    const permalink = await getMediaPermalink(published.id, ACCESS_TOKEN);
    expect(permalink).toContain(published.id);
  });

  it("single image: container -> poll -> publish", async () => {
    const { createSingleImageContainer, pollContainerUntilReady, publishMedia } = await import("./publishing.js");

    const container = await createSingleImageContainer({ igUserId: IG_USER_ID, imageUrl: "https://example.com/1.jpg", caption: "hi", accessToken: ACCESS_TOKEN });
    await pollContainerUntilReady(container.id, { accessToken: ACCESS_TOKEN, intervalMs: 5 });
    const published = await publishMedia({ igUserId: IG_USER_ID, creationId: container.id, accessToken: ACCESS_TOKEN });
    expect(published.id).toBeTruthy();
  });

  it("messaging: private reply and public reply both succeed", async () => {
    const { sendPrivateReply, replyToComment } = await import("./messaging.js");

    const dm = await sendPrivateReply({ igUserId: IG_USER_ID, commentId: "comment_1", message: "hey!", accessToken: ACCESS_TOKEN });
    expect(dm.message_id).toBeTruthy();

    const reply = await replyToComment({ commentId: "comment_1", message: "thanks!", accessToken: ACCESS_TOKEN });
    expect(reply.id).toBeTruthy();
  });

  it("oauth: full Instagram Login token exchange chain", async () => {
    const { exchangeCodeForToken, exchangeForLongLivedToken, refreshLongLivedToken, resolveInstagramAccount } = await import("./oauth.js");

    const short = await exchangeCodeForToken("fake-code");
    expect(short.access_token).toBeTruthy();
    expect(short.user_id).toBeTruthy();

    const long = await exchangeForLongLivedToken(short.access_token);
    expect(long.access_token).toBeTruthy();
    expect(long.expires_in).toBeGreaterThan(0);

    const refreshed = await refreshLongLivedToken(long.access_token);
    expect(refreshed.access_token).toBeTruthy();

    const profile = await resolveInstagramAccount(long.access_token);
    expect(profile.igUserId).toBeTruthy();
  });

  it("publishMedia fails clearly for an unknown creation_id", async () => {
    const { publishMedia } = await import("./publishing.js");
    await expect(publishMedia({ igUserId: IG_USER_ID, creationId: "does-not-exist", accessToken: ACCESS_TOKEN })).rejects.toThrow();
  });
});
