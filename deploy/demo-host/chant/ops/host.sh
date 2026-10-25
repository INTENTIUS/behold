#!/usr/bin/env bash
# How the demo-host ops reach the machine: ssh to the stack's Elastic IP.
#
#   host.sh ip                      the address (DEMO_HOST_IP, or the stack's ElasticIp output)
#   host.sh run <command>...        run <command> on the host as ubuntu
#   host.sh copy <local> <remote>   scp one file to the host, mode 600
#   host.sh json [<path>]           demo.json from floci on the host (read only)
#   host.sh step                    demo.json's step, or "none" before the first one
#   host.sh bootstrapped            the terragucci commit floci holds a base for, or ""
#   host.sh terragucci-head         the terragucci checkout's commit
#   host.sh ip-site                 exit 0 when the host's Caddyfile still has the
#                                   plain-http site by the instance's address
#   host.sh update-prepare          demo-host.sh update-prepare with the refs as
#                                   update passes them: the behold checkout and the
#                                   images, while the loop and the site carry on. A
#                                   host whose demo-host.sh has no update-prepare yet
#                                   skips it, and update does that work instead.
#   host.sh update                  demo-host.sh update with --terragucci-ref and
#                                   --behold-ref from TERRAGUCCI_REF and BEHOLD_REF,
#                                   each only when set. It waits for a quiet step on
#                                   the host itself; on a host whose demo-host.sh
#                                   doesn't yet, this waits for one first (wait-quiet)
#   host.sh wait-quiet              until demo.json says reset or applied, looking every
#                                   second over one ssh session, at most DEMO_QUIET_WAIT
#                                   seconds (900)
#
# Settings, from the environment:
#   DEMO_HOST_IP     skip the stack lookup
#   DEMO_SSH_KEY     the private key (default ~/.ssh/demo-intentius.pem)
#   DEMO_STACK       the CloudFormation stack (default demo-intentius-host)
#   AWS_PROFILE, AWS_REGION as the AWS CLI reads them (region default us-east-2)
set -euo pipefail

STACK="${DEMO_STACK:-demo-intentius-host}"
KEY="${DEMO_SSH_KEY:-$HOME/.ssh/demo-intentius.pem}"
FLOCI=http://127.0.0.1:4580
REPORTS=demo-reports/demo

ip() {
  if [ -n "${DEMO_HOST_IP:-}" ]; then printf '%s\n' "$DEMO_HOST_IP"; return; fi
  aws cloudformation describe-stacks --region "${AWS_REGION:-us-east-2}" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='ElasticIp'].OutputValue" --output text
}

ssh_opts=(-i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30)

run() { ssh "${ssh_opts[@]}" "ubuntu@$(ip)" -- "$@"; }

cmd="${1:-}"
shift || true
case "$cmd" in
  ip) ip ;;
  run) run "$@" ;;
  copy)
    scp -q "${ssh_opts[@]}" "${1:?local file}" "ubuntu@$(ip):${2:?remote path}"
    run chmod 600 "$2"
    ;;
  json) run curl -fsS -m 10 "$FLOCI/$REPORTS/demo.json" ;;
  step) run "curl -fsS -m 10 $FLOCI/$REPORTS/demo.json 2>/dev/null | jq -r '.step // \"none\"' || echo none" ;;
  bootstrapped) run "curl -fsS -m 10 $FLOCI/demo-host/bootstrapped 2>/dev/null || true" ;;
  wait-quiet)
    limit="${DEMO_QUIET_WAIT:-900}"
    [[ "$limit" =~ ^[0-9]+$ ]] || { echo "DEMO_QUIET_WAIT is seconds, not '$limit'" >&2; exit 2; }
    run "start=\$(date +%s); while :; do
      step=\$(curl -fsS -m 5 $FLOCI/$REPORTS/demo.json 2>/dev/null | jq -r '.step // \"none\"' 2>/dev/null || echo none)
      case \$step in reset|applied) echo \"demo.json says \$step\"; exit 0 ;; esac
      [ \$(( \$(date +%s) - start )) -lt $limit ] || { echo \"demo.json still says \$step after ${limit}s\" >&2; exit 1; }
      sleep 1
    done"
    ;;
  update|update-prepare)
    args=()
    for pair in "terragucci-ref:${TERRAGUCCI_REF:-}" "behold-ref:${BEHOLD_REF:-}"; do
      ref="${pair#*:}"
      [ -n "$ref" ] || continue
      [[ "$ref" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "not a ref: '$ref'" >&2; exit 2; }
      args+=("--${pair%%:*}" "$ref")
    done
    script=/opt/demo/behold/deploy/demo-host/demo-host.sh
    # A host whose demo-host.sh predates update-prepare moves both checkouts in update
    # with no wait of its own: this side skips the prepare and waits for the quiet step first, as before.
    if ! run grep -q update-prepare-rest "$script"; then
      if [ "$cmd" = update-prepare ]; then echo "the host's demo-host.sh has no update-prepare yet; update builds instead"; exit 0; fi
      bash "$0" wait-quiet
    fi
    run sudo "$script" "$cmd" ${args[@]+"${args[@]}"}
    ;;
  ip-site) run grep -q "'^http:// {'" /opt/demo/behold/deploy/demo-host/Caddyfile ;;
  terragucci-head) run sudo git -C /opt/demo/terragucci rev-parse HEAD ;;
  *) sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
