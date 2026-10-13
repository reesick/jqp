import { beforeEach, describe, expect, it, vi } from "vitest";

const repo = { listAccountsWithTokens: vi.fn(), updateIgAccountToken: vi.fn() };
vi.mock("./repository.js", () => repo);

const meta = { refreshLongLivedToken: vi.fn() };
vi.mock("@jqp/meta", () => meta);

const events = { recordEvent: vi.fn() };
vi.mock("./events.js", () => events);

const { refreshStoredTokens } = await import("./token-refresh.js");

const account = (n: number) => ({ igUserId: `ig_${n}`, username: `acct${n}`, accessToken: `old_token_${n}`, tokenExpiresAt: null });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("refreshStoredTokens", () => {
  it("stores the new token and expiry for each account", async () => {
    repo.listAccountsWithTokens.mockResolvedValue([account(1)]);
    meta.refreshLongLivedToken.mockResolvedValue({ access_token: "new_token", expires_in: 5184000 });

    const result = await refreshStoredTokens();

    expect(result).toEqual({ refreshed: 1, failed: 0 });
    expect(meta.refreshLongLivedToken).toHaveBeenCalledWith("old_token_1");
    expect(repo.updateIgAccountToken).toHaveBeenCalledWith("ig_1", "new_token", 5184000);
  });

  it("assumes 60 days when Meta does not say", async () => {
    repo.listAccountsWithTokens.mockResolvedValue([account(1)]);
    meta.refreshLongLivedToken.mockResolvedValue({ access_token: "new_token" });

    await refreshStoredTokens();

    expect(repo.updateIgAccountToken).toHaveBeenCalledWith("ig_1", "new_token", 60 * 24 * 3600);
  });

  it("keeps going after one account fails, and reports the failure without leaking a token", async () => {
    repo.listAccountsWithTokens.mockResolvedValue([account(1), account(2)]);
    meta.refreshLongLivedToken.mockRejectedValueOnce(new Error("Failed to refresh long-lived token: expired")).mockResolvedValueOnce({ access_token: "new_2", expires_in: 100 });

    const result = await refreshStoredTokens();

    expect(result).toEqual({ refreshed: 1, failed: 1 });
    expect(repo.updateIgAccountToken).toHaveBeenCalledTimes(1);
    const failure = events.recordEvent.mock.calls.map((c) => c[0]).find((e) => e.code === "token_refresh_failed");
    expect(failure.level).toBe("error");
    const everything = JSON.stringify(events.recordEvent.mock.calls);
    expect(everything).not.toContain("old_token_");
    expect(everything).not.toContain("new_token");
  });

  it("does nothing when no account has a stored token", async () => {
    repo.listAccountsWithTokens.mockResolvedValue([]);
    expect(await refreshStoredTokens()).toEqual({ refreshed: 0, failed: 0 });
    expect(meta.refreshLongLivedToken).not.toHaveBeenCalled();
  });
});
