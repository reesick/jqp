import { Check, AlertTriangle, RotateCw, Pause, Circle } from "./icons";

type Tone = "ok" | "err" | "warn" | "run" | "idle";

interface Mapped {
  label: string;
  tone: Tone;
}

// Raw pipeline / sync / DM statuses -> the small vocabulary from DESIGN.md
// sections 18-19. The raw value always stays available as the title attribute.
const MAP: Record<string, Mapped> = {
  DISCOVERED: { label: "Queued", tone: "idle" },
  VALIDATING: { label: "Running", tone: "run" },
  UPLOADING: { label: "Running", tone: "run" },
  CREATING_CHILDREN: { label: "Running", tone: "run" },
  WAITING_FOR_CHILDREN: { label: "Running", tone: "run" },
  CREATING_CAROUSEL: { label: "Running", tone: "run" },
  WAITING_FOR_CAROUSEL: { label: "Running", tone: "run" },
  PUBLISHING: { label: "Running", tone: "run" },
  PUBLISHED: { label: "Published", tone: "ok" },
  FAILED: { label: "Failed", tone: "err" },
  VALIDATION_FAILED: { label: "Failed", tone: "err" },

  DM_SYNC_PENDING: { label: "Queued", tone: "idle" },
  DM_SYNCING: { label: "Running", tone: "run" },
  DM_SYNCED: { label: "Synced", tone: "ok" },
  DM_SYNC_FAILED: { label: "Failed", tone: "err" },

  PENDING: { label: "Queued", tone: "idle" },
  QUEUED: { label: "Queued", tone: "idle" },
  RUNNING: { label: "Running", tone: "run" },
  SENT: { label: "Sent", tone: "ok" },
  RETRYING: { label: "Retrying", tone: "warn" },
  PAUSED: { label: "Paused", tone: "idle" },
  CANCELLED: { label: "Cancelled", tone: "idle" }
};

function sentenceCase(raw: string): string {
  const s = raw.replaceAll("_", " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function StatusBadge({ status, dense }: { status: string; dense?: boolean }) {
  const mapped: Mapped = MAP[status] ?? { label: sentenceCase(status), tone: "idle" };
  const { label, tone } = mapped;

  let glyph: React.ReactNode;
  if (dense) {
    glyph = <span className="badge-dot" aria-hidden="true" />;
  } else if (tone === "ok") {
    glyph = <Check size={12} aria-hidden="true" />;
  } else if (tone === "err") {
    glyph = <AlertTriangle size={12} aria-hidden="true" />;
  } else if (tone === "warn") {
    glyph = <RotateCw size={12} aria-hidden="true" />;
  } else if (tone === "run") {
    glyph = <span className="badge-dot badge-dot-run" aria-hidden="true" />;
  } else if (status === "PAUSED") {
    glyph = <Pause size={12} aria-hidden="true" />;
  } else {
    glyph = <Circle size={10} aria-hidden="true" />;
  }

  return (
    <span className={`badge ${tone}`} title={status}>
      {glyph}
      {label}
    </span>
  );
}
