"use client";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="error-panel">
      <h1>This page couldn&rsquo;t load</h1>
      <p className="muted">
        This is usually a database or network blip, such as Supabase pausing or a dropped connection. Your posts and
        automations are almost certainly fine; the page just couldn&rsquo;t fetch them. Try again in a few seconds.
      </p>
      <div className="error-box" role="alert">
        {error.message || "Unknown error"}
        {error.digest ? (
          <>
            {" "}
            <span className="mono">ref {error.digest}</span>
          </>
        ) : null}
      </div>
      <button onClick={() => reset()}>Try again</button>
    </main>
  );
}
