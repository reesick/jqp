export function EmptyState({
  icon,
  title,
  hint,
  action
}: {
  icon: React.ReactNode;
  title: string;
  /** One line saying what to do next. */
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="empty-title">{title}</span>
      {hint ? <span className="empty-hint">{hint}</span> : null}
      {action}
    </div>
  );
}
