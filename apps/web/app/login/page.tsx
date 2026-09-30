import { LogoMark } from "../components/logo-mark";

export const metadata = { title: "Log in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const params = await searchParams;
  return (
    <div className="auth-shell">
      <main className="auth-panel">
        <h1 className="auth-title">
          <LogoMark /> jqp
        </h1>
        <p className="muted u-text-sm">Enter the dashboard secret to continue.</p>
        {params.error ? (
          <div className="error-box" role="alert" id="login-error">
            That secret didn&rsquo;t work. Check it and try again. After several wrong attempts, logins are paused for
            about 15 minutes.
          </div>
        ) : null}
        <form action="/api/auth/login" method="post">
          <input type="hidden" name="next" value={params.next ?? "/"} />
          <label htmlFor="secret">Dashboard secret</label>
          <input
            id="secret"
            type="password"
            name="secret"
            autoFocus
            required
            autoComplete="current-password"
            aria-invalid={params.error ? true : undefined}
            aria-describedby={params.error ? "login-error" : undefined}
          />
          <button type="submit" className="btn-block u-mt-sm">
            Log in
          </button>
        </form>
      </main>
    </div>
  );
}
