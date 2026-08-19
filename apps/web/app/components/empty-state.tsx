export function EmptyState({
  icon,
  title,
  action
}: {
  icon: React.ReactNode;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon}</span>
      <span>{title}</span>
      {action}
    </div>
  );
}
