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

| Check | Warning | Critical |
|---|---|---|
| Boot disk used | 70% | 85% |
| Memory available | under 150 MB | under 80 MB |
| Swap used | 50% | 80% |
| Outbound data this month | 5 GB | 20 GB |
| Worker restarts between two checks | 2 | 5 |
| Worker service not running | | immediately |

The outbound-data numbers are tripwires, not the real limit. Oracle's allowance is 10 TB; a DM worker sends megabytes. If it ever reaches 5 GB something is wrong (a loop, or a compromised machine), and you hear about it long before the free limit matters. The email shows the figure as a percentage of the 10 TB allowance.

Emails go out on a change (OK to warning, warning to critical, back to OK), repeat every 6 hours while critical and every 24 hours while a warning, and say what to do. If the mail itself fails, it retries the next minute.

What the guard cannot do: if the whole VM dies it cannot email you. The dashboard monitor covers that, but only once the two GitHub settings exist (`MONITOR_TOKEN` secret and `MONITOR_URL` variable, see `docs/MONITORING.md`). Do those two settings; they matter more now.

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
npm run deploy-dm-worker -- --host ubuntu@<PUBLIC_IP> --key $HOME\.ssh\oracle_jqp --install --push-env --push-guard-env
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
5. Safe test of the alerts: `sudo systemctl stop jqp-dm-worker` then wait about a minute. You should get a CRITICAL email, and an "OK again" email after `jqp start`.

## 6. Day to day

| Task | Command |
|---|---|
| Ship a new build | `npm run deploy-dm-worker -- --host ubuntu@<IP> --key ... --restart` |
| New database or Redis password | `npm run deploy-dm-worker -- --host ubuntu@<IP> --key ... --push-env --restart` |
| New mail key | same with `--push-guard-env` |
| Stop sending DMs | `jqp stop` (comments queue in Redis and are answered on restart, within Meta's 7-day window) |
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
