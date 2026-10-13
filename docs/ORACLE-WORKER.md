# DM worker on an Oracle Cloud Always Free VM

Runs the OpenReply DM worker 24/7 on a free Oracle VM, with alerts that email you the moment a limit or health threshold is crossed. About 30 minutes of your time. Nothing here starts sending DMs until you run `jqp start` yourself.

What changed from the first version of this guide: the VM no longer needs the repository, a deploy key, 800 MB of packages, npm or pm2. We build a 6 MB bundle on your laptop and ship it. The worker runs under systemd with a dedicated user and a memory cap, and a guard process watches the limits.

## 1. Read this first: two facts that change the plan

Checked against Oracle's Always Free reference on 2026-10-13.

**The free allowance** (one Oracle account)

| Resource | Free limit | What we use |
|---|---|---|
| AMD micro VMs (`VM.Standard.E2.1.Micro`) | up to 2, each 1/8 OCPU (can burst), 1 GB RAM | 1 |
| Arm VMs (`VM.Standard.A1.Flex`) | now 2 OCPU and 12 GB in total (it used to be 4 and 24) | 0 |
| Block and boot storage | 200 GB in total, 5 volume backups | one boot volume of about 50 GB |
| Outbound data | 10 TB per month | well under 1 GB |

**Idle VMs can be reclaimed.** Oracle treats a VM as idle if, over 7 days, its CPU (95th percentile) is under 20% and its network use is under 20% (Arm VMs also need memory under 20%). A DM worker is mostly waiting, so it will look idle, and Oracle says idle instances "may be reclaimed". Oracle's page does not say how much warning you get, and it does not say whether a Pay As You Go account is exempt. A 2023 Oracle notice reposted on a community site says it is, and that Pay As You Go accounts are not charged while all usage stays inside the Always Free limits. That is old and secondhand, so treat it as unconfirmed.

That gives you a decision to make before you rely on this VM:

| | Stay on Always Free only | Upgrade to Pay As You Go (still $0 inside the limits) |
|---|---|---|
| Can it ever charge your card? | No | Yes, if something goes beyond the free limits |
| Reclaim risk | Real. Plan for it. | Reported as exempt (unconfirmed) |
| Protection | Run a second worker elsewhere (GCP VM, see `docs/GCP-WORKER.md`) so a reclaim does not stop DMs, and read Oracle's emails | Budget alert (step 2) plus the VM guard below |

My recommendation: stay on Always Free, use the AMD micro, and keep the GCP worker as the backup. If Oracle reclaims the VM you create a new one in 10 minutes with this guide, and DMs are never down because the other worker keeps going. Do not add artificial load to fake activity; that is against the spirit of the free tier and can get the account flagged.

## 2. Alerts: what emails you, and how fast

| Layer | Catches | Speed |
|---|---|---|
| **VM guard** (runs on the VM, every minute) | Disk filling, low memory or heavy swap, outbound data far above normal, worker stopped or crash-looping, VM rebooted | About 1 minute |
| **Dashboard monitor** (GitHub Actions, every 30 minutes) | VM dead or unplugged (worker heartbeat stale), DM failures, database or Redis down, Meta rate limits | Up to 30 minutes |
| **Oracle budget alert** (step 2 below) | Any paid charge at all, since free resources cost $0 | Oracle checks once every 24 hours, so not instant |
| **Oracle's own emails** | Idle-reclaim warnings, maintenance | Whenever Oracle sends them. Make sure the account email is one you read. |

The guard's thresholds (all adjustable with `GUARD_*` settings in `/etc/jqp/guard.env`):

| Check | Warning | Critical | Force stop of the worker |
|---|---|---|---|
| Boot disk used | 70% | 85% | **95%** |
| Memory available | under 150 MB | under 80 MB | no |
| Swap used | 50% | 80% | no |
| Outbound data this month | 5 GB | 20 GB | **95% of Oracle's 10 TB allowance** |
| Worker restarts between two checks | 2 | 5 | no |
| Worker service not running | | immediately | |

