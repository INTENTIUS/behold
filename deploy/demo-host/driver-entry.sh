#!/usr/bin/env bash
#
# The driver container's entry (#570). Runs in demo-host-driver, on the host's
# network, with the host's Docker socket and the terragucci checkout mounted.
#
#   1. Installs the terragucci checkout's node_modules when its lockfile
#      changed, and builds its CLI.
#   2. Runs the driver's bootstrap, terragucci's `stack/demo.sh up`, when
#      floci has no base for this checkout's commit. floci keeps everything in
#      memory, so after a reboot or a floci restart the states, the reports and
#      the reader below are gone, and the bootstrap runs again. It also runs
#      again when TERRAGUCCI_REF moved the checkout (demo-host.sh update).
#   3. After a bootstrap, gives behold what it reads with: floci keys that may
#      only GetObject and ListBucket on the reports prefix (enforced once
#      floci's IAM enforcement is on; see compose.yaml), a Forgejo token that may only read
#      the demo repo, and the view checkout (/view) with that token in origin.
#   4. Hands over to the loop: `exec stack/demo.sh loop`.
#
# If any step fails the container exits, Docker restarts it (restart:
# unless-stopped), and the watchdog logs the restart.
set -euo pipefail

TG="${TERRAGUCCI_SRC:?TERRAGUCCI_SRC names the terragucci checkout}"
FORGEJO="http://127.0.0.1:${TERRAGUCCI_FORGEJO_PORT:-3300}"
FLOCI="http://127.0.0.1:${TERRAGUCCI_FLOCI_PORT:-4580}"
REPO="${DEMO_REPO:-terragucci-admin/demo}"
REPORTS="${DEMO_REPORTS:-s3://demo-reports/demo}"
VIEWER="${DEMO_VIEWER_USER:-demo-viewer}"
STATE=/var/lib/demo-host
VIEW=/view
# The node user of behold's image, which runs behold.
BEHOLD_UID=1000

log() { echo "[driver-entry] $(date -u +%FT%TZ) $*" >&2; }
die() { log "FAIL: $*"; exit 1; }

# The checkout is root's on the host and here; /view is behold's.
git config --global --replace-all safe.directory '*'

cd "$TG"
HEAD_SHA="$(git rev-parse HEAD)"

# ── 1. node_modules and the CLI ────────────────────────────────────────────
lock_sum="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ "$(cat node_modules/.demo-host-lock 2>/dev/null || true)" != "$lock_sum" ]; then
  log "installing terragucci's node_modules (package-lock.json changed)"
  npm ci --no-audit --no-fund >&2
  echo "$lock_sum" > node_modules/.demo-host-lock
fi
# The terragucci CLI is packages/terragucci/dist/terragucci.mjs, which only a
# build writes, so npm ci on a fresh checkout links no node_modules/.bin/terragucci.
# Build it for each checkout commit and link it, as `just build-cli` does on a laptop.
if [ "$(cat node_modules/.demo-host-cli 2>/dev/null || true)" != "$HEAD_SHA" ] || [ ! -f packages/terragucci/dist/terragucci.mjs ]; then
  log "building the terragucci CLI at ${HEAD_SHA:0:8}"
  node scripts/build-cli.mjs >&2
  echo "$HEAD_SHA" > node_modules/.demo-host-cli
fi
ln -sfn ../@intentius/terragucci/dist/terragucci.mjs node_modules/.bin/terragucci
chmod +x packages/terragucci/dist/terragucci.mjs

# ── 3. what behold reads with ──────────────────────────────────────────────
iam() { # Action, then Key=Value pairs: one signed IAM query call to floci as its root key
  local action="$1" kv args=()
  shift
  for kv in "$@"; do args+=(--data-urlencode "$kv"); done
  curl -fsS --aws-sigv4 "aws:amz:us-east-1:iam" -u test:test \
    --data-urlencode "Action=$action" --data-urlencode "Version=2010-05-08" "${args[@]}" "$FLOCI/"
}

