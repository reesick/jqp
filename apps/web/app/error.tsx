"use client";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card" style={{ maxWidth: 480, margin: "80px auto" }}>
      <h1>Something went wrong</h1>
      <p className="muted">
        This is usually a database or network blip — Supabase pausing, a connection hiccup, that kind of thing. Your
        posts and campaigns are almost certainly fine; this page just couldn&apos;t load them.
      </p>
      <div className="error-box">{error.message || "Unknown error"}</div>
      <button onClick={() => reset()}>Try again</button>
    </div>
  );
}
