#!/usr/bin/env bash
# One-time (and safe to repeat) setup of the DM worker host. Run on the VM, from the folder
# that holds the uploaded files:   sudo bash install.sh
#
# It does not start the DM worker. Starting it begins sending queued DMs, so that is a
# separate step you take on purpose (see docs/ORACLE-WORKER.md).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash install.sh"; exit 1; fi
HERE="$(cd "$(dirname "$0")" && pwd)"
for f in dm-worker.mjs selfcheck.mjs vm-guard.mjs jqp-dm-worker.service jqp-vm-guard.service jqp-vm-guard.timer jqp-ctl.sh; do
  [ -f "$HERE/$f" ] || { echo "Missing $f next to install.sh"; exit 1; }
done

echo "==> Node 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  export DEBIAN_FRONTEND=noninteractive
  if command -v apt-get >/dev/null; then
    apt-get update -y && apt-get install -y curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - && dnf install -y nodejs
  fi
fi
node -v

echo "==> Swap (1 GB RAM is tight without it)"
if [ "$(swapon --show --noheadings | wc -l)" -eq 0 ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Service user and folders"
id jqp >/dev/null 2>&1 || useradd --system --home-dir /opt/jqp --shell /usr/sbin/nologin jqp
install -d -m 755 -o root -g root /opt/jqp /opt/jqp/bin
install -d -m 750 -o root -g jqp /etc/jqp
for f in worker.env guard.env; do [ -f "/etc/jqp/$f" ] || install -m 600 -o root -g root /dev/null "/etc/jqp/$f"; done

echo "==> Files"
install -m 644 "$HERE/dm-worker.mjs" "$HERE/selfcheck.mjs" "$HERE/vm-guard.mjs" /opt/jqp/bin/
[ -f "$HERE/VERSION" ] && install -m 644 "$HERE/VERSION" /opt/jqp/VERSION
install -m 755 "$HERE/jqp-ctl.sh" /usr/local/bin/jqp
install -m 644 "$HERE/jqp-dm-worker.service" "$HERE/jqp-vm-guard.service" "$HERE/jqp-vm-guard.timer" /etc/systemd/system/

echo "==> Keep the log from filling the disk"
install -d /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=100M\n' > /etc/systemd/journald.conf.d/jqp.conf
systemctl restart systemd-journald

echo "==> Services"
systemctl daemon-reload
systemctl enable jqp-dm-worker >/dev/null 2>&1
systemctl enable --now jqp-vm-guard.timer >/dev/null 2>&1

echo
echo "Installed. Not started: jqp-dm-worker (so no DMs go out yet)."
[ -s /etc/jqp/worker.env ] || echo "Next: upload the worker env file (see docs/ORACLE-WORKER.md, step 6)."
[ -s /etc/jqp/guard.env ]  || echo "Next: upload the alert mail settings to /etc/jqp/guard.env, then run: jqp test-email"
echo "Then: jqp check   (read-only)   and   jqp start"
