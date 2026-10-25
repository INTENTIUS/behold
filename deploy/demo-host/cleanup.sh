#!/usr/bin/env bash
#
# The demo host's disk cleanup (behold#571, #603). demo-host-cleanup.timer
# runs it daily, and `demo-host.sh update` starts it once more after an update
# that succeeded. Run as root. It removes:
#
#   - terragucci's CI images (ghcr.io/intentius/terragucci-{tofu,terraform,
#     terragrunt,choudoufu}) of any version but the one the host runs. The
#     version is TERRAGUCCI_REF from demo.env when that is a release tag
#     (v0.4.32), and the terragucci checkout's packages/terragucci/package.json
#     otherwise (a branch or a commit). When the two differ, both are kept.
#     When neither names a version, no CI image is removed.
#   - dangling images: unnamed (<none>:<none>) and used by no container;
#   - BuildKit's cache past DEMO_BUILD_CACHE_MAX (default 12GB);
#   - stopped containers older than DEMO_CLEANUP_CONTAINER_AGE (default 24h)
#     that no compose project made, such as a Forgejo job's container left
#     behind;
#   - the journal past DEMO_JOURNAL_MAX (default 500M).
#
# It never removes a volume (named or not), a running or a compose service's
# container, an image any container uses, or an image tagged :local (the
# behold, driver and demo job images the loop builds). Every image is removed
# with a plain `docker rmi`, which Docker refuses for an image a container
# uses, so a container that starts between the listing and the removal keeps
# its image too. test: src/demo-host-cleanup.test.ts.
#
# It logs the disk and `docker system df` before and after, and what it
# removed, to the journal (journalctl -u demo-host-cleanup) and to
# /var/log/demo-host/cleanup.log. When the root disk is still over
# DEMO_DISK_WARN percent (default 85) afterwards, it says so on every log,
# writes it to /var/log/demo-host/stalls.log and /var/lib/demo-host/disk.status
# (which the watchdog logs), and exits 3, so `systemctl --failed` lists it.
set -uo pipefail

ENV_FILE="${DEMO_ENV_FILE:-/etc/demo-host/demo.env}"
ROOT="${DEMO_ROOT:-/opt/demo}"
STATE="${DEMO_STATE_DIR:-/var/lib/demo-host}"
LOG_DIR="${DEMO_LOG_DIR:-/var/log/demo-host}"

conf() { # name, default: a value from demo.env, read without sourcing it
  local v=""
  [ -f "$ENV_FILE" ] && v="$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -1)"
  v="${v%\"}"; v="${v#\"}"
  printf '%s' "${v:-$2}"
}

BUILD_CACHE_MAX="$(conf DEMO_BUILD_CACHE_MAX 12GB)"
JOURNAL_MAX="$(conf DEMO_JOURNAL_MAX 500M)"
DISK_WARN="$(conf DEMO_DISK_WARN 85)"
CONTAINER_AGE="$(conf DEMO_CLEANUP_CONTAINER_AGE 24h)"
# The repositories of terragucci's CI images (terragucci's images/ and
# stack/demo.sh up, which builds them on the host under these names).
CI_REPOS='^ghcr\.io/intentius/terragucci-(tofu|terraform|terragrunt|choudoufu)$'

mkdir -p "$LOG_DIR" "$STATE" 2>/dev/null || true
LOG="$LOG_DIR/cleanup.log"

log() {
  echo "[cleanup] $*"
  echo "$(date -u +%FT%TZ) $*" >> "$LOG" 2>/dev/null || true
}

disk_used() { # percent of / in use, digits only
  df -P / | awk 'NR == 2 { sub(/%/, "", $5); print $5 }'
}

report() { # when: the disk and Docker's own accounting
  log "$1: $(df -h -P / | awk 'NR == 2 { print $3 " of " $2 " used (" $5 "), " $4 " free" }')"
  docker system df 2>&1 | while IFS= read -r line; do log "$1:   $line"; done
}

# The terragucci versions whose CI images stay, one a line.
keep_versions() {
  local ref pkg
  ref="$(conf TERRAGUCCI_REF main)"
  case "$ref" in
    v[0-9]*.[0-9]*.[0-9]*) echo "${ref#v}" ;;
  esac
  pkg="$ROOT/terragucci/packages/terragucci/package.json"
  if [ -r "$pkg" ]; then
    jq -r '.version // empty' "$pkg" 2>/dev/null || true
  fi
}

# The image ids every container, running or stopped, was made from.
used_images() {
  local ids
  ids="$(docker ps -aq --no-trunc 2>/dev/null)" || return 1
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086 # one argument per container id
  docker inspect --format '{{.Image}}' $ids
}