The outbound-data numbers are tripwires, not the real limit. Oracle's allowance is 10 TB; a DM worker sends megabytes. If it ever reaches 5 GB something is wrong (a loop, or a compromised machine), and you hear about it long before the free limit matters. The email shows the figure as a percentage of the 10 TB allowance.

Emails go out on a change (OK to warning, warning to critical, back to OK), repeat every 6 hours while critical and every 24 hours while a warning, and say what to do. If the mail itself fails, it retries the next minute.

What the guard cannot do: if the whole VM dies it cannot email you. The dashboard monitor covers that, but only once the two GitHub settings exist (`MONITOR_TOKEN` secret and `MONITOR_URL` variable, see `docs/MONITORING.md`). Do those two settings; they matter more now.

## 2b. Force stop at the limit, and why nothing is lost

**The stop.** When the boot disk reaches 95%, or outbound data reaches 95% of Oracle's 10 TB monthly allowance, the guard writes a stop file. A root-owned systemd path unit sees it within a second and stops the DM worker, and the worker's unit refuses to start while the file exists, so a reboot does not bring it back. You get a CRITICAL email saying the worker was stopped automatically. The guard checks every minute, so the stop lands within about a minute of crossing the line. You undo it with `jqp resume` (it shows the readings, asks you to confirm, removes the file, starts the worker). Memory pressure and crash loops email you but never stop the worker, because they cost nothing. The halt percentages can be changed with `GUARD_DISK_HALT_PCT` and `GUARD_TRANSFER_HALT_PCT` in `/etc/jqp/guard.env`.

Be clear about what can and cannot hit these lines. The VM's size is fixed by the shape you choose, so CPU, memory and storage cannot grow past the free allowance by themselves. The one meter that moves on its own is outbound data, and a DM worker sends megabytes against a 10 TB allowance, so the 95% stop is a last line of defence. It will almost never fire; the 5 GB and 20 GB emails are the ones you will act on. Money the account spends outside this VM (a resource someone created in the console) is invisible to the VM. That is what the Oracle budget alert in step 3 is for, and it is checked daily, not instantly.

**Why a stop loses nothing.** Four layers, each true today:

1. The comment webhook runs on Vercel, not on the VM. A comment arriving while the worker is stopped is still received and put on the Redis queue.
2. Redis keeps queued jobs. I checked the live Redis (2026-10-13, read-only): its eviction policy is `noeviction`, so it never silently drops jobs to make room, and it uses 2.6 MB. If it ever filled up it would refuse new jobs rather than delete old ones.
3. A comment that never became a job is caught anyway, but only within 72 hours. The worker's polling sweep asks Meta every 5 minutes for comments from the last 72 hours and queues any that were missed. When the worker comes back it catches up on everything from the last 3 days.
4. Duplicate protection is mostly, not perfectly, safe. The database allows one log row per comment, and the worker skips a comment whose DM is already marked SENT. That check reads first and writes after, so a crash in the instant between Meta accepting a DM and the worker recording it can send that one DM twice. This is rare, and it is the reason to avoid restarting the worker while a big backlog is draining.

**What is guaranteed and what is not.** Anything the Vercel webhook queued is kept until the worker runs. Anything it missed is recovered only if the worker is back within **72 hours**. Meta accepts private replies for 7 days after the comment, so between 3 and 7 days only the webhook-queued comments are safe. Treat 72 hours as your real deadline, and resume the same day if you can. The critical email repeats every 6 hours while the worker is stopped.

**Resuming after a long stop** sends the whole backlog in a burst. The worker's own pacing (750 an hour) applies, but a sudden burst of identical DMs is something Meta's spam checks can notice, so for a big backlog resume in the daytime and watch `jqp logs` and the System page. If the cause of the stop is still there (for example the monthly outbound total is still over the limit), the guard stops the worker again within a minute; fix the cause first, or raise `GUARD_TRANSFER_HALT_PCT` for the rest of the month.

