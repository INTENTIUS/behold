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
#   host.sh update                  demo-host.sh update with --terragucci-ref and
#                                   --behold-ref from TERRAGUCCI_REF and BEHOLD_REF,
#                                   each only when set
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
  update)
    args=()
    for pair in "terragucci-ref:${TERRAGUCCI_REF:-}" "behold-ref:${BEHOLD_REF:-}"; do
      ref="${pair#*:}"
      [ -n "$ref" ] || continue
      [[ "$ref" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "not a ref: '$ref'" >&2; exit 2; }
      args+=("--${pair%%:*}" "$ref")
    done
    run sudo /opt/demo/behold/deploy/demo-host/demo-host.sh update ${args[@]+"${args[@]}"}
    ;;
  ip-site) run grep -q "'^http:// {'" /opt/demo/behold/deploy/demo-host/Caddyfile ;;
  terragucci-head) run sudo git -C /opt/demo/terragucci rev-parse HEAD ;;
  *) sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
