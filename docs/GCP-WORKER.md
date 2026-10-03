# Running the DM worker on a Google Cloud e2-micro (free tier)

Takes the DM worker off your laptop so DMs go out 24/7. About 45 minutes. The worker only makes outbound connections (Redis, the database, Meta), so the VM needs no open web ports.

## What the free tier gives (Google Cloud documentation, checked 2026-10-03)
- 1 e2-micro VM per month, only in **us-west1, us-central1 or us-east1**.
- 30 GB of standard persistent disk and 1 GB of outbound data a month (North America to other regions). This worker uses a few tens of MB.
- A billing account with a card is required even for free-tier use.
- **Not free, check before you click Create:** the console's cost panel may show a small monthly charge for the VM's external IP address. The worker needs outbound internet, so it needs that address. Watch the first bill.

e2-micro has 2 shared vCPUs and 1 GB of RAM. That is enough for the worker once you add swap (step 3).

Trade-off: the VM is in the US and your database is in Mumbai, so each query takes roughly a quarter second. At 100 to 200 DMs a day nobody will notice.

## 1. Create the VM
Google Cloud Console, Compute Engine, Create instance:
- Name `jqp-dm-worker`. Region **us-central1** (or us-west1 or us-east1), zone any.
- Machine type **e2-micro**. The cost panel should say it is covered by the free tier.
- Boot disk: **Debian 12**, **Standard persistent disk**, 20 GB (not SSD or Balanced, those are not free).
- Firewall: leave HTTP and HTTPS **unticked**.
Create it, then press **SSH** next to the instance to open a browser terminal.

## 2. Install what it needs
```bash
sudo apt-get update && sudo apt-get install -y git curl build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # should print v22.x
```

## 3. Add swap (1 GB RAM is tight without it)
```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 4. Get the code (the repository is private, so use a read-only deploy key)
```bash
ssh-keygen -t ed25519 -f ~/.ssh/jqp_deploy -N ""
cat ~/.ssh/jqp_deploy.pub
```
Copy that line. On GitHub: the repository, Settings, Deploy keys, Add deploy key, paste it, leave "Allow write access" **off**. Then:
```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/jqp_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
git clone git@github.com:reesick/jqp.git && cd jqp/vendor/openreply
npm ci
DATABASE_URL=postgresql://x npx prisma generate
```

## 5. Copy the secrets from your laptop (never paste them into a chat)
On your laptop, in a normal terminal with the Google Cloud CLI installed (or use the browser SSH window's "Upload file" button):
```
gcloud compute scp D:\jqp\vendor\openreply\.env jqp-dm-worker:~/jqp/vendor/openreply/.env --zone <your-zone>
```
Then on the VM:
```bash
chmod 600 ~/jqp/vendor/openreply/.env
echo 'COMMENT_POLL_LOOKBACK_HOURS=72' >> ~/jqp/vendor/openreply/.env
```
That file already holds the working `REDIS_URL` and `DATABASE_URL` (port 6543). Whenever you rotate the database or Redis password, copy the file again and restart the service (step 7).

## 6. Run it as a service that survives reboots and crashes
Find your username and npm path with `whoami` and `which npm`, then:
```bash
sudo tee /etc/systemd/system/jqp-dm-worker.service > /dev/null <<'EOF'
[Unit]
Description=jqp DM worker (OpenReply)
After=network-online.target
Wants=network-online.target

[Service]
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/jqp/vendor/openreply
EnvironmentFile=/home/YOUR_USERNAME/jqp/vendor/openreply/.env
ExecStart=/usr/bin/npm run worker
Restart=always
RestartSec=10
MemoryMax=700M

[Install]
WantedBy=multi-user.target
EOF
sudo sed -i "s/YOUR_USERNAME/$(whoami)/g" /etc/systemd/system/jqp-dm-worker.service
sudo systemctl daemon-reload && sudo systemctl enable --now jqp-dm-worker
```
Check it: `sudo systemctl status jqp-dm-worker` and `journalctl -u jqp-dm-worker -f`. You should see `[DM Worker] Started`.

## 7. Day to day
- Update after a code change: `cd ~/jqp && git pull && cd vendor/openreply && npm ci && sudo systemctl restart jqp-dm-worker`
- New password: copy the `.env` again (step 5), then `sudo systemctl restart jqp-dm-worker`.
- Stop sending: `sudo systemctl stop jqp-dm-worker`. Comments queue in Redis and are answered on restart, within Meta's 7-day window.

## 8. Switch over and verify
1. Stop the worker on your laptop (`Ctrl+C`). Run **one** worker at a time. Two would not send duplicates (the database allows one DM per comment) but they would waste effort.
2. From your laptop: `npm run smoke`. The line "DM worker heartbeat" should pass, and OpenReply's health should show the VM's hostname instead of `Sri`.
3. Ask for a test: comment the keyword from a second account and confirm the reply arrives.

## Known limits
- The Redis connection is unencrypted (`redis://`), and now crosses the public internet from Google's network. See `docs/REMEDIATION-PLAN.md` item B1. Moving to a Redis with TLS is the first thing to do after this.
- The VM is a single machine: if it crashes, systemd restarts it, but there is no second copy. The monitor (once scheduled) emails you if the heartbeat stops.
- The publish worker still needs your laptop, because it reads images from a folder on your disk (`docs/REMOTE-ACCESS-PLAN.md`, option 3).
