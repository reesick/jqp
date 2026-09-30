import { listIgAccounts, getTokenHealth } from "@jqp/publisher";
import { loadEnv } from "@jqp/core";
import { Link2, AlertTriangle, CheckCircle2 } from "../../components/icons";
import { InstagramGlyph } from "../../components/instagram-glyph";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ connected?: string; oauth_error?: string }> }) {
  const params = await searchParams;
  const [accounts, tokenHealth] = await Promise.all([listIgAccounts(), getTokenHealth()]);
  const env = loadEnv();

  return (
    <>
      <div className="page-header">
        <h1>Settings</h1>
      </div>

      {params.connected ? (
        <p className="home-status" role="status">
          <CheckCircle2 size={14} /> Connected @{params.connected}
        </p>
      ) : null}
      {params.oauth_error ? (
        <div className="error-box" role="alert">
          Couldn&rsquo;t connect Instagram: {params.oauth_error}. Try Connect Instagram again; if it keeps failing, check
          the Meta app&rsquo;s redirect URI and tester roles.
        </div>
      ) : null}

      {tokenHealth.expiring.length > 0 || tokenHealth.lastRefreshError ? (
        <div className="error-box" role="alert">
          <strong>
            <AlertTriangle size={13} aria-hidden="true" /> Instagram token needs attention
          </strong>
          {tokenHealth.expiring.map((a) => (
            <div key={a.instagramId}>
              @{a.username} —{" "}
              {a.daysLeft === null
                ? "expiry unknown"
                : a.daysLeft < 0
                  ? `expired ${Math.abs(a.daysLeft)} day(s) ago`
                  : `expires in ${a.daysLeft} day(s)`}
            </div>
          ))}
          {tokenHealth.lastRefreshError ? (
            <div>
              Last auto-refresh failed ({new Date(tokenHealth.lastRefreshError.createdAt).toLocaleString()}):{" "}
              {tokenHealth.lastRefreshError.message}
            </div>
          ) : null}
          <div className="u-mt-xs">Reconnect the account below to issue a fresh token.</div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-title">Instagram accounts</div>
        {accounts.length === 0 ? (
          <p className="muted u-text-sm">No account connected yet. Connect one to publish and to run DM automations.</p>
        ) : (
          accounts.map((a) => (
            <div className="entity-card" key={a.id}>
              <div className="entity-main">
                <div className="entity-title">@{a.username ?? "—"}</div>
                <div className="entity-meta">
                  <span className="mono">{a.ig_user_id}</span>
                  <span>
                    Token expires{" "}
                    <span className="mono">{a.token_expires_at ? new Date(a.token_expires_at).toLocaleString() : "unknown"}</span>
                  </span>
                </div>
              </div>
              <span className={`badge ${a.is_active ? "ok" : "err"}`}>
                <span className="badge-dot" />
                {a.is_active ? "Active" : "Inactive"}
              </span>
            </div>
          ))
        )}
        <a href="/api/meta/oauth/start">
          <button className="u-mt-sm">
            <InstagramGlyph size={14} />
            Connect Instagram
          </button>
        </a>
      </div>

      <div className="card">
        <div className="card-title">OpenReply (DM engine)</div>
        <p className="muted u-text-sm">
          Automations and activity are managed right here. Live conversation replies, content analytics, and queue
          diagnostics are still handled in OpenReply's own dashboard.
        </p>
        <a href={env.OPENREPLY_DASHBOARD_URL} target="_blank" rel="noreferrer">
          <button className="secondary u-mt-xs">
            <Link2 size={14} />
            Open OpenReply dashboard &rarr;
          </button>
        </a>
      </div>

      <div className="card">
        <div className="card-title">API status</div>
        <p>
          <a href="/api/health" className="mono">
            /api/health
          </a>
        </p>
      </div>
    </>
  );
}
