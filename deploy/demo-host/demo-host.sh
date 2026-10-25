#!/usr/bin/env bash
#
# The demo host (#570): Forgejo, its runner, floci, the loop driver, a public
# read-only behold and Caddy on one machine. README.md says how the machine is
# made; this script does everything on it. Run as root.
#
#   demo-host.sh bootstrap [--secrets <file>]
#       A fresh Ubuntu or Amazon Linux instance, from nothing: installs Docker
#       (with compose and buildx), git, jq and curl; binds Docker's published
#       ports to 127.0.0.1 by default; writes /etc/demo-host/demo.env and
#       Caddy's password from <file> or from prompts; clones terragucci and
#       behold at the refs in demo.env; installs the systemd units; builds the
#       images; starts the stack; and waits for the driver's bootstrap
#       (terragucci stack/demo.sh up) to finish once. Safe to run again.
#   demo-host.sh start      bring the stack up (systemd runs this at boot)
#   demo-host.sh pause      stop the driver and keep it stopped (the watchdog
#                           leaves it alone) until the next start
#   demo-host.sh update-prepare [--terragucci-ref <ref>] [--behold-ref <ref>]
#                           the part of an update that never touches the
#                           loop, run while it and the site carry on: write
#                           the refs given to demo.env, move the behold
#                           checkout, fetch terragucci (without moving its
#                           checkout, which the running driver reads), install
#                           the units and build the behold and driver images.
#   demo-host.sh update [--terragucci-ref <ref>] [--behold-ref <ref>]
#                           write the refs given to demo.env, move the behold
#                           checkout, build (quick after update-prepare), then
#                           wait for a quiet step (demo.json says reset or
#                           applied, at most DEMO_QUIET_WAIT seconds, 900),
#                           stop the driver, move the terragucci checkout and
#                           start the services again. The driver bootstraps
#                           again when the terragucci commit changed. Before
#                           it starts the services, it clears what a failed
#                           recreate left (clear-strays). behold is recreated
#                           only when its image changed, and Caddy restarted
#                           only when the Caddyfile did.
#   demo-host.sh clear-strays
#                           remove the containers compose made for behold or
#                           the driver that aren't running under the name
#                           compose gives them (demo-host-<service>)
#   demo-host.sh open       launch morning: take the password off the site
#   demo-host.sh close      put the password back
#   demo-host.sh status     containers, demo.json and the last stalls
#   demo-host.sh cleanup    run the disk cleanup now (cleanup.sh), as
#                           demo-host-cleanup.timer does daily and update does
#                           after it succeeds
#
# bootstrap's pieces, one at a time, for the demo-host-bootstrap op
# (chant/ops/bootstrap.op.ts), which runs them over ssh in this order:
#   install                 Docker, compose, buildx, git, jq, curl; ports on 127.0.0.1
#   checkout-self [--secrets <file>]
#                           clone behold at BEHOLD_REF into /opt/demo/behold;
#                           the pieces after this run from that checkout
#   configure [--secrets <file>]
#                           /etc/demo-host/demo.env and Caddy's password
#   checkouts               terragucci and behold at the refs in demo.env
#   units                   install and enable the systemd units, start the
#                           cleanup timer, and cap the journal (DEMO_JOURNAL_MAX)
#   build                   build the behold and driver images
#   start-driver            start (the driver alone on a fresh host) and the watchdog
#   wait-bootstrap          wait for the driver's bootstrap to record its base
#   up                      bring every service up (behold and Caddy too)
#   reload-caddy            restart Caddy on the Caddyfile (a moved checkout replaces the file)
#
# The secrets file (never committed; README.md, "Secrets") holds
# KEY=value lines: DEMO_AUTH_PASSWORD, and optionally any key of
# demo.env.example. Without one, bootstrap asks.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ETC=/etc/demo-host
ENV_FILE="$ETC/demo.env"
STATE=/var/lib/demo-host
UNIT_DIR=/etc/systemd/system
# Where the checkouts live. compose.yaml and the units assume it too.
ROOT=/opt/demo

