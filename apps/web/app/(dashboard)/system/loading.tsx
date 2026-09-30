export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Checking system health">
      <div className="page-header">
        <div>
          <div className="skeleton" style={{ width: 120, height: 26 }} />
          <div className="skeleton" style={{ width: 170, height: 14, marginTop: 10 }} />
        </div>
      </div>
      <div className="home-section">
        <div className="skeleton" style={{ width: 90, height: 12, marginBottom: 12 }} />
        {[0, 1, 2, 3, 4].map((row) => (
          <div className="skeleton" key={row} style={{ height: 44, marginBottom: 6 }} />
        ))}
      </div>
    </div>
  );
}
