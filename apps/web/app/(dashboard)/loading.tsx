export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="page-header">
        <div>
          <div className="skeleton" style={{ width: 200, height: 26 }} />
          <div className="skeleton" style={{ width: 130, height: 14, marginTop: 10 }} />
        </div>
      </div>
      {[0, 1, 2].map((section) => (
        <div className="home-section" key={section}>
          <div className="skeleton" style={{ width: 90, height: 12, marginBottom: 12 }} />
          {[0, 1].map((row) => (
            <div className="skeleton" key={row} style={{ height: 44, marginBottom: 6 }} />
          ))}
        </div>
      ))}
    </div>
  );
}