# Pinned versions of the Docker CLI plugins on hosts whose packages lack them
# (Amazon Linux). Ubuntu's own packages are used as they are.
COMPOSE_VERSION=v5.5.1
BUILDX_VERSION=v0.37.1
CADDY_IMAGE=caddy:2.11.4-alpine

log() { echo "[demo-host] $*" >&2; }
die() { log "FAIL: $*"; exit 1; }

conf() { # name, default: a value from demo.env, read without sourcing it
  local v=""
  [ -f "$ENV_FILE" ] && v="$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -1)"
  printf '%s' "${v:-$2}"
}

set_conf() { # name, value: replace or append one line of demo.env
  local tmp="$ENV_FILE.new"
  touch "$ENV_FILE"
  { grep -v "^$1=" "$ENV_FILE" || true; echo "$1=$2"; } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}


compose() {
  docker compose --project-name demo-host -f "$HERE/compose.yaml" --env-file "$ENV_FILE" "$@"
}

need_root() { [ "$(id -u)" = 0 ] || die "run as root (sudo $0 ...)"; }

# ── bootstrap pieces ─────────────────────────────────────────────────────────

install_packages() {
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian)
      log "installing Docker, compose, buildx, git, jq and curl (apt)"
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -q
      apt-get install -y -q docker.io docker-compose-v2 docker-buildx git jq curl ca-certificates
      ;;
    amzn)
      log "installing Docker, git, jq and curl (dnf), then the compose and buildx plugins"
      dnf install -y -q docker git jq
      command -v curl >/dev/null || dnf install -y -q curl-minimal
      install_plugins
      ;;
    *) die "this script knows Ubuntu and Amazon Linux, not '${ID:-unknown}'" ;;
  esac
  systemctl enable --now docker
}

install_plugins() { # the compose and buildx CLI plugins, from their releases, checked against the published sums
  local arch c_arch b_arch dir=/usr/local/lib/docker/cli-plugins tmp
  arch="$(uname -m)"
  case "$arch" in
    x86_64) c_arch=x86_64 b_arch=amd64 ;;
    aarch64) c_arch=aarch64 b_arch=arm64 ;;
    *) die "no compose or buildx build for $arch" ;;
  esac
  mkdir -p "$dir"
  tmp="$(mktemp -d)"
  if ! docker compose version 2>/dev/null | grep -q "${COMPOSE_VERSION#v}"; then
    curl -fsSL -o "$tmp/docker-compose" "https://github.com/docker/compose/releases/download/$COMPOSE_VERSION/docker-compose-linux-$c_arch"
    curl -fsSL -o "$tmp/compose.sha256" "https://github.com/docker/compose/releases/download/$COMPOSE_VERSION/docker-compose-linux-$c_arch.sha256"
    [ "$(sha256sum "$tmp/docker-compose" | cut -d' ' -f1)" = "$(cut -d' ' -f1 "$tmp/compose.sha256")" ] \
      || die "docker-compose $COMPOSE_VERSION does not match its published sha256"
    install -m 0755 "$tmp/docker-compose" "$dir/docker-compose"
  fi
  if ! docker buildx version 2>/dev/null | grep -q "$BUILDX_VERSION"; then
    curl -fsSL -o "$tmp/docker-buildx" "https://github.com/docker/buildx/releases/download/$BUILDX_VERSION/buildx-$BUILDX_VERSION.linux-$b_arch"
    curl -fsSL -o "$tmp/checksums.txt" "https://github.com/docker/buildx/releases/download/$BUILDX_VERSION/checksums.txt"
    grep -q "^$(sha256sum "$tmp/docker-buildx" | cut -d' ' -f1)  \*\{0,1\}buildx-$BUILDX_VERSION.linux-$b_arch\$" "$tmp/checksums.txt" \
      || die "buildx $BUILDX_VERSION does not match its published checksums"
    install -m 0755 "$tmp/docker-buildx" "$dir/docker-buildx"
  fi
}

