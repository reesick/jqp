# OpenReply DM worker on an Oracle Cloud free VM

Complete setup guide. Follow top to bottom; everything you need is here.

**Time:** ~40 minutes, most of it waiting on Oracle.
**Cost:** free forever (Always Free tier — card required for identity check, not charged).

---

## What this is and why

This is the **only** part of the system that needs to run 24/7.

| Piece | Where it runs | Why |
|---|---|---|
| Dashboard | Vercel (deployed) | — |
| OpenReply web + webhook | Vercel (deployed) | — |
| **DM worker** | **This VM** | A comment can arrive any hour, and the reply must go out inside Meta's messaging window |
| Publish worker | Your laptop | Reads image files off your D: drive — no remote host can see them |

Publishing being local isn't a limitation to fix; it's just where your files are. Start `apps/worker` locally when you want to post.

---

## Before you start — gather these

Run this on your machine and keep the output open. You'll paste it in step 5:

```bash
cd /d/jqp && cat vendor/openreply/.env
```

You'll also need:
- An SSH key pair. Check with `ls ~/.ssh/id_*.pub` — if nothing, run `ssh-keygen -t ed25519`
- A credit card for Oracle signup (identity verification only)

---

## ⚠️ Read this before creating the VM

Oracle's free **ARM** shapes are heavily oversubscribed. `Out of host capacity` on create is the single most common frustration and **is not your fault**.

If you hit it:
1. Try a different **Availability Domain** (AD-1 → AD-2 → AD-3) in the same region
2. Try again in a few hours — capacity frees in waves
3. **Or just use AMD instead:** shape `VM.Standard.E2.1.Micro` is also Always Free and nearly always available. 1 GB RAM is plenty for this worker

Don't burn an hour retrying ARM. The AMD micro works fine.

Also: **never upgrade to Pay As You Go.** Stay on Always Free and nothing is charged.

---

## 1. Create the VM

Oracle Cloud → **Compute → Instances → Create Instance**

| Setting | Value |
|---|---|
| Name | `openreply-worker` |
| Image | **Ubuntu 22.04** (or 24.04) |
| Shape | `VM.Standard.A1.Flex` — 1 OCPU / 6 GB<br>*or* `VM.Standard.E2.1.Micro` if ARM has no capacity |
| SSH keys | **Upload your public key** (`~/.ssh/id_ed25519.pub`) |

**Add the SSH key during creation.** Adding it afterwards is genuinely painful.

Click Create, wait ~1 min for **Running**, then copy the **Public IP address**.

**No networking changes needed.** This worker makes only outbound connections and listens on nothing — leave the security list alone.

---

## 2. Connect

```bash
ssh ubuntu@<PUBLIC_IP>
```

If it hangs or refuses: the instance is still booting (wait a minute), or you used a different key — try `ssh -i ~/.ssh/id_ed25519 ubuntu@<PUBLIC_IP>`.

---

