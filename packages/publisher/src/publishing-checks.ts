import type { ServiceStatus } from "./system.js";

export interface PublishingFacts {
  /** Posts that have sat in a working status (uploading, creating containers, publishing) for over 30 minutes. */
  stuckPosts: number;
  /** Campaigns whose last sync into OpenReply failed. */
  syncFailed: number;
  /** Enabled campaigns on published posts that are still not synced 15 minutes after publishing. */
  syncStuck: number;
  /** Stored Instagram tokens: when each expires (null if unknown). */
  tokens: { username: string | null; expiresAt: string | null }[];
}

const DAY_MS = 24 * 3600_000;

/** Turns raw counts into the status rows shown on the System page and used by the alert emails. */
export function publishingChecks(facts: PublishingFacts, now = Date.now()): ServiceStatus[] {
  const out: ServiceStatus[] = [];

  // Publishing token: the one thing that is certain to run out, so say so well before it does.
  if (facts.tokens.length === 0) {
    // Informational, not an alarm: publishing still works from the token in the worker's env file. It just
    // cannot be renewed automatically or have its expiry watched until it is stored.
    out.push({
      key: "publish-token",
      label: "Publishing token",
      state: "ok",
      detail: "Publishing uses the token in the worker's env file; its expiry is not tracked. Run npm run connect-account to store it so it renews weekly"
    });
  } else {
    const days = facts.tokens.map((t) => (t.expiresAt ? Math.floor((Date.parse(t.expiresAt) - now) / DAY_MS) : null));
    const known = days.filter((d): d is number => d !== null);
    const soonest = known.length ? Math.min(...known) : null;
    if (soonest === null) {
      out.push({ key: "publish-token", label: "Publishing token", state: "warn", detail: "Expiry date is unknown. The weekly refresh will record it; if this stays, run: npm run connect-account" });
    } else if (soonest <= 3) {
      out.push({
        key: "publish-token",
        label: "Publishing token",
        state: "down",
        detail: soonest < 0 ? "The publishing token has expired. Posting will fail. Run: npm run connect-account" : `The publishing token expires in ${soonest} day${soonest === 1 ? "" : "s"} and the weekly refresh has not renewed it`
      });
    } else if (soonest <= 14) {
      out.push({ key: "publish-token", label: "Publishing token", state: "warn", detail: `The publishing token expires in ${soonest} days; the weekly refresh should have renewed it` });
    } else {
      out.push({ key: "publish-token", label: "Publishing token", state: "ok", detail: `Valid for ${soonest} more days (renewed weekly)` });
    }
  }

  out.push({
    key: "stuck-posts",
    label: "Posts in progress",
    state: facts.stuckPosts > 0 ? "warn" : "ok",
    detail: facts.stuckPosts > 0 ? `${facts.stuckPosts} post${facts.stuckPosts === 1 ? " has" : "s have"} been mid-publish for over 30 minutes. The publish worker may be off` : "Nothing stuck"
  });

  const syncProblems = facts.syncFailed + facts.syncStuck;
  out.push({
    key: "campaign-sync",
    label: "Campaign sync",
    state: facts.syncFailed > 0 ? "down" : facts.syncStuck > 0 ? "warn" : "ok",
    detail:
      syncProblems === 0
        ? "Campaigns are in sync with OpenReply"
        : [
            facts.syncFailed > 0 ? `${facts.syncFailed} campaign${facts.syncFailed === 1 ? "" : "s"} failed to sync` : null,
            facts.syncStuck > 0 ? `${facts.syncStuck} enabled campaign${facts.syncStuck === 1 ? " is" : "s are"} still waiting to sync (the local publish worker must be running)` : null
          ]
            .filter(Boolean)
            .join("; ")
  });

  return out;
}