docker_localhost_only() {
  # Every port a container publishes without naming an address binds
  # 127.0.0.1, so terragucci's Forgejo (3300) and floci (4580) stay on the
  # host. Caddy names 0.0.0.0 for 80 and 443 in compose.yaml.
  local f=/etc/docker/daemon.json want
  want='{"ip": "127.0.0.1", "log-driver": "local", "log-opts": {"max-size": "20m", "max-file": "5"}}'
  if [ -f "$f" ]; then
    if [ "$(jq -r '.ip // empty' "$f")" = 127.0.0.1 ]; then return 0; fi
    die "$f exists without \"ip\": \"127.0.0.1\"; add it (published ports must default to localhost) and run bootstrap again"
  fi
  mkdir -p /etc/docker
  echo "$want" | jq . > "$f"
  log "Docker now binds published ports to 127.0.0.1 unless a port names an address; restarting Docker"
  systemctl restart docker
}

read_secret() { # file, key: one value from a KEY=value file, without sourcing it
  sed -n "s/^$2=//p" "$1" | tail -1
}

write_env() { # [secrets file]
  local secrets="${1:-}" key val
  mkdir -p "$ETC" "$ETC/caddy" "$STATE" "$STATE/behold" /var/log/demo-host
  chmod 700 "$ETC"
  if [ ! -f "$ENV_FILE" ]; then
    install -m 600 "$HERE/demo.env.example" "$ENV_FILE"
    log "wrote $ENV_FILE from demo.env.example"
  fi
  if [ -n "$secrets" ]; then
    # Any key of demo.env.example the secrets file sets wins.
    while read -r key; do
      val="$(read_secret "$secrets" "$key")"
      [ -z "$val" ] || set_conf "$key" "$val"
    done < <(sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' "$HERE/demo.env.example")
  fi
  if [ ! -f "$ETC/caddy/password.caddy" ] && [ ! -f "$ETC/caddy/password.caddy.off" ]; then
    local pw="" pw2=""
    [ -z "$secrets" ] || pw="$(read_secret "$secrets" DEMO_AUTH_PASSWORD)"
    if [ -z "$pw" ]; then
      [ -t 0 ] || die "no DEMO_AUTH_PASSWORD in a secrets file, and no terminal to ask on"
      read -r -s -p "Password for $(conf DEMO_HOSTNAME demo.intentius.io) until launch morning: " pw; echo >&2
      read -r -s -p "Again: " pw2; echo >&2
      [ "$pw" = "$pw2" ] || die "the two passwords differ"
    fi
    [ "${#pw}" -ge 12 ] || die "the password needs 12 characters or more"
    write_password "$pw"
  fi
}

write_password() { # plaintext: Caddy's basic_auth block with a bcrypt hash of it
  local hash user
  user="$(conf DEMO_AUTH_USER preview)"
  hash="$(printf '%s\n' "$1" | docker run --rm -i "$CADDY_IMAGE" caddy hash-password)" \
    || die "caddy hash-password failed"
  # shellcheck disable=SC2016 # a literal: bcrypt hashes start with $2
  case "$hash" in '$2'*) ;; *) die "caddy hash-password printed no bcrypt hash" ;; esac
  ( umask 077; printf 'basic_auth {\n\t%s %s\n}\n' "$user" "$hash" > "$ETC/caddy/password.caddy.new" )
  mv "$ETC/caddy/password.caddy.new" "$ETC/caddy/password.caddy"
  log "wrote Caddy's password for user '$user' to $ETC/caddy/password.caddy (hash only)"
}

checkout() { # name, ref: clone or move <root>/<name> to ref (a branch on origin, a tag or a commit)
  local name="$1" ref="$2" dir url
  dir="$ROOT/$name"
  url="https://github.com/INTENTIUS/$name.git"
  if [ ! -d "$dir/.git" ]; then
    log "cloning $name"
    git clone -q "$url" "$dir"
  fi
  git -C "$dir" fetch -q --tags --force origin
  if git -C "$dir" rev-parse -q --verify "refs/remotes/origin/$ref^{commit}" >/dev/null; then
    git -C "$dir" checkout -q --detach "origin/$ref"
  else
    git -C "$dir" checkout -q --detach "$ref^{commit}" 2>/dev/null || die "$name has no branch, tag or commit '$ref'"
  fi
  log "$name at $ref ($(git -C "$dir" rev-parse --short HEAD))"
}