Two caveats I could not remove: this Redis has no append-only file, so a Redis restart could in theory lose queued jobs (layer 3 recovers what it can from Meta within 72 hours), and the connection is the plain `redis://` one, so the traffic is not encrypted. The Redis facts above (eviction policy `noeviction`, 2.6 MB used) were read on 2026-10-13 and can change; `npm run check-redis` shows the current state.

## 3. Create the Oracle side (console, about 15 minutes)

1. **Instance:** Compute, Instances, Create instance.
   - Name `jqp-dm-worker`. Image **Canonical Ubuntu 24.04**. Shape **VM.Standard.E2.1.Micro** (use Change shape and pick the AMD one). The console should mark it "Always Free-eligible". If it does not, stop and check before you create anything.
   - Networking: keep the default network, **assign a public IPv4 address**. No reserved IP, no load balancer, no extra volumes, no extra VNICs.
   - Boot volume: leave the default size. Do not tick the option to increase performance (that is not free).
   - SSH keys: on your laptop run `ssh-keygen -t ed25519 -f $HOME\.ssh\oracle_jqp -N '""'` in PowerShell, then upload `oracle_jqp.pub`. Add it now; adding one later is painful.
2. **Capacity error ("Out of host capacity"):** try another availability domain, or retry later. The AMD micro is usually available.
3. **Budget alert (a backstop):** Billing and Cost Management, Budgets, Create budget. Scope: the root compartment. Monthly amount **$1**. Add two alert rules, Actual spend at 1% and Forecast at 100%, with your email. Because everything we use is free, any alert means something is outside the free limits. If your account type has no Budgets page, skip this step; the VM guard still protects the machine. I could not confirm from Oracle's docs which account types can create budgets.
4. **Never create** anything else while you are in there: a bigger shape, a second boot volume, extra block volumes, a load balancer, NAT gateways, paid database services.
5. Copy the public IP address. The default user for Ubuntu is `ubuntu`.

## 4. Ship the worker from your laptop

In PowerShell, in `D:\jqp` (OpenSSH comes with Windows 11):

```
node --import tsx scripts/deploy-dm-worker.ts --host ubuntu@<PUBLIC_IP> --key $HOME\.ssh\oracle_jqp --install --push-env --push-guard-env
```

That builds the bundle, copies it, installs Node 22, a 2 GB swap file, a locked-down `jqp` user, the systemd units and a 100 MB cap on the system log, uploads the worker's env file (never printed; it refuses if `DATABASE_URL` is not on port 6543 or a key is missing), and uploads only the mail settings for the guard. `--dry-run` prints the steps without doing them. It does **not** start the worker.

Then on the VM (`ssh -i $HOME\.ssh\oracle_jqp ubuntu@<PUBLIC_IP>`):

```
jqp test-email     # you should get a message; if not, fix this before anything else
jqp check          # read-only: env, database, Redis, and how many DM jobs are waiting
jqp status         # service, guard timer and the current readings
```

`jqp check` passing means the bundle works on this machine. The waiting-jobs number is how many DMs the worker will send in the first minutes after you start it.

## 5. Switch over

1. Stop any other DM worker first (laptop `Ctrl+C`; GCP `sudo systemctl stop jqp-dm-worker`) unless you want two running as a deliberate pair (see step 7).
2. On the VM: `jqp start`, then `jqp logs`. You should see `[DM Worker] Started`.
3. From your laptop: `npm run smoke`. The DM worker heartbeat line should pass and the hostname should be the VM's.
4. Comment the keyword from a second account on the live post and confirm the DM arrives.
5. Run the drills in section 5b before you trust it.

## 5b. Production plan: phases, gates and drills

Do the phases in order. Each has a gate; do not move on until it passes. Total time about 2 hours, most of it waiting.

