import Link from "next/link";
import { getSystemSnapshot, type ServiceState } from "@jqp/publisher";
import { AlertTriangle, CheckCircle2, XCircle } from "../../components/icons";

export const dynamic = "force-dynamic";
export const metadata = { title: "System" };

const TZ = "Asia/Kolkata";
const timeFmt = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ });

function when(iso: string | null): string {
  return iso ? timeFmt.format(new Date(iso)) : "never";
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

const STATE: Record<ServiceState, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  ok: { label: "Healthy", cls: "ok", Icon: CheckCircle2 },
  warn: { label: "Warning", cls: "warn", Icon: AlertTriangle },
  down: { label: "Down", cls: "err", Icon: XCircle }
};

export default async function SystemPage() {
  const snap = await getSystemSnapshot();
  const problems = snap.services.filter((s) => s.state !== "ok");
  const { dm } = snap;
  const attempts = dm.last24h.sent + dm.last24h.failed;
  const maxDay = Math.max(1, ...dm.byDay.map((d) => d.sent + d.failed));

  return (
    <>
      <div className="page-header">
        <div>
          <h1>System</h1>
          <div className="muted u-mt-xxs">Checked {when(snap.generatedAt)} IST</div>
        </div>
      </div>

      {problems.length === 0 ? (
        <p className="home-status">
          <CheckCircle2 size={14} /> All {snap.services.length} checks passing
        </p>
      ) : (
        <p className="home-status warn">
          <AlertTriangle size={14} /> {problems.length} of {snap.services.length} {problems.length === 1 ? "check needs" : "checks need"} attention
        </p>
      )}

      <section className="home-section">
        <h3 className="section-label">Services</h3>
        {snap.services.map((s) => {
          const { label, cls, Icon } = STATE[s.state];
          return (
            <div className="entity-card" key={s.key}>
              <div className="entity-main">
                <div className="entity-title">{s.label}</div>
                <div className="entity-meta">
                  <span>{s.detail}</span>
                </div>
              </div>
              <span className={`badge ${cls}`}>
                <Icon size={13} />
                {label}
              </span>
            </div>
          );
        })}
      </section>

      <section className="home-section">
        <h3 className="section-label">DMs, last 24 hours</h3>
        <div className="stat-grid">
          <div className="stat-tile">
            <div className="stat-label">Sent</div>
            <div className="stat-value">{dm.last24h.sent}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Failed</div>
            <div className={`stat-value${dm.last24h.failed > 0 ? " danger" : ""}`}>{dm.last24h.failed}</div>
            <div className="stat-sub">{dm.failureRate24h === null ? (attempts === 0 ? "none attempted" : "too few to rate") : `${Math.round(dm.failureRate24h * 100)}% of attempts`}</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">Skipped</div>
            <div className="stat-value">{dm.last24h.skipped}</div>
            <div className="stat-sub">duplicates, limits</div>
          </div>
          <div className="stat-tile">
            <div className="stat-label">This hour</div>
            <div className="stat-value">{dm.lastHourSent}</div>
            <div className="stat-sub">of {dm.hourlyLimit} allowed</div>
          </div>
        </div>

        {dm.topFailures.length > 0 ? (
          <div className="card">
            <div className="card-title">Why DMs failed</div>
            {dm.topFailures.map((f) => (
              <div className="entity-meta u-mb-xxs" key={f.reason}>
                <span className="mono">{f.count}×</span>
                <span>{f.reason}</span>
              </div>
            ))}
          </div>
        ) : null}

        {dm.byDay.length > 0 ? (
          <div className="card">
            <div className="card-title">Last 7 days</div>
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Sent</th>
                  <th>Failed</th>
                  <th aria-label="Volume" />
                </tr>
              </thead>
              <tbody>
                {dm.byDay.map((d) => (
                  <tr key={d.day}>
                    <td className="mono">{d.day}</td>
                    <td className="mono">{d.sent}</td>
                    <td className="mono">{d.failed}</td>
                    <td>
                      <div className="volume-bar" role="img" aria-label={`${d.sent + d.failed} attempts`}>
                        <span style={{ width: `${((d.sent + d.failed) / maxDay) * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="home-section">
        <h3 className="section-label">Recent problems</h3>
        {snap.failedPosts > 0 ? (
          <div className="entity-card">
            <div className="entity-main">
              <div className="entity-title">
                {snap.failedPosts} failed {snap.failedPosts === 1 ? "post" : "posts"}
              </div>
              <div className="entity-meta">
                <span>Publishing stopped and needs a retry</span>
              </div>
            </div>
            <Link href="/posts">Review</Link>
          </div>
        ) : null}
        {snap.events.length === 0 && snap.openReplyErrors.length === 0 && snap.failedPosts === 0 ? (
          <p className="muted">
            <CheckCircle2 size={13} /> No issues recorded in the last 7 days.
          </p>
        ) : null}
        {snap.events.map((e) => (
          <div className="entity-card" key={`e${e.id}`}>
            <div className="entity-main">
              <div className="entity-title">{e.message}</div>
              <div className="entity-meta">
                <span className="mono">{when(e.created_at)}</span>
                <span className="mono">{e.code}</span>
                {e.correlation_id ? <span className="mono">{e.correlation_id}</span> : null}
              </div>
            </div>
            <span className={`badge ${e.level === "error" ? "err" : "warn"}`}>
              {e.level === "error" ? <XCircle size={13} /> : <AlertTriangle size={13} />}
              {e.level === "error" ? "Error" : "Warning"}
            </span>
          </div>
        ))}
        {snap.openReplyErrors.map((e) => (
          <div className="entity-card" key={`o${e.id}`}>
            <div className="entity-main">
              <div className="entity-title">{e.message}</div>
              <div className="entity-meta">
                <span className="mono">{when(e.createdAt)}</span>
                <span className="mono">openreply · {e.source.toLowerCase()}</span>
              </div>
            </div>
            <span className={`badge ${e.level === "ERROR" ? "err" : "warn"}`}>
              {e.level === "ERROR" ? <XCircle size={13} /> : <AlertTriangle size={13} />}
              {e.level === "ERROR" ? "Error" : "Warning"}
            </span>
          </div>
        ))}
      </section>

      <section className="home-section">
        <h3 className="section-label">Inbound</h3>
        <div className="entity-card">
          <div className="entity-main">
            <div className="entity-title">Last webhook from Meta</div>
            <div className="entity-meta">
              <span className="mono">{when(snap.lastWebhookAt)}</span>
              <span>{snap.lastWebhookAt ? ago(snap.lastWebhookAt) : "No comments have reached OpenReply yet"}</span>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