checkouts() {
  mkdir -p "$ROOT" "$ROOT/views"
  checkout terragucci "$(conf TERRAGUCCI_REF main)"
  checkout behold "$(conf BEHOLD_REF main)"
}

update_refs() { # [--terragucci-ref <ref>] [--behold-ref <ref>]: write the refs given to demo.env
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --terragucci-ref) set_conf TERRAGUCCI_REF "${2:?}"; shift 2 ;;
      --behold-ref) set_conf BEHOLD_REF "${2:?}"; shift 2 ;;
      *) die "unknown argument '$1'" ;;
    esac
  done
}

fetch_terragucci() { # fetch only: the running driver reads the checkout, so it moves once the driver is stopped
  [ -d "$ROOT/terragucci/.git" ] || return 0
  git -C "$ROOT/terragucci" fetch -q --tags --force origin
}

# The loop can be interrupted only at a step where no wave is waiting or
# applying (INTENTIUS/terragucci#1014): demo.json says reset or applied. Each
# is held for the scenario's hold (20 seconds by default), so this looks every
# second, on the host, right before the driver stops. A driver that isn't
# running, or a demo.json not written yet, has nothing to interrupt. Past
# DEMO_QUIET_WAIT seconds (900, a few cycles of the host's scenarios) it gives
# up and the update stops with the driver untouched.
wait_quiet() {
  local url limit start step
  url="http://127.0.0.1:$(conf TERRAGUCCI_FLOCI_PORT 4580)/$(conf DEMO_REPORTS s3://demo-reports/demo | sed 's#^s3://##')/demo.json"
  limit="$(conf DEMO_QUIET_WAIT 900)"
  if [ "$(docker inspect -f '{{.State.Running}}' demo-host-driver 2>/dev/null)" != true ]; then
    log "the driver isn't running; nothing to wait for"
    return 0
  fi
  start="$(date +%s)"
  while :; do
    step="$(curl -fsS -m 5 "$url" 2>/dev/null | jq -r '.step // "none"' 2>/dev/null || echo none)"
    case "$step" in
      reset|applied|none) log "demo.json says $step; stopping the driver"; return 0 ;;
    esac
    [ $(( $(date +%s) - start )) -lt "$limit" ] \
      || die "demo.json still says $step after ${limit}s (DEMO_QUIET_WAIT); the driver keeps running and nothing moved but the behold checkout and the images"
    sleep 1
  done
}

# The Caddyfile is bind-mounted as one file, which a moved checkout replaces;
# Caddy restarts to mount the new one only when its content changed, so an
# update that didn't touch it keeps the site up throughout.
caddy_current() {
  [ "$(docker exec demo-host-caddy cat /etc/caddy/Caddyfile 2>/dev/null)" = "$(cat "$HERE/Caddyfile")" ]
}

install_units() {
  local u
  for u in demo-host.service demo-host-watchdog.service demo-host-cleanup.service demo-host-cleanup.timer; do
    sed "s#@DEMO_ROOT@#$ROOT#g" "$HERE/systemd/$u" > "$UNIT_DIR/$u"
  done
  systemctl daemon-reload
  systemctl enable demo-host.service demo-host-watchdog.service
  systemctl enable --now demo-host-cleanup.timer
  journal_cap
}