**Important: the worker is not enabled until you run `jqp start`** (install and deploy never start it, and a reboot does not start it either). Drills 1 to 3 below need a running worker, and a running worker answers real comments and works through any backlog and the 72 hour poll. So run those three only after `jqp check` shows 0 jobs waiting and you are happy for it to run, ideally right at cut-over. Drills 4 to 6 (force stop, mail, dead VM) are safe before the worker has ever started.

| Phase | Do | Gate (how you know) |
|---|---|---|
| 0. Before the VM | Put `MONITOR_TOKEN` (secret) and `MONITOR_URL` (variable) in GitHub and run the monitor workflow once. Rotate the Redis and Brevo keys if you have not. Make sure Oracle's emails reach an inbox you read. | Workflow run is green |
| 1. Account | Turn on multi-factor sign-in for the Oracle account. Create the budget alert (step 3). | Budget shows in the console |
| 2. VM | Section 3. AMD micro, public IP, nothing else. | Shape shows "Always Free-eligible"; `ssh` works |
| 3. Deploy | Section 4 (one command). | `jqp test-email` arrives; `jqp check` all ok |
| 4. Drills | Below. | Every drill gives the expected result |
| 5. Cut over | Section 5: stop other workers, `jqp start`, `npm run smoke`, one real test comment. | Smoke passes; DM arrives; heartbeat hostname is the VM |
| 6. Watch | 24 hours: `jqp status` morning and evening, and the System page. | No unexplained emails, restart count stays at 0 |
| 7. Steady state | Weekly: `jqp status`, `npm run backup`, read Oracle emails. Monthly: the outbound data figure in guard emails, and GitHub Actions minutes. | |

**Drills (phase 4), with no real comments pending**

| Drill | Do | Expected |
|---|---|---|
| Worker down | `sudo systemctl stop jqp-dm-worker`, wait 1 to 2 minutes | CRITICAL email "service is inactive". `jqp start` then gives an "OK again" email |
| Crash restart | `sudo systemctl kill -s KILL jqp-dm-worker` | Worker back within about 10 seconds. One crash is not emailed; two or more restarts between checks give a WARNING |
| Reboot | `sudo reboot` | Worker starts by itself, and an INFO "VM rebooted" email arrives |
| Force stop | `sudo -u jqp sh -c 'echo drill > /var/lib/jqp-guard/halt'` | Worker stops within seconds. `jqp start` refuses and points to `jqp resume`. After a reboot it stays stopped. `jqp resume` brings it back and it is still running 30 seconds later. Tested on the VM on 2026-10-13: the stop service fires on creating the file, is skipped when the file is deleted, and the worker unit refuses to start while the file exists |
| Mail path | `jqp test-email` | Message arrives |
| Dead VM | Stop the instance in the Oracle console for 40 minutes | Dashboard monitor emails that the worker heartbeat is stale. Start it again after |

**Failure playbook**

| What happened | You see | Do | Data at risk |
|---|---|---|---|
| Worker crashed | Restart email | Nothing, it restarts. Read `jqp logs` if it repeats | None |
| Worker stopped by the guard | CRITICAL "STOPPED automatically" | Fix the cause (disk: clear space; data: find what is sending), then `jqp resume` | None if resumed within 7 days |
| VM unreachable or reclaimed | Dashboard monitor email (up to 30 min) | Start the GCP worker, then rebuild this VM from section 3 | None; queue and poller cover it |
| Database password changed | Worker errors in logs | Deploy with `--push-env --restart` | None |
| Redis down | Dashboard monitor email | Fix Redis, restart the worker | Comments received while Redis is down are recovered by the 72 hour poll |
| Meta rate limited | Dashboard events | Wait; the worker retries by itself | None |
| Suspected compromise | Unusual outbound data email | `jqp stop`, rotate database, Redis, mail and Meta secrets, rebuild the VM | Rotate everything |