## 3. Install Node and git

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs git && node -v
```

Expect `v20.x`.

---

## 4. Deploy key (the repo is private)

On the VM:

```bash
ssh-keygen -t ed25519 -C "oracle-dm-worker" -f ~/.ssh/id_ed25519 -N "" && cat ~/.ssh/id_ed25519.pub
```

Copy the whole output line. Then in GitHub:

- `reesick/jqp` → **Settings → Deploy keys → Add deploy key**
- Title: `oracle-dm-worker`
- Key: paste it
- **Leave "Allow write access" UNCHECKED** — read-only is all it needs

Back on the VM:

```bash
git clone git@github.com:reesick/jqp.git
```

Type `yes` at the host authenticity prompt. If you get `Permission denied (publickey)`, the deploy key didn't save — re-add it in GitHub.

---

## 5. Install and configure

```bash
cd ~/jqp/vendor/openreply && npm install && npm run db:generate
```

Takes 2–3 minutes. Prisma detects the platform and fetches the right engine automatically (works on both ARM and AMD).

Now the environment file:

```bash
nano ~/jqp/vendor/openreply/.env
```

Paste the contents you copied in "Before you start", **with one change** — make sure `DATABASE_URL` is the **session pooler** string:

```
DATABASE_URL=postgresql://postgres.rligoaiclwjwfbixnrry:<PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
```

Save with `Ctrl+O`, `Enter`, `Ctrl+X`.

`NEXTAUTH_URL` isn't needed here — this process serves no HTTP.

### The two values that fail silently if wrong

- **`REDIS_URL`** — must be byte-identical to what `jqp-openreply` uses on Vercel. A different Redis means the worker watches a queue nobody writes to: comments arrive, nothing sends, **and no error appears anywhere**.
- **`ENCRYPTION_KEY`** — must match `jqp-openreply`'s exactly, or the worker can't decrypt the stored Instagram token.

Neither produces an obvious failure. If DMs don't send and logs look clean, check these two first.

---

## 6. Run it under pm2

pm2 restarts on crash and survives reboots.

```bash
sudo npm install -g pm2 && cd ~/jqp/vendor/openreply && pm2 start "npm run worker" --name openreply-worker && pm2 save && pm2 startup
```

**`pm2 startup` prints a `sudo env PATH=...` command. Copy and run that exact command.** Skip it and the worker won't come back after a reboot.

---

## 7. Verify

**On the VM:**

```bash
pm2 logs openreply-worker --lines 30
```

Healthy output mentions the worker starting and connecting to Redis. `pm2 list` should show `online` with a low restart count. A climbing restart count means it's crash-looping — read the logs.

**The authoritative check, from anywhere:**

```bash
curl -s https://jqp-openreply-1.vercel.app/api/health
```

You want `"worker":{"healthy":true...}` and HTTP 200 instead of 503.

This is the check that matters, because it's driven by a heartbeat the worker writes to Postgres. It proves the worker is genuinely alive and connected — not merely that a process exists.

**Then a real round trip:** comment your keyword on a live post → button DM arrives → tap it → link arrives.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Out of host capacity` | ARM oversubscribed | Different AD, or use `VM.Standard.E2.1.Micro` |
| `Permission denied (publickey)` on clone | Deploy key not saved | Re-add in GitHub Settings → Deploy keys |
| `worker.healthy` stays `false` | Worker not running, or wrong `REDIS_URL` | `pm2 logs`, then verify Redis URL matches Vercel |
| Comments arrive, no DM, no errors | Wrong `REDIS_URL` — watching an empty queue | Copy the value from Vercel exactly |
| `Can't reach database server` | Using the direct Supabase host | Must be the `aws-0-ap-south-1.pooler...` string |
| Token decryption errors | `ENCRYPTION_KEY` mismatch | Copy from `jqp-openreply` on Vercel |
| Worker gone after reboot | `pm2 startup` command not run | Re-run `pm2 startup` and execute what it prints |
| Prisma engine errors | Generate skipped | `npm run db:generate` then `pm2 restart openreply-worker` |

Useful commands:

```bash
pm2 list && pm2 logs openreply-worker --lines 50 && pm2 restart openreply-worker
```

---

## Updating later

```bash
cd ~/jqp && git pull && cd vendor/openreply && npm install && npm run db:generate && pm2 restart openreply-worker
```

---

## Day-to-day once this is live

| Task | Where |
|---|---|
| Comment → DM | Automatic, 24/7, on this VM |
| Publish a post | Local: `cd /d/jqp && npx tsx --env-file=.env apps/worker/src/index.ts`, then ingest + publish from the dashboard |
| Manage campaigns | https://jqp-web-tau.vercel.app |
| DM logs / inbox | https://jqp-openreply-1.vercel.app |

One consequence of publishing being local: `sync-campaign-to-openreply` and the retention purge also live in `apps/worker`. They only run while the local worker is up. A campaign stuck at `DM_SYNC_PENDING` just means you haven't run the local worker since enabling it — start it and it'll go through.

---

## If Oracle turns out to be a pain

Nothing here is one-way. The same repo, same env file, and same `npm run worker` command work on any host that runs a persistent Node process. `docs/RENDER-FREE.md` has the Render fallback (free but sleeps, needs a keep-alive pinger).
