#!/usr/bin/env bash
# Short commands for the VM. Installed as /usr/local/bin/jqp.
#   jqp status      worker service, guard timer, resource readings
#   jqp check       read-only pre-flight (database, Redis, waiting DM count)
#   jqp start|stop|restart
#   jqp resume      start again after the guard stopped the worker at a limit
#   jqp logs        follow the worker log
#   jqp test-email  send a test alert
set -euo pipefail

run_as_jqp() {
  # Loads the env file for the child only, so secrets never appear in the shell.
  sudo systemd-run --quiet --pipe --wait --collect -p User=jqp -p EnvironmentFile="$1" /usr/bin/node "${@:2}"
}

case "${1:-}" in
  status)
    systemctl --no-pager --lines=0 status jqp-dm-worker || true
    systemctl list-timers --no-pager jqp-vm-guard.timer || true
    echo
    run_as_jqp /etc/jqp/guard.env /opt/jqp/bin/vm-guard.mjs --dry-run
    echo; cat /opt/jqp/VERSION 2>/dev/null || true
    ;;
  check) run_as_jqp /etc/jqp/worker.env /opt/jqp/bin/selfcheck.mjs ;;
  resume)
    run_as_jqp /etc/jqp/guard.env /opt/jqp/bin/vm-guard.mjs --dry-run
    read -r -p "Cause fixed? Remove the stop and start the worker (y/N) " yn
    [ "$yn" = "y" ] && sudo rm -f /var/lib/jqp-guard/halt && sudo systemctl start jqp-dm-worker && systemctl --no-pager --lines=3 status jqp-dm-worker || echo "Left stopped."
    ;;
  start)
    if [ -e /var/lib/jqp-guard/halt ]; then echo "The guard stopped the worker at a limit ($(cat /var/lib/jqp-guard/halt)). Fix the cause, then run: jqp resume"; exit 1; fi
    sudo systemctl start jqp-dm-worker && systemctl --no-pager --lines=3 status jqp-dm-worker || true
    ;;
  stop|restart) sudo systemctl "$1" jqp-dm-worker && systemctl --no-pager --lines=3 status jqp-dm-worker || true ;;
  logs) sudo journalctl -u jqp-dm-worker -f -n 50 ;;
  test-email) run_as_jqp /etc/jqp/guard.env /opt/jqp/bin/vm-guard.mjs --test-email ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
