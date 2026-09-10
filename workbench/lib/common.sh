#!/usr/bin/env bash
# Shared helpers for the workbench up scripts (#389, M3 of #386).
#
# Sourced, never run. `behold demo <entry>` runs an entry's up script with cwd
# set to the demo target and two variables in the environment: BEHOLD_DEMO_NAME
# (the catalog entry) and BEHOLD_WORKBENCH_DIR (the directory workbench.json was
# read from, which is this repo's root). The sibling checkouts hang off the
# second — `$BEHOLD_WORKBENCH_DIR/../choudoufu` — so a script means the same
# directory from whatever terminal behold was started in.
#
# Scratch discipline (src/scratch.ts) is asserted here, in bash, because these
# scripts are the boot site: the container is `behold-wb-<entry>`, its host port
# is the entry's own and never a shared emulator's, and only the down.sh this
# file writes into the target removes it.

wb_die() {
  echo "behold workbench: $*" >&2
  exit 1
}

wb_say() { echo "→ $*"; }

# The repo root: what behold hands us, or this file's own ../.. when a person
# runs an up script by hand.
wb_root() {
  if [ -n "${BEHOLD_WORKBENCH_DIR:-}" ]; then
    echo "$BEHOLD_WORKBENCH_DIR"
  else
    (cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  fi
}

# The choudoufu checkout these entries read their generators and image pin from.
wb_choudoufu_checkout() {
  local dir
  dir="$(wb_root)/../choudoufu"
  [ -d "$dir" ] || wb_die "../choudoufu is not checked out (looked in $dir)"
  (cd "$dir" && pwd)
}

# #388's fourth decision: the same binary behold itself spawns. The Homebrew
# release is below behold's 0.16.0 floor, so the build that works is one
# somebody built from main and named with CHOUDOUFU_BIN.
wb_choudoufu() { echo "${CHOUDOUFU_BIN:-choudoufu}"; }

wb_require_bin() {
  command -v "$1" >/dev/null 2>&1 || wb_die "$1 is not on PATH"
}

wb_require_choudoufu() {
  local bin
  bin="$(wb_choudoufu)"
  command -v "$bin" >/dev/null 2>&1 ||
    wb_die "$bin is not on PATH — https://github.com/INTENTIUS/choudoufu (0.16.0 or newer), or set CHOUDOUFU_BIN to a build from main."
}

wb_require_docker() {
  wb_require_bin docker
  docker info >/dev/null 2>&1 || wb_die "Docker is not running — start Docker and re-run."
}

# The emulator image the choudoufu checkout pins. Read at run time, never
# copied here: a pin behold carried separately would be a second pin.
wb_floci_image() {
  local pin
  pin="$(wb_choudoufu_checkout)/live/floci-image"
  [ -f "$pin" ] || wb_die "no floci pin at $pin"
  tr -d '[:space:]' <"$pin"
}

# The scratch name for the entry behold is loading.
wb_container() {
  [ -n "${BEHOLD_DEMO_NAME:-}" ] || wb_die "BEHOLD_DEMO_NAME is unset — this script runs as a behold demo setup."
  echo "behold-wb-${BEHOLD_DEMO_NAME}"
}

# src/scratch.ts in bash. A workbench emulator is named behold-wb-<entry>,
# which no protected name can match, and it never binds a shared emulator's
# port. Both are checked before the docker run that would create the thing.
wb_assert_scratch() {
  local name="$1" port="$2"
  case "$name" in
    behold-wb-?*) ;;
    *) wb_die "scratch discipline: a workbench emulator is named behold-wb-<entry>, got '$name'" ;;
  esac
  case " 4566 4577 4588 " in
    *" $port "*) wb_die "scratch discipline: port $port belongs to a shared emulator — a scratch substrate gets its own" ;;
  esac
}

# Boot the entry's floci, or reuse the one already running under our own name.
#
# Running: reused, so a second `behold demo <entry>` restarts the serve against
# the estate it already applied. Present but stopped: refused, because its
# emulated cloud is gone while the record store and state on disk still claim
# those resources — down.sh, and re-run.
wb_floci_up() {
  local name="$1" port="$2" image
  wb_assert_scratch "$name" "$port"
  wb_require_docker
  if docker ps --format '{{.Names}}' | grep -qx "$name"; then
    wb_say "reusing the scratch floci already running: ${name} on 127.0.0.1:${port}"
    return 0
  fi
  if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then
    wb_die "container ${name} exists but is not running — its emulated cloud is gone while this target's records still name those resources. \`bash scripts/down.sh\` in $PWD, then re-run."
  fi
  image="$(wb_floci_image)"
  wb_say "floci on 127.0.0.1:${port} (${name})"
  wb_say "image ${image} — the pin in ../choudoufu/live/floci-image"
  docker run -d --name "$name" -p "127.0.0.1:${port}:4566" "$image" >/dev/null
  local i
  for i in $(seq 1 90); do
    curl -fs -o /dev/null "http://127.0.0.1:${port}/" && break
    sleep 1
  done
  curl -fs -o /dev/null "http://127.0.0.1:${port}/" ||
    wb_die "floci on 127.0.0.1:${port} never answered — \`docker logs ${name}\`, then \`bash scripts/down.sh\`."
}

# The credentials floci accepts, and the endpoint this entry's estates talk to.
# The same four the entry's `serve.spawnEnv` gives behold's own choudoufu reads.
wb_export_aws() {
  export AWS_ENDPOINT_URL="http://127.0.0.1:$1"
  export AWS_ACCESS_KEY_ID=test
  export AWS_SECRET_ACCESS_KEY=test
  export AWS_REGION=us-east-1
}

# Write the matching down script into the target (#386's third decision: the up
# script leaves behind the one that tears its scratch down). It removes OUR
# container by name and nothing else; the rendered estate stays, because it is
# yours to edit.
wb_write_down() {
  local name="$1"
  mkdir -p scripts
  cat >scripts/down.sh <<EOF
#!/usr/bin/env bash
# Tear this workbench entry's scratch emulator down: remove ${name}, by that
# name and no other (behold's scratch discipline, src/scratch.ts). Written by
# the entry's up script; the rendered estate stays, it is yours to edit.
set -euo pipefail
docker rm -f ${name} >/dev/null 2>&1 || true
echo "behold workbench: ${name} removed."
EOF
  chmod +x scripts/down.sh
}

# The types `choudoufu live-check -json` refuses in this directory, one
# "<count><tab><type>" line each. node, not jq: behold runs on node, so every
# machine that can run a demo can run this.
wb_refused_types() {
  "$(wb_choudoufu)" live-check -json . 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let doc;
      try { doc = JSON.parse(s); } catch { return; }
      const counts = {};
      for (const i of doc.instances ?? []) if (i.refused) counts[i.type ?? "?"] = (counts[i.type ?? "?"] ?? 0) + 1;
      for (const [t, n] of Object.entries(counts).sort()) console.log(`${n}\t${t}`);
    });'
}

# How many instances `live-check` sees here — the roster behold's estate box
# draws a card per.
wb_instance_count() {
  "$(wb_choudoufu)" live-check -json . 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { console.log((JSON.parse(s).instances ?? []).length); } catch { console.log(0); }
    });'
}
