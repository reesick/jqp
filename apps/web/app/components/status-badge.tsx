import { CheckCircle2, Loader2, XCircle } from "./icons";

const OK_STATUSES = new Set(["PUBLISHED", "DM_SYNCED"]);
const WARN_STATUSES = new Set([
  "DISCOVERED",
  "VALIDATING",
  "UPLOADING",
  "CREATING_CHILDREN",
  "WAITING_FOR_CHILDREN",
  "CREATING_CAROUSEL",
  "WAITING_FOR_CAROUSEL",
  "PUBLISHING",
  "DM_SYNC_PENDING",
  "DM_SYNCING"
]);
const ERR_STATUSES = new Set(["FAILED", "VALIDATION_FAILED", "DM_SYNC_FAILED"]);

export function StatusBadge({ status, dense }: { status: string; dense?: boolean }) {
  let cls = "badge";
  let Icon = null;
  if (OK_STATUSES.has(status)) {
    cls += " ok";
    Icon = CheckCircle2;
  } else if (ERR_STATUSES.has(status)) {
    cls += " err";
    Icon = XCircle;
  } else if (WARN_STATUSES.has(status)) {
    cls += " warn";
    Icon = Loader2;
  }

  return (
    <span className={cls}>
      {dense || !Icon ? (
        <span className="badge-dot" />
      ) : (
        <Icon size={12} className={Icon === Loader2 ? "spin" : undefined} />
      )}
      {status.replaceAll("_", " ")}
    </span>
  );
}