remove_old_ci_images() {
  local versions used id repo tag v keep removed=0
  versions="$(keep_versions | sort -u | grep -v '^$' || true)"
  if [ -z "$versions" ]; then
    log "CI images: no version from TERRAGUCCI_REF ($(conf TERRAGUCCI_REF main)) or $ROOT/terragucci/packages/terragucci/package.json; removing none"
    return 0
  fi
  log "CI images: keeping terragucci $(echo "$versions" | paste -sd' ' -)"
  used="$(used_images)" || { log "CI images: could not list the containers' images; removing none"; return 0; }
  while read -r id repo tag; do
    [ -n "$id" ] || continue
    [[ "$repo" =~ $CI_REPOS ]] || continue
    [ "$tag" != "<none>" ] || continue
    case "$tag" in *local) continue ;; esac
    keep=""
    while read -r v; do
      case "$tag" in "$v"|"$v"-*) keep=1 ;; esac
    done <<<"$versions"
    [ -z "$keep" ] || continue
    if grep -qxF "$id" <<<"$used"; then
      log "CI images: $repo:$tag is used by a container; kept"
      continue
    fi
    if docker rmi "$repo:$tag" >/dev/null 2>&1; then
      log "CI images: removed $repo:$tag"
      removed=$((removed + 1))
    else
      log "CI images: docker would not remove $repo:$tag; kept"
    fi
  done < <(docker images --no-trunc --format '{{.ID}} {{.Repository}} {{.Tag}}')
  log "CI images: removed $removed"
}

remove_dangling_images() {
  local used id repo tag removed=0
  used="$(used_images)" || { log "dangling images: could not list the containers' images; removing none"; return 0; }
  while read -r id repo tag; do
    [ -n "$id" ] || continue
    # Unnamed only. An image pulled by digest (postgres@sha256:…) lists as
    # <repo> <none> and is no build's leftover.
    [ "$repo" = "<none>" ] || continue
    if grep -qxF "$id" <<<"$used"; then continue; fi
    if docker rmi "$id" >/dev/null 2>&1; then
      removed=$((removed + 1))
    fi
  done < <(docker images --no-trunc --filter dangling=true --format '{{.ID}} {{.Repository}} {{.Tag}}')
  log "dangling images: removed $removed"
}

prune_build_cache() {
  local flag=--keep-storage
  # buildx 0.17 and later name the cap --max-used-space; --keep-storage is
  # the older client's name for it.
  if docker builder prune --help 2>/dev/null | grep -q -- '--max-used-space'; then flag=--max-used-space; fi
  if docker builder prune --force "$flag" "$BUILD_CACHE_MAX" >/dev/null 2>&1; then
    log "build cache: pruned to $BUILD_CACHE_MAX ($flag)"
  else
    log "build cache: docker builder prune $flag $BUILD_CACHE_MAX failed"
  fi
}

prune_containers() {
  # Stopped containers only (prune never touches a running one), older than
  # CONTAINER_AGE, and none that a compose project made: the services of
  # terragucci's stack and of this host stay, stopped or not.
  local out
  if out="$(docker container prune --force --filter "until=$CONTAINER_AGE" --filter 'label!=com.docker.compose.project' 2>&1)"; then
    log "stopped containers older than $CONTAINER_AGE: $(tail -1 <<<"$out")"
  else
    log "stopped containers: docker container prune failed: $out"
  fi
}

vacuum_journal() {
  local out
  if out="$(journalctl --vacuum-size="$JOURNAL_MAX" 2>&1)"; then
    log "journal: vacuumed to $JOURNAL_MAX: $(tail -1 <<<"$out")"
  else
    log "journal: journalctl --vacuum-size=$JOURNAL_MAX failed: $out"
  fi
}

unused_volumes() { # reported, never removed
  local n
  n="$(docker volume ls -q --filter dangling=true 2>/dev/null | wc -l | tr -d ' ')"
  [ "${n:-0}" = 0 ] || log "volumes: $n volume(s) no container uses; left as they are (docker volume ls --filter dangling=true)"
}

main() {
  local used status=0 line
  report before
  remove_old_ci_images
  prune_containers
  remove_dangling_images
  prune_build_cache
  vacuum_journal
  unused_volumes
  report after
  used="$(disk_used)"
  if [ -n "$used" ] && [ "$used" -gt "$DISK_WARN" ]; then
    line="DISK ${used}% used after cleanup, over DEMO_DISK_WARN=${DISK_WARN}%: see $LOG and docker system df -v"
    log "WARNING: $line"
    echo "[cleanup] WARNING: $line" >&2
    echo "$(date -u +%FT%TZ) $line" >> "$LOG_DIR/stalls.log" 2>/dev/null || true
    echo "over $(date -u +%FT%TZ) $line" > "$STATE/disk.status" 2>/dev/null || true
    status=3
  else
    echo "ok $(date -u +%FT%TZ) ${used:-?}% used after cleanup" > "$STATE/disk.status" 2>/dev/null || true
  fi
  return "$status"
}

main "$@"
