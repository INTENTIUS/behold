#!/usr/bin/env bash
# behold#1032: run an emulator e2e with no real cloud in reach.
#
# As a wrapper (the usual way):
#
#   bash e2e/lib/safe-env.sh bash e2e/three-cloud-change-set-e2e.sh
#   FLOCI_PORT=4761 FLOCI_AZ_PORT=4762 FLOCI_GCP_PORT=4763 \
#     bash e2e/lib/safe-env.sh bash e2e/multi-engine-demo-e2e.sh
#
# it clears the environment below, runs the command with its output copied
# to a log, then scans that log for a real cloud turning the run away. A hit
# fails the run (exit 3) even when the command itself passed: a request
# reached a public endpoint, which no emulator run may do.
#
# Sourced (`. e2e/lib/safe-env.sh`), it only clears the environment of the
# calling shell and defines behold_e2e_scan_log <log>; the caller scans.
# `bash e2e/lib/safe-env.sh --scan <log>` scans a log written elsewhere.
#
# What it clears:
#   - GCP: GOOGLE_APPLICATION_CREDENTIALS and the other credential and token
#     variables are unset, and CLOUDSDK_CONFIG names an empty directory, so
#     neither gcloud nor google-auth finds application-default credentials.
#   - AWS: keys, session token, profile, web identity and container
#     credentials are unset; AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE
#     name empty files; the instance metadata lookup is off. A script that
#     talks to floci sets its own test keys after this.
#   - Azure: ARM_* and AZURE_* client, tenant, subscription and federated
#     token variables are unset, and AZURE_CONFIG_DIR names an empty
#     directory, so no `az login` session is found.
#   - Pulumi: PULUMI_ACCESS_TOKEN is unset, PULUMI_BACKEND_URL names an
#     empty file backend (a file:// one the caller set is kept), and
#     PULUMI_SKIP_UPDATE_CHECK is true.
#
# Scratch lives under BEHOLD_SAFE_ENV_DIR (default: a new mktemp -d under
# the default TMPDIR); the log is BEHOLD_SAFE_ENV_LOG (default: run.log in
# that directory). TMPDIR itself is left alone: a long TMPDIR breaks the
# provider plugin handshake in choudoufu apply.

behold_e2e_safe_env() {
  local dir="${BEHOLD_SAFE_ENV_DIR:-}"
  if [ -z "$dir" ]; then
    dir=$(mktemp -d "${TMPDIR:-/tmp}/behold-safe-env.XXXXXX") || return 1
  fi
  mkdir -p "$dir/gcloud" "$dir/azure" "$dir/aws" "$dir/pulumi-backend" || return 1
  : >"$dir/aws/config"
  : >"$dir/aws/credentials"
  BEHOLD_SAFE_ENV_DIR="$dir"
  export BEHOLD_SAFE_ENV_DIR

  unset GOOGLE_APPLICATION_CREDENTIALS GOOGLE_CREDENTIALS GOOGLE_CLOUD_KEYFILE_JSON GCLOUD_KEYFILE_JSON \
    GOOGLE_OAUTH_ACCESS_TOKEN CLOUDSDK_AUTH_ACCESS_TOKEN CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE \
    GOOGLE_IMPERSONATE_SERVICE_ACCOUNT CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN \
    AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ROLE_ARN AWS_ROLE_SESSION_NAME AWS_WEB_IDENTITY_TOKEN_FILE \
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_CONTAINER_AUTHORIZATION_TOKEN \
    AWS_SSO_SESSION AWS_CREDENTIAL_EXPIRATION
  unset ARM_CLIENT_ID ARM_CLIENT_SECRET ARM_TENANT_ID ARM_SUBSCRIPTION_ID ARM_CLIENT_CERTIFICATE_PATH \
    ARM_CLIENT_CERTIFICATE_PASSWORD ARM_OIDC_TOKEN ARM_OIDC_TOKEN_FILE_PATH ARM_USE_MSI ARM_USE_OIDC ARM_ACCESS_KEY \
    AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TENANT_ID AZURE_SUBSCRIPTION_ID AZURE_CLIENT_CERTIFICATE_PATH \
    AZURE_CLIENT_CERTIFICATE_PASSWORD AZURE_FEDERATED_TOKEN_FILE AZURE_USERNAME AZURE_PASSWORD \
    AZURE_STORAGE_KEY AZURE_STORAGE_CONNECTION_STRING AZURE_STORAGE_SAS_TOKEN
  unset PULUMI_ACCESS_TOKEN

  export CLOUDSDK_CONFIG="$dir/gcloud"
  export AZURE_CONFIG_DIR="$dir/azure"
  export AWS_CONFIG_FILE="$dir/aws/config" AWS_SHARED_CREDENTIALS_FILE="$dir/aws/credentials"
  export AWS_EC2_METADATA_DISABLED=true
  case "${PULUMI_BACKEND_URL:-}" in
    file://*) ;;
    *) export PULUMI_BACKEND_URL="file://$dir/pulumi-backend" ;;
  esac
  export PULUMI_SKIP_UPDATE_CHECK=true
}