Rollback of a bad deploy: check out the earlier commit, run the deploy command with `--restart`, check out `main` again. Expect a worker crash or reboot to be back within a minute, and a lost VM to be a 10 to 15 minute rebuild, or no gap at all if the GCP worker is already running.

## 6. Day to day

| Task | Command |
|---|---|
| Ship a new build | `node --import tsx scripts/deploy-dm-worker.ts --host ubuntu@<IP> --key ... --restart` |
| New database or Redis password | `node --import tsx scripts/deploy-dm-worker.ts --host ubuntu@<IP> --key ... --push-env --restart` |
| New mail key | same with `--push-guard-env` |
| Start again after an automatic stop | `jqp resume` |
| Stop sending DMs | `jqp stop` (it also disables the worker, so a reboot does not start it again; comments queue in Redis and are answered after `jqp start`, within the 72 hour catch-up window) |
| Go back to the previous worker build | `jqp rollback` (the previous build is kept as `dm-worker.mjs.prev`) |

`--restart` only restarts a worker that is enabled and not halted. A worker you stopped, or never started, stays stopped. `--push-guard-env` replaces only the mail settings and keeps any `GUARD_*` lines you added on the VM. On the first connection `ssh` trusts the VM's host key; compare it with the fingerprint shown on the instance's console connection page if you want to be sure before secrets are uploaded.
| Look at the readings | `jqp status` |
| Follow the log | `jqp logs` |

Rollback: deploy an earlier commit (`git checkout <sha>`, deploy, `git checkout main`). The bundle holds its build id in `/opt/jqp/VERSION`.

## 7. Running two workers (Oracle plus GCP)

Allowed and useful as a backup. The database permits one DM per comment, so a job picked up twice cannot send twice. Two points are not verified yet: whether the 750 per hour cap is shared between workers, and what happens to a job that was running on a worker that crashed. Test with a harmless comment before relying on it.

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `jqp check` says FAIL on database | Wrong port or password in the pushed env file. Fix locally with `npm run sync-openreply-env`, deploy with `--push-env`. |
| `jqp check` says FAIL on redis | Redis URL wrong, or the Redis Cloud database blocks this VM's IP. |
| Comments arrive, no DMs, no errors | The worker is watching a different Redis than OpenReply on Vercel. They must match exactly. |
| Token decryption errors | `ENCRYPTION_KEY` differs from the one on Vercel's OpenReply project. |
| Guard emails "service not running" | `jqp logs`. A crash loop is usually a wrong URL. Fix the env, push it, `jqp restart`. |
| No test email | The guard env is missing or wrong. Re-run with `--push-guard-env`. Brevo must allow the sender address. |
| `Out of host capacity` | Another availability domain, or retry in a few hours. |
| VM gone or stopped by Oracle | Possible idle reclaim (section 1). Create a new one and deploy again; the GCP worker keeps DMs going meanwhile. |

## 9. What this does not cover
- The Redis connection is plain `redis://` (your decision for now) and crosses the internet from Oracle's network. Moving to a Redis with TLS is the first item on `docs/REMEDIATION-PLAN.md` before scaling.
- A single VM is a single point of failure; the second worker (section 7) is the answer.
- Publishing still happens on your laptop because it reads image folders from disk (`docs/REMOTE-ACCESS-PLAN.md`).
- Free limits on other services (Supabase database 500 MB, Redis Cloud memory, Vercel, GitHub Actions minutes) are separate. The dashboard's System page shows the database side; GitHub Actions minutes are the reason the monitor now runs every 30 minutes (about 1,500 of the 2,000 free minutes a month, in my estimate).

## Sources
Oracle: Always Free Resources (docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm); Budgets overview (docs.oracle.com/en-us/iaas/Content/Billing/Concepts/budgetsoverview.htm). The pay-as-you-go idle exemption comes from a 2023 notice reposted at blog.51sec.org and is unconfirmed.
