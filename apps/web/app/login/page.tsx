import { LogoMark } from "../components/logo-mark";

export const metadata = { title: "Log in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const params = await searchParams;
  return (
    <div className="auth-shell">
      <div className="card auth-card">
        <h1>
          <LogoMark /> jqp
        </h1>
        <p className="muted u-text-sm">Enter the dashboard shared secret to continue.</p>
        {params.error ? <div className="error-box">Incorrect secret.</div> : null}
        <form action="/api/auth/login" method="post">
          <input type="hidden" name="next" value={params.next ?? "/"} />
          <label>
            Shared secret
            <input type="password" name="secret" autoFocus required />
          </label>
          <button type="submit" className="btn-block u-mt-xs">
            Log in
          </button>
        </form>
      </div>
    </div>
  );
}
