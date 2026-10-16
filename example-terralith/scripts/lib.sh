# Shared by terralith-up.sh and terralith-step.sh. Sourced, never run.
#
# Every phase ends in a snapshot: choudoufu's own documents for each root,
# written as files under snapshots/<n>-<phase>/, and phase.json written last.
# behold reads those files (src/terralith-demo.ts) and nothing else, so the
# walkthrough shows what the tool printed, and the same files can come from a
# pipeline instead of this script.

CONTAINER="${TERRALITH_CONTAINER:-behold-terralith-floci}"
PORT="${TERRALITH_PORT:-4652}"
# choudoufu's own pin (live/floci-image in the choudoufu repo).
IMAGE="ghcr.io/lex00/floci@sha256:ff46eb8d1b73a9727948d1a194a660972e44cc64164a486548da7cb468a09144"
CHOUDOUFU="${CHOUDOUFU_BIN:-choudoufu}"
BUCKET=terralith-state

export AWS_ENDPOINT_URL="http://127.0.0.1:${PORT}"
export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1
export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$HOME/.terraform.d/plugin-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"

say() { printf '%s\n' "→ $*"; }
die() { printf 'terralith demo: %s\n' "$*" >&2; exit 1; }

need_choudoufu() {
  command -v "$CHOUDOUFU" >/dev/null 2>&1 || die "${CHOUDOUFU} is not on PATH. Install choudoufu 0.28.0 or newer (https://github.com/INTENTIUS/choudoufu/releases), or set CHOUDOUFU_BIN."
}

# The estate a root's live block names, or nothing for a stock root.
estate_of() {
  sed -n '/^  live {/,/^  }/s/^ *estate *= *"\(.*\)"/\1/p' "$1/main.tf" | head -1
}

# snap <phase dir> <root>: the root's documents, as choudoufu printed them.
snap() {
  local dir="$1" root="$2" out estate
  out="$PWD/$dir/$root"
  mkdir -p "$out"
  (cd "$root" && "$CHOUDOUFU" live-check -json >"$out/live-check.json" 2>"$out/live-check.err") || true
  estate="$(estate_of "$root")"
  if [ -z "$estate" ]; then
    (cd "$root" && "$CHOUDOUFU" show -json -no-color >"$out/state.json" 2>"$out/state.err") || true
  else
    (cd "$root" && "$CHOUDOUFU" live-ls -estate="$estate" -consistent -json . >"$out/live-ls.json" 2>"$out/live-ls.err") || true
    (cd "$root" && "$CHOUDOUFU" live-plan -json >"$out/live-plan.json" 2>"$out/live-plan.err") || true
  fi
}

# finish <phase dir> <phase> <n> <roots...>: phase.json, written last, so a
# reader never sees half a phase.
finish() {
  local dir="$1" phase="$2" n="$3"
  shift 3
  local roots="" r
  for r in "$@"; do roots="${roots:+$roots, }\"$r\""; done
  local version
  version="$("$CHOUDOUFU" version 2>/dev/null | head -1 | sed 's/"/\\"/g')"
  printf '{\n  "phase": "%s",\n  "n": %s,\n  "at": "%s",\n  "choudoufu": "%s",\n  "roots": [%s]\n}\n' \
    "$phase" "$n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$version" "$roots" >"$PWD/$dir/phase.json.tmp"
  mv "$PWD/$dir/phase.json.tmp" "$dir/phase.json"
}

init_root() {
  (cd "$1" && "$CHOUDOUFU" init -input=false -no-color "${@:2}" >/dev/null) || die "choudoufu init failed in $1"
}
