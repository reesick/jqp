import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetEnvCacheForTests, NonRetryableError, RetryableError } from "@jqp/core";

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  ConverseCommand: vi.fn().mockImplementation((input: unknown) => ({ input }))
}));

const { generateCaption } = await import("./generate-caption.js");

function setEnv(overrides: Record<string, string>) {
  process.env.APP_BASE_URL ??= "http://localhost:3000";
  process.env.DASHBOARD_SHARED_SECRET ??= "test-secret";
  process.env.SUPABASE_URL ??= "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-key";
  process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/postgres";
  process.env.META_APP_ID ??= "123";
  process.env.META_APP_SECRET ??= "secret";
  process.env.META_GRAPH_VERSION ??= "v25.0";
  process.env.META_API_BASE ??= "https://graph.instagram.com";
  process.env.META_IG_USER_ID ??= "999";
  process.env.META_OAUTH_REDIRECT_URI ??= "http://localhost:3000/api/meta/oauth/callback";
  process.env.META_WEBHOOK_VERIFY_TOKEN ??= "verify-me";
  process.env.ENCRYPTION_KEY ??= "a".repeat(64);
  process.env.BRIDGE_SHARED_SECRET ??= "bridge-secret";
  Object.assign(process.env, overrides);
  __resetEnvCacheForTests();
}

beforeEach(() => {
  sendMock.mockReset();
});

describe("generateCaption — AI_ENABLED=false (default)", () => {
  beforeAll(() => {
    setEnv({ AI_ENABLED: "false" });
  });

  it("throws NonRetryableError without calling Bedrock", async () => {
    await expect(generateCaption({ brief: "a cozy coffee shop" })).rejects.toBeInstanceOf(NonRetryableError);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("generateCaption — AI_ENABLED=true", () => {
  beforeEach(() => {
    setEnv({ AI_ENABLED: "true", AWS_REGION: "us-east-1", BEDROCK_MODEL_ID: "mock.model-v1" });
  });

  it("returns the trimmed text from a successful Converse response", async () => {
    sendMock.mockResolvedValueOnce({ output: { message: { content: [{ text: "  A cozy caption. #coffee #cafe #morning  " }] } } });
    const caption = await generateCaption({ brief: "a cozy coffee shop" });
    expect(caption).toBe("A cozy caption. #coffee #cafe #morning");
  });

  it("throws RetryableError when Bedrock returns no text", async () => {
    sendMock.mockResolvedValueOnce({ output: { message: { content: [] } } });
    await expect(generateCaption({ brief: "x" })).rejects.toBeInstanceOf(RetryableError);
  });

  it("wraps a thrown SDK error as RetryableError", async () => {
    sendMock.mockRejectedValueOnce(new Error("ThrottlingException"));
    await expect(generateCaption({ brief: "x" })).rejects.toBeInstanceOf(RetryableError);
  });
});
