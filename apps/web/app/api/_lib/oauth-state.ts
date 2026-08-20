/**
 * Shared between the OAuth start and callback routes.
 *
 * Lives here rather than in `start/route.ts` because Next.js route modules may
 * only export route handlers and a fixed set of config keys — exporting a plain
 * constant from one fails `next build` with an opaque "not assignable to type
 * 'never'" error. It typechecks and runs fine under `next dev`, so the failure
 * only shows up at build time.
 */
export const OAUTH_STATE_COOKIE = "jqp_oauth_state";
