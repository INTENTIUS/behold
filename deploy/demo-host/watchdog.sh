#!/usr/bin/env bash
#
# The demo host's watchdog (#570). Runs on the host as root, from
# demo-host-watchdog.service, and checks every DEMO_WATCHDOG_INTERVAL seconds:
#
#   - the driver container. If it is not running, the watchdog starts it and
#     logs a stall. If Docker restarted it (restart: unless-stopped), the
#     watchdog logs that as a stall too.
#   - demo.json, which the driver writes to <reports>/demo.json in floci at
#     every step (INTENTIUS/terragucci#1014). If it says "stalled", the stall
#     is logged at once, and the driver is restarted when it is still
#     "stalled" after DEMO_WATCHDOG_STALLED_GRACE seconds: the driver resets
#     and moves on by itself first. If demo.json has not changed for
#     DEMO_WATCHDOG_STALE seconds, the driver is restarted. While there is no
#     demo.json at all (a bootstrap after a reboot builds images and applies
#     the base), the limit is DEMO_WATCHDOG_BOOT seconds instead.
#   - the cycle in demo.json. When it changes, each view checkout behold serves
#     (/view/<repo name>, one per demo repo, behold#571) is moved to its
#     origin's main, so behold's cards are main's roots.
#
# Clocks start again when the driver starts, so a restart is never counted as
# a stall of its own.
#
# The watchdog never pushes, resets main or touches a state. A restart kills
# the driver, and the driver's own start does the reset, under the loop's rule:
# no push to main while a wave waits or applies (INTENTIUS/terragucci#1014).
#
# Stalls go to /var/log/demo-host/stalls.log and to the journal
# (journalctl -u demo-host-watchdog). `demo-host.sh pause` stops the driver
# and tells the watchdog to leave it stopped; `demo-host.sh start` undoes it.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${DEMO_ENV_FILE:-/etc/demo-host/demo.env}"
STATE=/var/lib/demo-host
LOG_DIR=/var/log/demo-host
DRIVER=demo-host-driver
BEHOLD=demo-host-behold

conf() { # name, default: a value from the env file (no sourcing), else the default
  local v=""
  [ -f "$ENV_FILE" ] && v="$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -1)"
  printf '%s' "${v:-$2}"
}

REPORTS="$(conf DEMO_REPORTS s3://demo-reports/demo)"
FLOCI="http://127.0.0.1:$(conf TERRAGUCCI_FLOCI_PORT 4580)"
INTERVAL="$(conf DEMO_WATCHDOG_INTERVAL 15)"
STALE="$(conf DEMO_WATCHDOG_STALE 1800)"
STALLED_GRACE="$(conf DEMO_WATCHDOG_STALLED_GRACE 300)"
BOOT="$(conf DEMO_WATCHDOG_BOOT 3600)"

rest="${REPORTS#s3://}"
DEMO_JSON_URL="$FLOCI/${rest%/}/demo.json"

mkdir -p "$LOG_DIR" "$STATE"

info()  { echo "[watchdog] $*"; }
stall() {
  local line
  line="$(date -u +%FT%TZ) $*"
  echo "[watchdog] STALL $*"
  echo "$line" >> "$LOG_DIR/stalls.log"
}

now() { date +%s; }

restart_driver() { # why
  stall "$1; restarting the driver"
  docker restart -t 30 "$DRIVER" >/dev/null 2>&1 || {
    info "docker restart failed; bringing the stack up"
    "$HERE/demo-host.sh" start || info "demo-host.sh start failed"
  }
  last_change="$(now)"
  stalled_noted=""
}

pull_view() { # cycle
  # Every checkout is tried; the exit status says whether any one failed.
  if docker exec "$BEHOLD" sh -c 'ok=0; n=0; for d in /view/*/; do [ -d "$d.git" ] || continue; n=$((n+1)); git -C "$d" fetch -q origin "+refs/heads/*:refs/remotes/origin/*" && git -C "$d" reset -q --hard origin/main || ok=1; done; [ "$n" -gt 0 ] && exit $ok; exit 1' 2>/dev/null; then
    info "cycle $1: the view checkouts are at origin/main"
  else
    info "cycle $1: could not move every view checkout to origin/main (behold not up yet?)"
  fi
}

info "watching $DRIVER and $DEMO_JSON_URL every ${INTERVAL}s (stale ${STALE}s, stalled grace ${STALLED_GRACE}s, boot ${BOOT}s)"

last_sum=""
last_change="$(now)"
last_cycle=""
last_restarts=""
stalled_noted=""

while :; do
  sleep "$INTERVAL"

  if [ "$(cat "$STATE/driver-mode" 2>/dev/null || echo running)" = paused ]; then
    continue
  fi

  # ── the driver container ────────────────────────────────────────────────
  read -r status restarts started code < <(docker inspect -f '{{.State.Status}} {{.RestartCount}} {{.State.StartedAt}} {{.State.ExitCode}}' "$DRIVER" 2>/dev/null) \
    || status=missing
  case "$status" in
    running|restarting) ;;
    missing)
      stall "the driver container does not exist"
      "$HERE/demo-host.sh" start || info "demo-host.sh start failed"
      last_change="$(now)"
      continue
      ;;
    *)
      stall "the driver container is $status (exit code ${code:-?}); starting it"
      docker start "$DRIVER" >/dev/null 2>&1 || info "docker start $DRIVER failed"
      last_change="$(now)"
      continue
      ;;
  esac
  if [ -n "$last_restarts" ] && [ "$restarts" != "$last_restarts" ]; then
    stall "the driver exited and Docker restarted it (restart count $last_restarts -> $restarts)"
  fi
  last_restarts="$restarts"
  started_at="$(date -d "$started" +%s 2>/dev/null || echo 0)"

  # ── demo.json ───────────────────────────────────────────────────────────
  body="$(curl -fsS -m 10 "$DEMO_JSON_URL" 2>/dev/null || true)"
  sum="$(printf '%s' "$body" | sha256sum | cut -d' ' -f1)"
  if [ "$sum" != "$last_sum" ]; then
    last_sum="$sum"
    last_change="$(now)"
    stalled_noted=""
  fi
  base="$last_change"
  [ "$started_at" -le "$base" ] || base="$started_at"
  since=$(( $(now) - base ))

  if [ -z "$body" ]; then
    [ "$since" -lt "$BOOT" ] || restart_driver "no demo.json for ${since}s"
    continue
  fi

  cycle="$(jq -r '.cycle // empty' <<<"$body" 2>/dev/null || true)"
  step="$(jq -r '.step // empty' <<<"$body" 2>/dev/null || true)"
  if [ -n "$cycle" ] && [ "$cycle" != "$last_cycle" ]; then
    last_cycle="$cycle"
    pull_view "$cycle"
  fi

  if [ "$step" = stalled ]; then
    if [ -z "$stalled_noted" ]; then
      stall "demo.json says stalled (cycle $cycle, $(jq -r '.scenario // "?"' <<<"$body")): $(jq -r '.label // ""' <<<"$body")"
      stalled_noted=1
    fi
    [ "$since" -lt "$STALLED_GRACE" ] || restart_driver "demo.json has said stalled for ${since}s"
  elif [ "$since" -ge "$STALE" ]; then
    restart_driver "demo.json has not changed for ${since}s (cycle $cycle, step $step)"
  fi
done