# The journal's cap, so it never grows to journald's default of a tenth of
# the disk. cleanup.sh vacuums to the same size each day.
journal_cap() {
  local f=/etc/systemd/journald.conf.d/demo-host.conf want
  want="$(printf '# Written by demo-host.sh from DEMO_JOURNAL_MAX in demo.env.\n[Journal]\nSystemMaxUse=%s\n' "$(conf DEMO_JOURNAL_MAX 500M)")"
  [ "$(cat "$f" 2>/dev/null)" != "$want" ] || return 0
  mkdir -p "$(dirname "$f")"
  printf '%s\n' "$want" > "$f"
  systemctl restart systemd-journald
  log "the journal is capped at $(conf DEMO_JOURNAL_MAX 500M) ($f)"
}

wait_bootstrap() { # the driver's first bootstrap: until floci holds the marker driver-entry.sh writes
  local floci _
  floci="http://127.0.0.1:$(conf TERRAGUCCI_FLOCI_PORT 4580)"
  log "waiting for the driver's bootstrap (stack/demo.sh up; the first one builds the CI images): docker logs -f demo-host-driver"
  for _ in $(seq 1 360); do
    if curl -fsS -o /dev/null "$floci/demo-host/bootstrapped" 2>/dev/null; then
      log "the driver's bootstrap finished"
      return 0
    fi
    sleep 10
  done
  die "the driver's bootstrap did not finish within an hour; see docker logs demo-host-driver"
}

# A recreate that failed part-way can leave a container compose made for a
# service that isn't the one compose means to run: only created or stopped,
# named `<hash>_demo-host-<service>` or still holding `demo-host-<service>`, or
# renamed by hand and running. compose finds a service's containers by their
# labels, not their names, so the next `up` either fails on the name ("is
# already in use") or keeps running the renamed one as the service.
#
# For each of behold and the driver with such a container, clear_strays runs
# `docker compose rm --stop --force <service>` for this project. That stops
# and removes the containers compose labelled as that service of project
# demo-host, the strays and the current one, and nothing else: no volume (no
# -v), no image, no file, no container of another project or of no project.
# The `up` after it makes `demo-host-<service>` again from the image. A
# container named demo-host-<service> that compose didn't make is left alone,
# and `up` says so.
strays() { # service: "<id> <name> <state>" for each container compose made for it that isn't running as demo-host-<service>
  local id name state
  docker ps -a --no-trunc \
    --filter "label=com.docker.compose.project=demo-host" \
    --filter "label=com.docker.compose.service=$1" \
    --filter "label=com.docker.compose.oneoff=False" \
    --format '{{.ID}} {{.Names}} {{.State}}' |
    while read -r id name state; do
      if [ "$state" != running ] || [ "$name" != "demo-host-$1" ]; then echo "$id $name $state"; fi
    done
}

clear_strays() {
  local svc found
  for svc in behold driver; do
    found="$(strays "$svc")"
    [ -n "$found" ] || continue
    log "containers compose made for $svc that aren't running as demo-host-$svc (id, name, state):"
    printf '%s\n' "$found" | sed 's/^/  /' >&2
    log "removing $svc's containers in project demo-host (docker compose rm --stop --force $svc); up makes demo-host-$svc again"
    compose rm --stop --force "$svc"
  done
}

running_as_named() { # after up: each service runs as demo-host-<service>
  local svc
  for svc in behold driver; do
    [ "$(docker inspect -f '{{.State.Running}}' "demo-host-$svc" 2>/dev/null)" = true ] \
      || die "demo-host-$svc is not running after up; '$0 status' shows the containers"
  done
}

# ── commands ─────────────────────────────────────────────────────────────────

cmd_start() {
  mkdir -p "$STATE" "$STATE/behold" "$ROOT/views" /var/log/demo-host
  echo running > "$STATE/driver-mode"
  # behold joins terragucci's network, which the driver's first bootstrap
  # makes. Before it exists, start the driver alone; bootstrap starts the rest.
  if docker network inspect "$(conf TG_NETWORK terragucci)" >/dev/null 2>&1; then
    compose up -d
  else
    log "terragucci's network is not there yet (no bootstrap so far); starting the driver alone"
    compose up -d driver
  fi
}