# A public cloud's own rejection of a request. Every one names a real
# endpoint having been reached: floci answers none of these.
BEHOLD_REAL_CLOUD_ERRORS='UnrecognizedClientException|InvalidClientTokenId|invalid_grant|AADSTS[0-9]+|CREDENTIALS_MISSING'
# A 401 counts when the same line names a public cloud host.
BEHOLD_REAL_CLOUD_HOSTS='googleapis\.com|amazonaws\.com|amazonaws\.com\.cn|azure\.com|azure\.net|windows\.net|microsoftonline\.com'

# behold_e2e_scan_log <log>: prints each line of <log> that shows a real cloud
# rejecting a request and returns 1 when there is one, 0 when there is none.
behold_e2e_scan_log() {
  local log="$1" hits
  [ -f "$log" ] || { echo "safe-env: no log at $log to scan" >&2; return 2; }
  hits=$(
    grep -nE "$BEHOLD_REAL_CLOUD_ERRORS" "$log"
    grep -nE "$BEHOLD_REAL_CLOUD_HOSTS" "$log" | grep -E '(^|[^0-9])401([^0-9]|$)'
  )
  if [ -n "$hits" ]; then
    {
      echo
      echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
      echo "safe-env: REAL-CLOUD REJECTION in $log"
      echo "a request reached a public cloud endpoint during an emulator run:"
      printf '%s\n' "$hits" | sort -t: -k1,1n -u | head -40
      echo "stop: find which call left the emulator before running again."
      echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    } >&2
    return 1
  fi
  echo "safe-env: no real-cloud rejection in $log"
  return 0
}

# Sourced: clear the caller's environment and stop here.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  behold_e2e_safe_env
  return $?
fi

set -uo pipefail
if [ "${1:-}" = "--scan" ]; then
  [ $# -eq 2 ] || { echo "usage: safe-env.sh --scan <log>" >&2; exit 2; }
  behold_e2e_scan_log "$2" || exit 3
  exit 0
fi
if [ $# -eq 0 ]; then
  echo "usage: safe-env.sh <command> [args...]   (e.g. safe-env.sh bash e2e/three-cloud-change-set-e2e.sh)" >&2
  echo "       safe-env.sh --scan <log>" >&2
  exit 2
fi

behold_e2e_safe_env || { echo "safe-env: could not make the scratch directories" >&2; exit 2; }
LOG="${BEHOLD_SAFE_ENV_LOG:-$BEHOLD_SAFE_ENV_DIR/run.log}"
mkdir -p "$(dirname "$LOG")"
echo "safe-env: scratch $BEHOLD_SAFE_ENV_DIR, log $LOG, pulumi backend $PULUMI_BACKEND_URL"
"$@" 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}
echo "safe-env: command exited $rc"
if ! behold_e2e_scan_log "$LOG"; then
  exit 3
fi
exit "$rc"
