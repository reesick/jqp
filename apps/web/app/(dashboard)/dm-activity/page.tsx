import Link from "next/link";
import { getDmLogs } from "@jqp/publisher";
import { StatusBadge } from "../../components/status-badge";
import { EmptyState } from "../../components/empty-state";
import { Send, Inbox } from "../../components/icons";

export const dynamic = "force-dynamic";
export const metadata = { title: "DM Activity" };

const PAGE_SIZE = 20;
const STATUS_FILTERS = ["SENT", "FAILED", "PENDING"];

export default async function DmActivityPage({
  searchParams
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const params = await searchParams;
  const status = params.status && STATUS_FILTERS.includes(params.status) ? params.status : undefined;
  const page = Math.max(1, Number(params.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const { rows, total } = await getDmLogs({ status, limit: PAGE_SIZE, offset });
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const filterHref = (s?: string) => (s ? `/dm-activity?status=${s}` : "/dm-activity");
  const pageHref = (p: number) => `/dm-activity?${status ? `status=${status}&` : ""}page=${p}`;

  return (
    <>
      <div className="page-header">
        <div>
          <span className="eyebrow">
            <Send size={12} /> DM automation
          </span>
          <h1>DM Activity</h1>
        </div>
      </div>

      <div className="filter-row u-mb-md">
        <Link href={filterHref()} className={status ? "muted" : undefined}>
          All
        </Link>
        {STATUS_FILTERS.map((s) => (
          <Link key={s} href={filterHref(s)} className={status === s ? undefined : "muted"}>
            {s.charAt(0) + s.slice(1).toLowerCase()}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={<Inbox size={28} />} title="No DM activity yet. Comments matching a live campaign will show up here." />
      ) : (
        rows.map((dm) => (
          <div className="entity-card" key={dm.id}>
            <div className="entity-main">
              <div className="entity-title">{dm.commenterName ?? "someone"}</div>
              <div className="entity-meta">
                <span className="mono">{dm.commentText}</span>
                {dm.matchedKeyword ? <span>matched "{dm.matchedKeyword}"</span> : null}
                <span>{new Date(dm.dmSentAt ?? dm.createdAt).toLocaleString()}</span>
              </div>
            </div>
            <StatusBadge status={dm.status} />
          </div>
        ))
      )}

      {totalPages > 1 ? (
        <div className="entity-meta u-mt-sm u-justify-center">
          {page > 1 ? <Link href={pageHref(page - 1)}>&larr; Prev</Link> : <span className="muted">&larr; Prev</span>}
          <span>
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? <Link href={pageHref(page + 1)}>Next &rarr;</Link> : <span className="muted">Next &rarr;</span>}
        </div>
      ) : null}
    </>
  );
}
