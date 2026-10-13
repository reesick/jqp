# Launch task list: new Instagram account to production

One list, in order. We fire one task at a time. A task is done only when its "Done when" line is true. Nothing publishes a post or enables a campaign unless the owner says so for that task (H2, H3).

Owner = Sri. Me = Claude. Where both are named, the owner clicks in a console and I run the checks.

## A. Decisions (answer these first, they change later tasks)

| # | Question | Why it matters |
|---|---|---|
| A1 | The new account's @handle, and is it a Business or Creator (professional) account? | Personal accounts cannot use the API |
| A2 | What happens to @anveya.d? Keep it connected but idle, or disconnect it? | It has 2 active automations. They keep running until switched off, and the off switch has a bug (B1) |
| A3 | Is the Meta app in Live mode or Development mode? (Meta console, top bar) | In Development mode only people with a role on the app can comment, and real webhook events are limited. Live mode needs privacy and terms URLs and may need Business verification |
| A4 | Will anyone other than you use the new account's comments (real followers)? | Yes means the app must be Live. Standard access covers your own account; other people's accounts need App Review |
| A5 | Full auto posting or you approve each post? Default I recommend: you approve each post and each campaign | Matches the rules in CLAUDE.md |

## B. Safety fixes before anything goes live (me, with tests and an independent review each)

| # | Task | Done when |
|---|---|---|
| B1 | Fix the campaign off switch: turning a campaign off must stop its DMs, including through OpenReply | A test proves a disabled campaign sends nothing; verified on the live toggle with the worker running and a test comment |
| B2 | Stop double publishing: record the post before the publish call, and make Retry safe (no reusing dead containers). Until then: no blind Retry | Unit tests for the crash-between-publish-and-record case; Retry on a failed post creates a fresh container |
| B3 | Make the account explicit: write the chosen account on each post (`ig_account_id`) so a new account cannot silently use the old one's token | A post for the new account publishes with the new account's token |
| B4 | Token refresh job for the 60 day token (can follow launch within 45 days; put a calendar reminder for day 50 today) | A scheduled job refreshes and the System page shows the new expiry |
| B5 | Optional, needs your approval: viral-burst pacing patch to the vendored sender (about 30 lines) | Sends are spread out when a burst arrives |

## C. Connect the new account (owner clicks, I verify)

| # | Task | Done when |
|---|---|---|
| C1 | Convert the new account to Business or Creator in the Instagram app (Settings, Account type) | Account shows as professional |
| C2 | Meta console: add the account as an Instagram tester (App roles), then accept the invite inside Instagram (Settings, Apps and websites, Tester invites). Also confirm a second test account has a role, for writing test comments | Invite shows accepted |
| C3 | Connect it in OpenReply: https://jqp-openreply-1.vercel.app, Settings, Connect Instagram | An `InstagramAccount` row exists for the new account (I check) |
| C4 | Subscribe the new account to `comments`, `messages` and `messaging_postbacks` (not `messaging_seen`) | The subscribed-apps check lists exactly those fields (I run it) |
| C5 | Publishing credentials: get a long-lived token for the new account (Meta console token generator or the dashboard Connect Instagram). Then I update `META_IG_USER_ID` and `META_LONG_LIVED_ACCESS_TOKEN` in the root env, on Vercel (`jqp-web`) and wherever the local publish worker runs, using `npm run set-env` so nothing is pasted by hand. Redeploy | `npm run doctor` and `npm run smoke` pass and the token check names the new account |
| C6 | Old account: switch off its two campaigns in OpenReply (after B1 is done) or disconnect it, per A2 | No DMs from the old account's automations |

## D. Infrastructure (the VM is built; these finish it)

| # | Task | Done when |
|---|---|---|
| D1 | GitHub: secret `MONITOR_TOKEN` and variable `MONITOR_URL`, then run the monitor workflow once | Workflow run is green |
| D2 | Rotate the secrets that appeared in chat: Redis password, Brevo SMTP key, delete the Supabase access token. I update the env scripts and redeploy | Old values no longer work |
| D3 | Set `CRON_SECRET` on `jqp-openreply-1` and make the dashboard password 32+ characters | Both set, redeployed |
| D4 | On the Oracle VM: `jqp check`, start the worker (`jqp start`), then the drills in `docs/ORACLE-WORKER.md` section 5b | Heartbeat healthy in `npm run smoke`; every drill gives its expected result |
| D5 | Run `npm run backup` before launch | A snapshot with row counts exists |
| D6 | Housekeeping: free disk space on C:, retire the duplicate Vercel projects (`jqp-web-89h2`, `jqp-openreply`) | Disk has room; one project per app |

## E. Content (follows docs/CLAUDE-CONTENT-GUIDE.md)

| # | Task | Done when |
|---|---|---|
| E1 | First post folder: images, caption in human voice (no em dashes, no AI phrasing), trigger keyword | `ingest_post_folder` passes validation and the checklist in the guide |
| E2 | Campaign copy: opening DM that states it is automated (a line like "This is an automated message from <brand>"), the button text, the link message, public reply options | `preview_dm` output reviewed by you |
| E3 | Decide the keyword and whether the public reply is on | Written in the campaign config |

## F. Final audit (me, with independent agents, after B to E are done)

| # | Task | Done when |
|---|---|---|
| F1 | Security audit of the code and the deployed config (auth, secrets, headers, VM, deploy scripts) | Report with findings ranked; every High fixed or accepted by you in writing |
| F2 | Launch readiness and reliability audit (double sends, silent failures, alerts, backups, recovery) | Same standard |
| F3 | Data protection audit (what personal data is stored, retention, deletion path, the unencrypted Redis) | Same standard |
| F4 | Fix the findings, re-run tests, build, typecheck, smoke | All green and re-reviewed |

## G. Meta terms and policy check (after the final audit, before enabling anything)

| # | Task | Done when |
|---|---|---|
| G1 | Read the current Meta documents: Platform Terms, Developer Policies, Instagram Platform and Messaging policy (private replies, the 24 hour and 7 day windows, automated messaging disclosure, spam and rate rules), the changelog for the Instagram API versions we use, and App Review and Live-mode requirements | A dated summary of what changed since `docs/COMPLIANCE.md` was written, with source links |
| G2 | Compare every flow against it: opening DM, button reveal, link, public reply, follow-up, rates, retention, deletion | A gap list, each gap marked blocker or not |
| G3 | Fix blockers and update `docs/COMPLIANCE.md` | No open blocker |

## H. Launch (you decide each step; nothing here happens on its own)

| # | Task | Done when |
|---|---|---|
| H1 | End to end test with the second account on a draft or hidden post: comment the keyword, get the button DM, tap, get the link, public reply posts | Whole chain works and the System page shows no errors |
| H2 | Publish the first real post. Needs your explicit go | Post is live; media id recorded |
| H3 | Enable its campaign. Needs your explicit go | Campaign shows synced and the worker answers a test comment |
| H4 | Watch the first 24 hours: `jqp status` morning and evening, System page, alert emails | No unexplained alerts; DM counts match comments |
| H5 | After launch: token refresh job (B4), Redis with TLS, reply variations, second worker on GCP as backup, erasure path | Tracked in `docs/REMEDIATION-PLAN.md` |

## Critical path to launch ASAP
A1 to A5, then B1 and B2 and B3 (they can run while you do C1, C2), then C3 to C6, D1 to D5, E1 to E3, then F, then G, then H. Realistic if every task goes smoothly: two working sessions. The longest waits are Meta's tester invite, Business verification if Meta asks for it, and any App Review.
