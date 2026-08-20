# OpenReply DM worker on an Oracle Cloud free VM

The only part of this system that needs to run 24/7. Free forever, always-on, no sleeping and no keep-alive pinger.

## Why only this one service

- **Publishing is inherently local.** `stepValidate` and `stepUpload` in `packages/publisher/src/pipeline.ts` call `scanPostFolder(post.folder_path)`, and `folder_path` points at a folder on your own machine (`D:\jqp\...`). No cloud host can read those files. Run `apps/worker` locally when you want to publish.
- **DM automation must be always-on** — a comment can arrive at any hour, and the reply has to go out while Meta's messaging window is open.
- Everything else (both dashboards) already runs on Vercel.

## Before you start

Oracle's Always Free ARM instances are frequently capacity-constrained — `Out of host capacity` on create is the single most common frustration, and it's not something you did wrong. If you hit it:

- Try a different Availability Domain in the same region
- Try again later (capacity frees up in waves)
- Or fall back to two AMD `VM.Standard.E2.1.Micro` instances, which are also Always Free and almost always available — one is plenty for this worker

Oracle asks for a card to verify identity. Always Free resources are not charged; just don't upgrade to Pay As You Go.

---

## 1. Create the VM

- Oracle Cloud → **Compute → Instances → Create Instance**
- Image: **Ubuntu 22.04** (or 24.04)
- Shape: **VM.Standard.A1.Flex**, 1 OCPU / 6 GB RAM is ample (you get 4/24 free — no need to use it all)
- **Add your SSH public key** — you cannot add it later without a reboot dance
- Create, then copy the **Public IP address**

No ingress rules needed. The worker is a pure consumer — it opens outbound connections to Postgres, Redis and Meta, and listens on nothing. Leave the security list alone.

## 2. Connect and install Node

```bash
ssh ubuntu@<PUBLIC_IP>
```

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs git && node -v
```

## 3. Give the VM read access to the repo

The repo is private, so use a **read-only deploy key** rather than putting a personal token on the box.

On the VM:

```bash
ssh-keygen -t ed25519 -C "oracle-dm-worker" -f ~/.ssh/id_ed25519 -N "" && cat ~/.ssh/id_ed25519.pub
```

Copy that output, then in GitHub:

- `reesick/jqp` → **Settings → Deploy keys → Add deploy key**
- Title: `oracle-dm-worker`
- Paste the key
- **Leave "Allow write access" unchecked**

Back on the VM:

```bash
git clone git@github.com:reesick/jqp.git && cd jqp/vendor/openreply && npm install && npm run db:generate
```

Prisma detects `linux-arm64` and fetches the right engine automatically.

## 4. Environment

```bash
nano ~/jqp/vendor/openreply/.env
```

Paste the same values as your `jqp-openreply` Vercel project:

```
NODE_ENV=production
DATABASE_URL=<session pooler string — see docs/LIVE.md>
REDIS_URL=<Upstash>
ENCRYPTION_KEY=<must match jqp-openreply exactly>
NEXTAUTH_SECRET=<same>
CRON_SECRET=<same>
INSTAGRAM_APP_ID=<same>
INSTAGRAM_APP_SECRET=<same>
FACEBOOK_APP_SECRET=<same>
META_GRAPH_API_VERSION=v26.0
WEBHOOK_VERIFY_TOKEN=<same>
```

Two of these break things *silently* if they drift:

- **`REDIS_URL`** — a different Redis means the worker watches a queue nobody writes to. Comments arrive, nothing sends, no error anywhere.
- **`ENCRYPTION_KEY`** — must match the value `jqp-openreply` uses, or the worker can't decrypt the stored Instagram token.

`NEXTAUTH_URL` is not needed here — this process serves no HTTP.

## 5. Run it under pm2

pm2 restarts the worker on crash and brings it back after a reboot.

```bash
sudo npm install -g pm2 && cd ~/jqp/vendor/openreply && pm2 start "npm run worker" --name openreply-worker && pm2 save && pm2 startup
```

`pm2 startup` prints a `sudo env PATH=... systemd` command — **run that command**, or the worker won't survive a reboot.

## 6. Verify

On the VM:

```bash
pm2 logs openreply-worker --lines 30
```

From anywhere — this is the authoritative check:

```bash
curl -s https://jqp-openreply-1.vercel.app/api/health
```

`worker.healthy` should flip to `true` and the endpoint should return 200 instead of 503. That field is driven by a heartbeat the worker writes to Postgres, so it proves the worker is genuinely alive, not just that a process exists.

Then do a real round trip: comment your keyword on a live post, confirm the button DM arrives, tap it, confirm the link arrives.

---

## Updating later

```bash
cd ~/jqp && git pull && cd vendor/openreply && npm install && npm run db:generate && pm2 restart openreply-worker
```

## Day-to-day

| Task | Where |
|---|---|
| Publish a post | Locally — `npx tsx --env-file=.env apps/worker/src/index.ts`, then ingest + publish from the dashboard |
| Comment → DM | Automatic, 24/7, on the Oracle VM |
| Manage campaigns | https://jqp-web-89h2-wheat.vercel.app |
| DM logs / inbox | https://jqp-openreply-1.vercel.app |

One consequence of publishing being local: `sync-campaign-to-openreply` and the retention purge also live in `apps/worker`, so they only run while that local worker is up. In practice you enable campaigns right after publishing, so they sync then. If a campaign shows `DM_SYNC_PENDING`, start the local worker and it'll go through.
