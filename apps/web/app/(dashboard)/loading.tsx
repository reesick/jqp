export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="page-header">
        <div>
          <div className="skeleton" style={{ width: 90, height: 12, marginBottom: 12 }} />
          <div className="skeleton" style={{ width: 240, height: 32 }} />
        </div>
      </div>
      <div className="stat-grid">
        {[0, 1, 2, 3].map((i) => (
          <div className="stat-tile" key={i}>
            <div className="skeleton" style={{ width: 80, height: 12, marginBottom: 14 }} />
            <div className="skeleton" style={{ width: 56, height: 32 }} />
          </div>
        ))}
      </div>
      <div className="card" style={{ marginTop: 24 }}>
        {[0, 1, 2, 3].map((i) => (
          <div className="skeleton" key={i} style={{ height: 16, margin: "14px 0", width: `${90 - i * 12}%` }} />
        ))}
      </div>
    </div>
  );
}
