import { listIgAccounts, getTokenHealth } from "@jqp/publisher";
import { loadEnv } from "@jqp/core";
import { Settings as SettingsIcon, Link2, AlertTriangle } from "../../components/icons";
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
        <div>
          <span className="eyebrow">
            <SettingsIcon size={12} /> Configuration
          </span>
          <h1>Settings</h1>
        </div>
      </div>

      {params.connected ? <div className="card">Connected @{params.connected}.</div> : null}
      {params.oauth_error ? <div className="error-box">Connection failed: {params.oauth_error}</div> : null}

      {tokenHealth.expiring.length > 0 || tokenHealth.lastRefreshError ? (
        <div className="error-box">
          <strong>
            <AlertTriangle size={13} /> Instagram token needs attention
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
          <p className="muted u-text-sm">No account connected yet.</p>
        ) : (
          accounts.map((a) => (
            <div className="entity-card" key={a.id}>
              <div className="entity-main">
                <div className="entity-title">@{a.username ?? "—"}</div>
                <div className="entity-meta">
                  <span className="mono">{a.ig_user_id}</span>
                  <span>Token expires {a.token_expires_at ? new Date(a.token_expires_at).toLocaleString() : "—"}</span>
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
          Campaigns and DM activity are managed right here. Live conversation replies, content analytics, and queue
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
          <a href="/api/health">/api/health</a>
        </p>
      </div>
    </>
  );
}