xml_field() { # name: the first <name>value</name> on stdin
  tr -d '\n' | grep -o "<$1>[^<]*" | head -1 | sed 's/^<[^>]*>//'
}

reader_keys() {
  local rest bucket prefix policy out id secret dir="$STATE/behold"
  rest="${REPORTS#s3://}"
  bucket="${rest%%/*}"
  prefix=""
  [ "$rest" = "$bucket" ] || prefix="${rest#*/}"
  prefix="${prefix%/}"
  # GetObject on the prefix's objects, and ListBucket limited to the prefix,
  # so an object not written yet answers 404 (missing) rather than 403
  # (denied). Decided on #570.
  policy="$(jq -cn --arg obj "arn:aws:s3:::$bucket${prefix:+/$prefix}/*" --arg bucket "arn:aws:s3:::$bucket" \
    --arg p "${prefix:+$prefix/}*" \
    '{Version: "2012-10-17", Statement: [
       {Effect: "Allow", Action: ["s3:GetObject"], Resource: [$obj]},
       {Effect: "Allow", Action: ["s3:ListBucket"], Resource: [$bucket], Condition: {StringLike: {"s3:prefix": [$p]}}}]}')"
  # An existing user (floci kept it) answers 409; the policy and a new key follow either way.
  iam CreateUser "UserName=behold-reader" >/dev/null 2>&1 || true
  iam PutUserPolicy "UserName=behold-reader" "PolicyName=reports-read" "PolicyDocument=$policy" >/dev/null \
    || die "floci refused the reader's policy"
  # A user floci kept from an earlier bootstrap still holds that run's keys, and
  # IAM allows two, so the old ones go before a new one is made. behold is
  # restarted on the new key, so nothing still reads with an old one.
  local old
  for old in $(iam ListAccessKeys "UserName=behold-reader" 2>/dev/null | tr -d '\n' | grep -o '<AccessKeyId>[^<]*' | sed 's/^<AccessKeyId>//'); do
    iam DeleteAccessKey "UserName=behold-reader" "AccessKeyId=$old" >/dev/null || die "floci kept the reader's old key $old"
  done
  out="$(iam CreateAccessKey "UserName=behold-reader")" || die "floci made no key for the reader"
  id="$(xml_field AccessKeyId <<<"$out")"
  secret="$(xml_field SecretAccessKey <<<"$out")"
  [ -n "$id" ] && [ -n "$secret" ] || die "floci's CreateAccessKey answer had no key: $out"
  mkdir -p "$dir"
  ( umask 077; printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\n' "$id" "$secret" > "$dir/behold-s3.env.new" )
  chown "$BEHOLD_UID:$BEHOLD_UID" "$dir" "$dir/behold-s3.env.new"
  mv "$dir/behold-s3.env.new" "$dir/behold-s3.env"
  log "behold reads $REPORTS with floci key $id (s3:GetObject and s3:ListBucket on $bucket${prefix:+/$prefix}/ only)"
}

viewer_token() { # prints a working read:repository token for $VIEWER, making the user and token as needed
  local env="$STATE/viewer.env" pw="" token="" admin out
  # The admin token stack/bootstrap.sh minted.
  admin="$(sed -n 's/^export TERRAGUCCI_FORGEJO_TOKEN=//p' "$TG/stack/.state/forgejo.env" 2>/dev/null || true)"
  [ -n "$admin" ] || die "no admin token in stack/.state/forgejo.env; the bootstrap did not finish"
  if [ -f "$env" ]; then
    pw="$(sed -n 's/^DEMO_VIEWER_PASSWORD=//p' "$env")"
    token="$(sed -n 's/^DEMO_VIEWER_TOKEN=//p' "$env")"
  fi
  if [ -z "$pw" ]; then
    pw="v$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 28)9Z"
    token=""
  fi
  if ! curl -fsS -o /dev/null -H "Authorization: token $admin" "$FORGEJO/api/v1/users/$VIEWER" 2>/dev/null; then
    curl -fsS -o /dev/null -H "Authorization: token $admin" -H 'content-type: application/json' -X POST \
      -d "$(jq -cn --arg u "$VIEWER" --arg p "$pw" '{username: $u, email: ($u + "@demo.invalid"), password: $p, must_change_password: false}')" \
      "$FORGEJO/api/v1/admin/users" || die "could not create the Forgejo user $VIEWER"
    token=""
  fi
  # Read access to the demo repo, whether or not the repo is public.
  curl -fsS -o /dev/null -H "Authorization: token $admin" -H 'content-type: application/json' -X PUT \
    -d '{"permission":"read"}' "$FORGEJO/api/v1/repos/$REPO/collaborators/$VIEWER" \
    || die "could not give $VIEWER read access to $REPO"
  if [ -z "$token" ] || ! curl -fsS -o /dev/null -H "Authorization: token $token" "$FORGEJO/api/v1/repos/$REPO" 2>/dev/null; then
    out="$(curl -fsS -u "$VIEWER:$pw" -H 'content-type: application/json' -X POST \
      -d "$(jq -cn --arg n "behold-$(date +%s)" '{name: $n, scopes: ["read:repository"]}')" \
      "$FORGEJO/api/v1/users/$VIEWER/tokens")" || die "could not mint a read-only token for $VIEWER"
    token="$(jq -r '.sha1 // empty' <<<"$out")"
    [ -n "$token" ] || die "Forgejo's token answer had no token: $out"
  fi
  ( umask 077; printf 'DEMO_VIEWER_PASSWORD=%s\nDEMO_VIEWER_TOKEN=%s\n' "$pw" "$token" > "$env.new" )
  mv "$env.new" "$env"
  printf '%s' "$token"
}

view_checkout() { # token
  local here="http://$VIEWER:$1@127.0.0.1:${TERRAGUCCI_FORGEJO_PORT:-3300}/$REPO.git"
  # behold's own fetch of chant/lifecycle goes over terragucci's network.
  local there="http://$VIEWER:$1@forgejo:3000/$REPO.git"
  if [ ! -d "$VIEW/.git" ]; then
    git clone -q "$here" "$VIEW" || die "could not clone $REPO into the view checkout"
  fi
  git -C "$VIEW" remote set-url origin "$here"
  git -C "$VIEW" fetch -q origin '+refs/heads/*:refs/remotes/origin/*' || die "could not fetch $REPO"
  git -C "$VIEW" checkout -q -B main origin/main
  git -C "$VIEW" reset -q --hard origin/main
  git -C "$VIEW" remote set-url origin "$there"
  chown -R "$BEHOLD_UID:$BEHOLD_UID" "$VIEW"
  log "view checkout at $(git -C "$VIEW" rev-parse --short HEAD) ($REPO main)"
}

# ── 2. the driver's bootstrap, when floci has no base for this commit ──────
have="$(curl -fsS "$FLOCI/demo-host/bootstrapped" 2>/dev/null || true)"
if [ "$have" != "$HEAD_SHA" ]; then
  if [ -z "$have" ]; then
    log "floci holds no base (first boot, a reboot or a floci restart); running stack/demo.sh up"
  else
    log "the terragucci checkout moved from ${have:0:8} to ${HEAD_SHA:0:8}; running stack/demo.sh up"
  fi
  node scripts/build-cli.mjs >/dev/null
  stack/demo.sh up
  reader_keys
  view_checkout "$(viewer_token)"
  # behold reads its keys when it starts.
  docker restart demo-host-behold >/dev/null 2>&1 || log "demo-host-behold is not running yet; it reads the keys when it starts"
  curl -fsS -o /dev/null -X PUT "$FLOCI/demo-host" 2>/dev/null || true
  printf '%s' "$HEAD_SHA" | curl -fsS -o /dev/null -X PUT --data-binary @- "$FLOCI/demo-host/bootstrapped" \
    || die "could not record the bootstrap in floci"
  log "bootstrapped at terragucci ${HEAD_SHA:0:8}"
fi

# ── 4. the loop ────────────────────────────────────────────────────────────
log "starting the loop"
exec stack/demo.sh loop
