#!/usr/bin/env bash
# The demo-host-infra op's steps: the stack demo-intentius-host against
# template.json, through a change set.
#
#   infra.sh plan     create a change set from template.json, print what it
#                     would do on stderr and its digest on stdout (the digest
#                     the gate approves); "sha256:none" when nothing changes
#   infra.sh apply    execute the change set plan made, wait, refuse anything
#                     that would replace a resource
#   infra.sh drift    run drift detection and print each resource's status
#
# Every resource has DeletionPolicy and UpdateReplacePolicy Retain, so no
# change set deletes one. A replacement would still be a new instance or a new
# Elastic IP, so plan and apply refuse any change whose Replacement is not
# False.
set -euo pipefail

STACK="${DEMO_STACK:-demo-intentius-host}"
export AWS_REGION="${AWS_REGION:-us-east-2}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="$HERE/build/infra-change-set"
mkdir -p "$HERE/build"

changes() { # change set name: its changes, canonical
  aws cloudformation describe-change-set --stack-name "$STACK" --change-set-name "$1" --output json \
    | jq -S '[.Changes[].ResourceChange | {Action, LogicalResourceId, PhysicalResourceId, ResourceType, Replacement, Scope, Details}]'
}

refuse_replacement() { # changes json on stdin
  local bad
  bad="$(jq -r '.[] | select((.Replacement // "False") != "False") | "\(.LogicalResourceId) (\(.ResourceType)): Replacement \(.Replacement)"')"
  [ -z "$bad" ] || { echo "refused: this change set would replace a resource of the live host:" >&2; echo "$bad" >&2; return 1; }
}

case "${1:-}" in
  plan)
    name="chant-$(date -u +%Y%m%d%H%M%S)"
    aws cloudformation create-change-set --stack-name "$STACK" --change-set-name "$name" \
      --change-set-type UPDATE --template-body "file://$HERE/template.json" --output text --query Id >/dev/null
    if ! aws cloudformation wait change-set-create-complete --stack-name "$STACK" --change-set-name "$name" 2>/dev/null; then
      reason="$(aws cloudformation describe-change-set --stack-name "$STACK" --change-set-name "$name" --query StatusReason --output text)"
      case "$reason" in
        *"didn't contain changes"*|*"No updates are to be performed"*)
          echo "template.json matches the stack: nothing to change" >&2
          aws cloudformation delete-change-set --stack-name "$STACK" --change-set-name "$name"
          : > "$STATE"
          echo "sha256:none"
          exit 0 ;;
        *) echo "change set $name failed: $reason" >&2; exit 1 ;;
      esac
    fi
    c="$(changes "$name")"
    echo "change set $name:" >&2
    jq -r '.[] | "  \(.Action) \(.LogicalResourceId) (\(.ResourceType)) replacement=\(.Replacement // "-")"' <<<"$c" >&2
    refuse_replacement <<<"$c"
    printf '%s' "$name" > "$STATE"
    printf 'sha256:%s\n' "$( { cat "$HERE/template.json"; printf '%s' "$c"; } | shasum -a 256 | cut -d' ' -f1)"
    ;;
  apply)
    name="$(cat "$STATE" 2>/dev/null || true)"
    [ -n "$name" ] || { echo "nothing to apply"; exit 0; }
    changes "$name" | refuse_replacement
    aws cloudformation execute-change-set --stack-name "$STACK" --change-set-name "$name"
    aws cloudformation wait stack-update-complete --stack-name "$STACK"
    aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].[StackStatus,Outputs]' --output json
    : > "$STATE"
    ;;
  drift)
    id="$(aws cloudformation detect-stack-drift --stack-name "$STACK" --query StackDriftDetectionId --output text)"
    for _ in $(seq 1 60); do
      s="$(aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id "$id" --query DetectionStatus --output text)"
      [ "$s" = DETECTION_IN_PROGRESS ] || break
      sleep 5
    done
    aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id "$id" \
      --query '[DetectionStatus,StackDriftStatus,DriftedStackResourceCount]' --output text
    aws cloudformation describe-stack-resource-drifts --stack-name "$STACK" --output json \
      | jq -r '.StackResourceDrifts[] | "\(.LogicalResourceId) \(.StackResourceDriftStatus)\(if (.PropertyDifferences|length) > 0 then " " + (.PropertyDifferences|tostring) else "" end)"'
    ;;
  *) sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
