#!/usr/bin/env bash
# Short commands for the VM. Installed as /usr/local/bin/jqp.
#   jqp status      worker service, guard timer, resource readings
#   jqp check       read-only pre-flight (database, Redis, waiting DM count)
#   jqp start       start the worker now and at every boot (this is what begins sending DMs)
#   jqp stop        stop the worker and keep it stopped, also after a reboot
#   jqp restart
#   jqp resume      start again after the guard stopped the worker at a limit
#   jqp rollback    go back to the previous worker build and restart it
#   jqp logs        follow the worker log
#   jqp test-email  send a test alert
#   jqp report      send the VM status report email now (it also goes out every 6 hours)
set -euo pipefail

HALT=/var/lib/jqp-guard/halt

# Runs node as one of the service users with its env file, for the child only (secrets never appear in the shell),
# inside the same sandbox as the real service so a check that passes here means the worker can do it too.
SANDBOX=(-p NoNewPrivileges=true -p ProtectSystem=strict -p ProtectHome=true -p PrivateTmp=true -p PrivateDevices=true
  -p ProtectKernelTunables=true -p ProtectKernelModules=true -p ProtectControlGroups=true -p ProtectClock=true -p ProtectHostname=true
  -p ProtectProc=invisible -p "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX" -p RestrictNamespaces=true -p RestrictSUIDSGID=true
  -p LockPersonality=true -p CapabilityBoundingSet= -p SystemCallFilter=@system-service -p SystemCallArchitectures=native
  -p UMask=0077 -p IPAddressDeny=169.254.169.254)
EXTRA=() # extra systemd properties for one call, e.g. a folder the command may write to
run_as() { # run_as <user> <envfile> <node args...>
  sudo systemd-run --quiet --pipe --wait --collect -p User="$1" -p EnvironmentFile="$2" -p Environment=NODE_ENV=production "${SANDBOX[@]}" "${EXTRA[@]}" /usr/bin/node "${@:3}"
}
run_as_jqp() { run_as jqp "$@"; }
run_as_guard() { run_as jqp-guard "$@"; }

show_status() { systemctl --no-pager --lines=3 status jqp-dm-worker || true; }

case "${1:-}" in
  status)
    systemctl --no-pager --lines=0 status jqp-dm-worker || true
    systemctl list-timers --no-pager jqp-vm-guard.timer || true
    echo
    run_as_guard /etc/jqp/guard.env /opt/jqp/bin/vm-guard.mjs --dry-run
    echo "restarts since boot: $(systemctl show -p NRestarts --value jqp-dm-worker)"
    echo; cat /opt/jqp/VERSION 2>/dev/null || true
    ;;
  check) run_as_jqp /etc/jqp/worker.env /opt/jqp/bin/selfcheck.mjs ;;
  start)
    if [ -e "$HALT" ]; then echo "The guard stopped the worker at a limit ($(tr -cd '[:print:]' < "$HALT")). Fix the cause, then run: jqp resume"; exit 1; fi
    sudo systemctl enable --now jqp-dm-worker
    show_status
    ;;
  stop)
    sudo systemctl disable --now jqp-dm-worker
    show_status
    ;;
  restart)
    if [ -e "$HALT" ]; then echo "The worker is halted ($(tr -cd '[:print:]' < "$HALT")). Use: jqp resume"; exit 1; fi
    if ! systemctl is-enabled --quiet jqp-dm-worker; then echo "The worker is not enabled (stopped on purpose or never started). Use: jqp start"; exit 1; fi
    sudo systemctl restart jqp-dm-worker
    show_status
    ;;
  resume)
    if [ ! -e "$HALT" ]; then echo "Nothing to resume: the guard has not stopped the worker. Use: jqp start"; exit 0; fi
    run_as_guard /etc/jqp/guard.env /opt/jqp/bin/vm-guard.mjs --dry-run || true
    echo
    echo "If the cause is still there (for example outbound data is still over the limit), the guard will stop the worker again within a minute."
    yn=n
    read -r -p "Cause fixed? Remove the stop and start the worker (y/N) " yn || yn=n
    if [ "$yn" = "y" ]; then
      sudo rm -f "$HALT"
      sudo systemctl enable --now jqp-dm-worker
      show_status
    else
      echo "Left stopped."
    fi
    ;;
  rollback)
    if [ ! -f /opt/jqp/bin/dm-worker.mjs.prev ]; then echo "No previous build is kept on this VM."; exit 1; fi
    sudo cp -f /opt/jqp/bin/dm-worker.mjs /opt/jqp/bin/dm-worker.mjs.bad
    sudo cp -f /opt/jqp/bin/dm-worker.mjs.prev /opt/jqp/bin/dm-worker.mjs
    if systemctl is-enabled --quiet jqp-dm-worker && [ ! -e "$HALT" ]; then sudo systemctl restart jqp-dm-worker; show_status; else echo "Rolled back the file. The worker is not enabled, so it was not started."; fi
    ;;
  logs) sudo journalctl -u jqp-dm-worker -f -n 50 ;;
  test-email) run_as_guard /etc/jqp/guard.env /opt/jqp/bin/vm-guard.mjs --test-email ;;
  report) EXTRA=(-p ReadWritePaths=/var/lib/jqp-guard); run_as_guard /etc/jqp/guard.env /opt/jqp/bin/vm-guard.mjs --report ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
