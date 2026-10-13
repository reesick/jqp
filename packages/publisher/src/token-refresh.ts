import { rootLogger } from "@jqp/core";
import { refreshLongLivedToken } from "@jqp/meta";
import { recordEvent } from "./events.js";
import { listAccountsWithTokens, updateIgAccountToken } from "./repository.js";

/**
 * Renews every stored Instagram token. Instagram long-lived tokens last about 60 days and can be refreshed once
 * they are at least a day old and before they expire; a token that already expired cannot be renewed and the
 * account has to be reconnected (npm run connect-account). Runs weekly from the worker, so a working account
 * never gets near the limit.
 *
 * Never throws for one bad account (the others still get refreshed), and never logs or stores a token in an
 * event: only the account's username and a reason.
 */
export async function refreshStoredTokens(): Promise<{ refreshed: number; failed: number }> {
  const log = rootLogger.child({ job: "refresh_tokens" });
  const accounts = await listAccountsWithTokens();
  let refreshed = 0;
  let failed = 0;

  for (const account of accounts) {
    const label = account.username ? `@${account.username}` : `account ${account.igUserId}`;
    try {
      const result = await refreshLongLivedToken(account.accessToken);
      const expiresIn = result.expires_in && result.expires_in > 0 ? result.expires_in : 60 * 24 * 3600;
      await updateIgAccountToken(account.igUserId, result.access_token, expiresIn);
      refreshed += 1;
      log.info("token_refreshed", { igUserId: account.igUserId, expiresInDays: Math.round(expiresIn / 86400) });
      void recordEvent({ level: "info", source: "auth", code: "token_refreshed", message: `Instagram token for ${label} renewed for ${Math.round(expiresIn / 86400)} days`, meta: { expiresInDays: Math.round(expiresIn / 86400) } });
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      log.error("token_refresh_failed", { igUserId: account.igUserId, error: message });
      void recordEvent({
        level: "error",
        source: "auth",
        code: "token_refresh_failed",
        message: `Could not renew the Instagram token for ${label}. If it has expired, reconnect it with npm run connect-account.`,
        meta: { reason: message.slice(0, 200) }
      });
    }
  }
  return { refreshed, failed };
}