cmd_bootstrap() { # [--secrets <file>]: the part that needs nothing but this file
  local secrets="" ref self
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --secrets) secrets="${2:?--secrets needs a file}"; shift 2 ;;
      *) die "unknown argument '$1'" ;;
    esac
  done
  if [ -n "$secrets" ]; then
    [ -r "$secrets" ] || die "cannot read $secrets"
    secrets="$(cd "$(dirname "$secrets")" && pwd)/$(basename "$secrets")"
  fi
  install_packages
  docker_localhost_only
  # The rest runs from the behold checkout at BEHOLD_REF, so the host runs
  # the setup that ref holds, whether this file came from it or not.
  ref="$( { [ -z "$secrets" ] || read_secret "$secrets" BEHOLD_REF; } )"
  checkout behold "${ref:-$(conf BEHOLD_REF main)}"
  self="$ROOT/behold/deploy/demo-host"
  exec "$self/demo-host.sh" bootstrap-rest ${secrets:+--secrets "$secrets"}
}

secrets_arg() { # [--secrets <file>]: the file's absolute path, or nothing
  local secrets=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --secrets) secrets="${2:?--secrets needs a file}"; shift 2 ;;
      *) die "unknown argument '$1'" ;;
    esac
  done
  if [ -n "$secrets" ]; then
    [ -r "$secrets" ] || die "cannot read $secrets"
    secrets="$(cd "$(dirname "$secrets")" && pwd)/$(basename "$secrets")"
  fi
  printf '%s' "$secrets"
}

cmd_install() {
  install_packages
  docker_localhost_only
}

cmd_checkout_self() { # [--secrets <file>]: behold at the secrets file's BEHOLD_REF, else demo.env's
  local secrets ref
  secrets="$(secrets_arg "$@")"
  ref="$( { [ -z "$secrets" ] || read_secret "$secrets" BEHOLD_REF; } )"
  mkdir -p "$ROOT"
  checkout behold "${ref:-$(conf BEHOLD_REF main)}"
}

cmd_start_driver() {
  cmd_start
  systemctl start demo-host-watchdog.service
}

cmd_up() {
  compose up -d
  log "up: https://$(conf DEMO_HOSTNAME demo.intentius.io) (password until launch morning). $0 status shows the loop."
}

# The Caddyfile is bind-mounted as one file. git replaces the file when the
# checkout moves, and a single-file mount keeps the old one, so `caddy reload`
# would read the stale copy: Caddy restarts to mount the new one. (The password
# lives in a mounted directory, so open and close can reload.)
cmd_reload_caddy() {
  docker restart demo-host-caddy >/dev/null
  log "Caddy restarted on $HERE/Caddyfile"
}

cmd_bootstrap_rest() { # [--secrets <file>]
  local secrets=""
  [ "${1:-}" != --secrets ] || secrets="${2:?}"
  write_env "$secrets"
  checkouts
  install_units
  log "building the behold and driver images"
  compose build
  cmd_start_driver
  wait_bootstrap
  cmd_up
}

cmd_pause() {
  echo paused > "$STATE/driver-mode"
  compose stop driver
  log "the driver is stopped and stays stopped until '$0 start'"
}

cmd_update_prepare() {
  update_refs "$@"
  mkdir -p "$ROOT" "$ROOT/views"
  checkout behold "$(conf BEHOLD_REF main)"
  fetch_terragucci
  # The checkout may have moved this script; carry on from the new one.
  exec "$ROOT/behold/deploy/demo-host/demo-host.sh" update-prepare-rest
}

cmd_update_prepare_rest() {
  install_units
  log "building the behold and driver images; the loop and the site carry on"
  compose build
  log "prepared: behold $(conf BEHOLD_REF main); update moves terragucci to $(conf TERRAGUCCI_REF main) at a quiet step"
}

cmd_update() {
  update_refs "$@"
  mkdir -p "$ROOT" "$ROOT/views"
  checkout behold "$(conf BEHOLD_REF main)"
  fetch_terragucci
  # The checkout may have moved this script; carry on from the new one.
  exec "$ROOT/behold/deploy/demo-host/demo-host.sh" update-rest
}

cmd_update_rest() {
  install_units
  compose build
  clear_strays
  # Everything above runs while the loop does. The driver reads the terragucci
  # checkout as it runs, so that moves only once the driver is stopped, at a
  # quiet step.
  wait_quiet
  compose stop driver
  checkout terragucci "$(conf TERRAGUCCI_REF main)"
  # A new terragucci commit makes driver-entry.sh run the bootstrap again.
  compose up -d --force-recreate driver
  # behold is recreated only when its image or settings changed.
  compose up -d
  if caddy_current; then log "Caddy's Caddyfile is unchanged; Caddy keeps running"; else cmd_reload_caddy; fi
  running_as_named
  log "updated: terragucci $(conf TERRAGUCCI_REF main), behold $(conf BEHOLD_REF main)"
  # The images of the release before are no longer needed: clean up now, in
  # the background (journalctl -u demo-host-cleanup), rather than at 04:00.
  systemctl start --no-block demo-host-cleanup.service || log "could not start demo-host-cleanup.service"
}

cmd_cleanup() {
  "$HERE/cleanup.sh"
}

cmd_open() {
  [ -f "$ETC/caddy/password.caddy" ] || { log "the site has no password already"; return 0; }
  mv "$ETC/caddy/password.caddy" "$ETC/caddy/password.caddy.off"
  docker exec demo-host-caddy caddy reload --config /etc/caddy/Caddyfile
  log "the password is off: https://$(conf DEMO_HOSTNAME demo.intentius.io) is open to everyone"
}

cmd_close() {
  [ -f "$ETC/caddy/password.caddy.off" ] || die "no password.caddy.off to put back"
  mv "$ETC/caddy/password.caddy.off" "$ETC/caddy/password.caddy"
  docker exec demo-host-caddy caddy reload --config /etc/caddy/Caddyfile
  log "the password is back on"
}

cmd_status() {
  local reports
  reports="$(conf DEMO_REPORTS s3://demo-reports/demo)"
  compose ps
  docker ps --filter "name=^terragucci-" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
  echo
  echo "demo.json:"
  curl -fsS -m 10 "http://127.0.0.1:$(conf TERRAGUCCI_FLOCI_PORT 4580)/${reports#s3://}/demo.json" | jq . 2>/dev/null || echo "  (none yet)"
  echo
  echo "last stalls (/var/log/demo-host/stalls.log):"
  tail -n 10 /var/log/demo-host/stalls.log 2>/dev/null || echo "  (none)"
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    bootstrap) need_root; cmd_bootstrap "$@" ;;
    bootstrap-rest) need_root; cmd_bootstrap_rest "$@" ;;
    start) need_root; cmd_start ;;
    pause) need_root; cmd_pause ;;
    update-prepare) need_root; cmd_update_prepare "$@" ;;
    update-prepare-rest) need_root; cmd_update_prepare_rest ;;
    update) need_root; cmd_update "$@" ;;
    update-rest) need_root; cmd_update_rest ;;
    open) need_root; cmd_open ;;
    close) need_root; cmd_close ;;
    status) need_root; cmd_status ;;
    install) need_root; cmd_install ;;
    checkout-self) need_root; cmd_checkout_self "$@" ;;
    configure) need_root; write_env "$(secrets_arg "$@")" ;;
    checkouts) need_root; checkouts ;;
    units) need_root; install_units ;;
    build) need_root; log "building the behold and driver images"; compose build ;;
    start-driver) need_root; cmd_start_driver ;;
    wait-bootstrap) need_root; wait_bootstrap ;;
    up) need_root; cmd_up ;;
    reload-caddy) need_root; cmd_reload_caddy ;;
    clear-strays) need_root; clear_strays ;;
    cleanup) need_root; cmd_cleanup ;;
    *) sed -n '3,/^set -/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 2 ;;
  esac
}

# The whole script is read before main runs, so moving the checkout under it
# (update) cannot change what this run executes.
{ main "$@"; exit $?; }
