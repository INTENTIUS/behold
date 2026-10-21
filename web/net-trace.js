// behold#881: follow traffic hop by hop, and say where it stops.
//
// A trace starts outside (the public internet) or at a card, names where the
// traffic should arrive and on which port, and walks what is declared between
// them: the way in through a gateway, the network ACLs on the subnets, the
// security groups, the listener that takes the port and what it forwards to.
// Each hop is open or closed, with the reason in words, and says where the
// answer came from: the live estate, when the card was read with the rule on
// it (`IpPermissions` is the provider's own shape, so it is live by
// construction), or the source alone.
//
// Beside it, findings that need no trace: address ranges that overlap, a
// public subnet with no way out, a load balancer in one zone, an admin port
// open to anyone.
//
// AWS is read in full (VPC, subnets, route tables, NACLs, security groups,
// load balancers). GCP follows a forwarding rule to its serverless backend and
// the invoker grant; Azure reads a container app's environment, its subnet's
// security group and its ingress. Anything else says it isn't read, rather
// than guess.

export const OUTSIDE = "outside";

/** Ports that are someone's way to administer a machine, not to use it. */
export const ADMIN_PORTS = { 22: "SSH", 3389: "remote desktop", 1433: "SQL Server", 3306: "MySQL", 5432: "Postgres", 6379: "Redis", 9200: "Elasticsearch", 27017: "MongoDB" };

// ---------------------------------------------------------------- addresses

function ip4(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(s));
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/** `10.20.0.0/16` → { base, bits }, or null for anything that isn't IPv4 CIDR. A bare address is a /32. */
export function parseCidr(s) {
  if (typeof s !== "string") return null;
  const [addr, bitsStr] = s.trim().split("/");
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  const ip = ip4(addr);
  if (ip === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { base: (ip & mask) >>> 0, bits, mask };
}

/** Whether `outer` holds every address in `inner`. */
export function cidrContains(outer, inner) {
  const a = parseCidr(outer);
  const b = parseCidr(inner);
  if (!a || !b) return false;
  return a.bits <= b.bits && ((b.base & a.mask) >>> 0) === a.base;
}

/** Whether two ranges share any address. */
export function cidrsOverlap(x, y) {
  return cidrContains(x, y) || cidrContains(y, x);
}

const ANYONE = (c) => c === "0.0.0.0/0" || c === "::/0";

// ---------------------------------------------------------------- graph

function index(ir) {
  const nodes = ir.nodes || [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // A member that declares stacks has qualified ids (`aws/<stack>::sg`) while
  // its `$ref`s keep the bare form (`aws/sg`).
  const bare = new Map();
  for (const n of nodes) {
    const m = /^([^/]+\/)[^/]*::(.+)$/.exec(n.id);
    if (m && !bare.has(m[1] + m[2])) bare.set(m[1] + m[2], n.id);
  }
  const resolve = (ref) => {
    if (typeof ref !== "string") return undefined;
    for (const cand of [ref, ref.replace(/\.[^./]+$/, "")]) {
      if (byId.has(cand)) return cand;
      if (bare.has(cand)) return bare.get(cand);
    }
    return undefined;
  };
  const refsIn = (v, out = []) => {
    if (Array.isArray(v)) for (const x of v) refsIn(x, out);
    else if (v && typeof v === "object") {
      if (typeof v.$ref === "string") {
        const id = resolve(v.$ref);
        if (id && !out.includes(id)) out.push(id);
      } else for (const x of Object.values(v)) refsIn(x, out);
    }
    return out;
  };
  const refIn = (v) => refsIn(v)[0];
  const kindIs = (n, re) => !!n && re.test(n.kind || "");
  const ofKind = (re) => nodes.filter((n) => kindIs(n, re));
  /** Cards of a kind whose attr `key` refers to `id`. */
  const referring = (re, key, id) => ofKind(re).filter((n) => refsIn(n.attrs?.[key]).includes(id));
  return { nodes, byId, resolve, refsIn, refIn, kindIs, ofKind, referring };
}

const seenLive = (n) => n?.attrs?._status === "good" || n?.attrs?._status === "warn";
const title = (n) => (n ? n.id : "?");
const portIn = (p, from, to) => (from === undefined || from === null || Number(from) === -1 ? true : p >= Number(from) && p <= Number(to ?? from));

// ---------------------------------------------------------------- AWS

const AWS = {
  subnet: /^AWS::EC2::Subnet$/,
  sg: /^AWS::EC2::SecurityGroup$/,
  sgIngress: /^AWS::EC2::SecurityGroupIngress$/,
  sgEgress: /^AWS::EC2::SecurityGroupEgress$/,
  rta: /^AWS::EC2::SubnetRouteTableAssociation$/,
  route: /^AWS::EC2::Route$/,
  igw: /^AWS::EC2::InternetGateway$/,
  igwAttach: /^AWS::EC2::VPCGatewayAttachment$/,
  nat: /^AWS::EC2::NatGateway$/,
  naclAssoc: /^AWS::EC2::SubnetNetworkAclAssociation$/,
  naclEntry: /^AWS::EC2::NetworkAclEntry$/,
  lb: /^AWS::ElasticLoadBalancingV2::LoadBalancer$/,
  listener: /^AWS::ElasticLoadBalancingV2::Listener$/,
  listenerRule: /^AWS::ElasticLoadBalancingV2::ListenerRule$/,
  tg: /^AWS::ElasticLoadBalancingV2::TargetGroup$/,
};

function awsSubnetsOf(g, n) {
  const a = n.attrs || {};
  const vpc = a.NetworkConfiguration?.AwsvpcConfiguration;
  const refs = g.refsIn([a.Subnets, a.SubnetId, vpc?.Subnets, a.SubnetMappings, a.NetworkInterfaces, a.VPCZoneIdentifier]);
  return refs.map((id) => g.byId.get(id)).filter((x) => g.kindIs(x, AWS.subnet));
}

function awsSgsOf(g, n) {
  const a = n.attrs || {};
  const vpc = a.NetworkConfiguration?.AwsvpcConfiguration;
  const refs = g.refsIn([a.SecurityGroups, a.SecurityGroupIds, vpc?.SecurityGroups, a.NetworkInterfaces, a.VpcSecurityGroupIds]);
  return refs.map((id) => g.byId.get(id)).filter((x) => g.kindIs(x, AWS.sg));
}

/** A security group's rules one way, from the live read when it carries them. */
function awsSgRules(g, sg, egress) {
  const a = sg.attrs || {};
  const live = egress ? a.IpPermissionsEgress : a.IpPermissions;
  if (Array.isArray(live)) {
    return {
      basis: "live",
      rules: live.map((r) => ({
        proto: String(r.IpProtocol),
        from: r.FromPort,
        to: r.ToPort,
        cidrs: [...(r.IpRanges || []).map((x) => x.CidrIp), ...(r.Ipv6Ranges || []).map((x) => x.CidrIpv6)].filter(Boolean),
        groups: (r.UserIdGroupPairs || []).map((x) => x.GroupId).filter(Boolean),
      })),
    };
  }
  const inline = (egress ? a.SecurityGroupEgress : a.SecurityGroupIngress) || [];
  const standalone = g.referring(egress ? AWS.sgEgress : AWS.sgIngress, "GroupId", sg.id).map((n) => n.attrs || {});
  const declared = [...(Array.isArray(inline) ? inline : []), ...standalone];
  // No egress declared at all: a security group sends anywhere by default.
  if (egress && !declared.length) return { basis: "source", rules: [{ proto: "-1", cidrs: ["0.0.0.0/0"], groups: [] }], byDefault: true };
  return {
    basis: "source",
    rules: declared.map((r) => ({
      proto: String(r.IpProtocol),
      from: r.FromPort,
      to: r.ToPort,
      cidrs: [r.CidrIp, r.CidrIpv6, r.DestinationCidrIp].filter((c) => typeof c === "string"),
      groups: g.refsIn([r.SourceSecurityGroupId, r.DestinationSecurityGroupId]),
    })),
  };
}

const protoCovers = (proto, port) => (proto === "-1" ? true : (proto === "tcp" || proto === "6") && port !== undefined);

/**
 * Whether any of `sgs` lets `port` in (or out) from `src`: `{ cidr }` for an
 * address range, `{ sgs }` for traffic from cards in those groups.
 */
function awsSgsAllow(g, sgs, port, src, egress = false) {
  let basis = "source";
  for (const sg of sgs) {
    const { rules, basis: b, byDefault } = awsSgRules(g, sg, egress);
    if (b === "live") basis = "live";
    for (const r of rules) {
      if (!protoCovers(r.proto, port) || (r.proto !== "-1" && !portIn(port, r.from, r.to))) continue;
      const byCidr = src.cidr && r.cidrs.some((c) => cidrContains(c, src.cidr));
      const srcGroups = (src.sgs || []).flatMap((s) => [s.id, s.attrs?.GroupId]).filter((x) => typeof x === "string");
      const byGroup = r.groups.some((x) => srcGroups.includes(x));
      if (byCidr || byGroup) {
        const what = byGroup ? "the source's security group" : r.cidrs.find((c) => cidrContains(c, src.cidr));
        return { open: true, by: sg, basis: b, why: byDefault ? `${title(sg)} sends anywhere (no outbound rule declared)` : `${title(sg)} allows ${port} ${egress ? "to" : "from"} ${what}` };
      }
    }
  }
  return { open: false, basis, why: sgs.length ? `no rule in ${sgs.map(title).join(", ")} allows ${port} ${egress ? "to" : "from"} ${src.cidr ?? "the source"}` : "no security group" };
}

/** The route a subnet sends `0.0.0.0/0` along. */
function awsWayOut(g, subnet) {
  const assoc = g.referring(AWS.rta, "SubnetId", subnet.id)[0];
  const table = assoc && g.refIn(assoc.attrs?.RouteTableId);
  if (!table) return { kind: "unknown", why: `${title(subnet)} has no route table of its own; the VPC's main table decides` };
  const routes = g.referring(AWS.route, "RouteTableId", table).filter((r) => r.attrs?.DestinationCidrBlock === "0.0.0.0/0");
  for (const r of routes) {
    const igw = g.refIn(r.attrs?.GatewayId);
    if (igw && g.kindIs(g.byId.get(igw), AWS.igw)) {
      const attached = g.referring(AWS.igwAttach, "InternetGatewayId", igw).length > 0;
      return { kind: attached ? "igw" : "detached", route: r, gateway: g.byId.get(igw), why: attached ? `${title(r)} sends 0.0.0.0/0 to ${igw}` : `${igw} isn't attached to the VPC` };
    }
    const nat = g.refIn(r.attrs?.NatGatewayId);
    if (nat) return { kind: "nat", route: r, gateway: g.byId.get(nat), why: `${title(r)} sends 0.0.0.0/0 to ${nat}` };
  }
  return { kind: "none", why: `${g.byId.get(table) ? table : "its route table"} has no route to 0.0.0.0/0` };
}

/** Whether a subnet's network ACL lets `port` in (or out) for `cidr`. */
function awsNaclAllows(g, subnet, port, cidr, egress = false) {
  const assoc = g.referring(AWS.naclAssoc, "SubnetId", subnet.id)[0];
  const acl = assoc && g.refIn(assoc.attrs?.NetworkAclId);
  if (!acl) return { open: true, basis: "source", why: `${title(subnet)}: no network ACL declared, the VPC's default allows all` };
  const entries = g
    .referring(AWS.naclEntry, "NetworkAclId", acl)
    .map((n) => ({ n, a: n.attrs || {} }))
    .filter(({ a }) => String(a.Egress ?? false) === String(egress))
    .sort((x, y) => Number(x.a.RuleNumber) - Number(y.a.RuleNumber));
  for (const { n, a } of entries) {
    const proto = String(a.Protocol);
    if (proto !== "-1" && proto !== "6") continue;
    if (proto === "6" && !portIn(port, a.PortRange?.From, a.PortRange?.To)) continue;
    if (!cidrContains(a.CidrBlock ?? a.Ipv6CidrBlock, cidr)) continue;
    const allow = String(a.RuleAction).toLowerCase() === "allow";
    return { open: allow, by: n, basis: "source", why: `${acl} rule ${a.RuleNumber} ${allow ? "allows" : "denies"} ${port} ${egress ? "to" : "from"} ${cidr}` };
  }
  return { open: false, basis: "source", why: `no rule in ${acl} matches ${port} ${egress ? "to" : "from"} ${cidr}, so it is denied` };
}

/** Each hop says whether the card it is about was read live. */
function hop(step, card, res) {
  return { step, id: card?.id, open: !!res.open, why: res.why, basis: res.basis || "source", seen: seenLive(card) };
}

/** The first subnet whose result is open, else the first result (the reason it is closed). */
function anySubnet(subnets, f) {
  const results = subnets.map((s) => ({ s, r: f(s) }));
  return results.find((x) => x.r.open) || results[0];
}

/** Load balancer chains that end at `target`: lb, listeners, the target group. */
function awsChainsTo(g, target) {
  const out = [];
  for (const lb of g.ofKind(AWS.lb)) {
    const listeners = g.referring(AWS.listener, "LoadBalancerArn", lb.id);
    if (lb.id === target.id) {
      out.push({ lb, listeners, tg: null });
      continue;
    }
    for (const l of listeners) {
      const rules = g.referring(AWS.listenerRule, "ListenerArn", l.id);
      const tgs = g.refsIn([l.attrs?.DefaultActions, ...rules.map((r) => r.attrs?.Actions)]).filter((id) => g.kindIs(g.byId.get(id), AWS.tg));
      for (const tg of tgs) {
        const t = g.byId.get(tg);
        const hits =
          target.id === tg ||
          g.refsIn(target.attrs?.LoadBalancers).includes(tg) ||
          g.refsIn(target.attrs?.TargetGroupARNs).includes(tg) ||
          g.refsIn(t.attrs?.Targets).includes(target.id);
        if (hits) out.push({ lb, listeners, tg: t });
      }
    }
  }
  // An internet-facing one first: that is the way in from outside.
  return out.sort((x, y) => (x.lb.attrs?.Scheme === "internal") - (y.lb.attrs?.Scheme === "internal"));
}

function awsFromOutside(g, target, port) {
  const hops = [];
  const chain = awsChainsTo(g, target)[0];
  if (chain) {
    const { lb, listeners, tg } = chain;
    const internal = lb.attrs?.Scheme === "internal";
    hops.push(hop("way in", lb, { open: !internal, why: internal ? `${lb.id} is internal: it has no address outside the VPC` : `${lb.id} faces the internet` }));
    const lbSubnets = awsSubnetsOf(g, lb);
    const out = anySubnet(lbSubnets, (s) => {
      const w = awsWayOut(g, s);
      return { open: w.kind === "igw", why: w.why, gateway: w.gateway };
    });
    hops.push(hop("gateway", out?.r.gateway || lb, out ? out.r : { open: false, why: `${lb.id} names no subnet` }));
    const nacl = anySubnet(lbSubnets, (s) => awsNaclAllows(g, s, port, "0.0.0.0/0"));
    if (nacl) hops.push(hop("network ACL", nacl.r.by || nacl.s, nacl.r));
    const lbSgs = awsSgsOf(g, lb);
    if (!lbSgs.length && lb.attrs?.Type === "network") hops.push(hop("security group", lb, { open: true, why: `${lb.id} is a network load balancer with no security group: it passes what reaches it` }));
    else {
      const r = awsSgsAllow(g, lbSgs, port, { cidr: "0.0.0.0/0" });
      hops.push(hop("security group", r.by || lbSgs[0] || lb, r));
    }
    const listener = listeners.find((l) => Number(l.attrs?.Port) === port);
    const ports = listeners.map((l) => l.attrs?.Port).filter((p) => p !== undefined);
    hops.push(
      hop("listener", listener || lb, {
        open: !!listener,
        why: listener ? `${listener.id} takes ${port}` : ports.length ? `${lb.id} listens on ${ports.join(", ")}, not ${port}` : `${lb.id} has no listener`,
      }),
    );
    if (!tg) return hops;
    const lbEntry = (target.attrs?.LoadBalancers || []).find((x) => g.refsIn(x).includes(tg.id));
    const tport = Number(lbEntry?.ContainerPort ?? lbEntry?.TargetPort ?? tg.attrs?.Port);
    hops.push(hop("forward", tg, { open: true, why: `${listener?.id ?? "the listener"} forwards to ${tg.id} on ${tport}` }));
    if (target.id === tg.id) return hops;
    const tSubnets = awsSubnetsOf(g, target);
    const lbCidrs = lbSubnets.map((s) => s.attrs?.CidrBlock).filter((c) => typeof c === "string");
    const tn = anySubnet(tSubnets, (s) => {
      const per = lbCidrs.map((c) => awsNaclAllows(g, s, tport, c));
      return per.find((x) => x.open) || per[0] || awsNaclAllows(g, s, tport, "0.0.0.0/0");
    });
    if (tn) hops.push(hop("network ACL", tn.r.by || tn.s, tn.r));
    const tSgs = awsSgsOf(g, target);
    if (tSgs.length) {
      const byGroup = awsSgsAllow(g, tSgs, tport, { sgs: lbSgs });
      const r = byGroup.open ? byGroup : lbCidrs.map((c) => awsSgsAllow(g, tSgs, tport, { cidr: c })).find((x) => x.open) || byGroup;
      hops.push(hop("security group", r.by || tSgs[0], r));
    }
    return hops;
  }
  // No load balancer in front: a card with its own public address.
  const subnets = awsSubnetsOf(g, target);
  if (!subnets.length) return [hop("way in", target, { open: false, why: `nothing in front of ${target.id} takes traffic from outside, and it sits in no subnet` })];
  const vpc = target.attrs?.NetworkConfiguration?.AwsvpcConfiguration;
  const publicIp = vpc ? vpc.AssignPublicIp === "ENABLED" : target.attrs?.NetworkInterfaces?.some?.((x) => x.AssociatePublicIpAddress) || subnets.some((s) => s.attrs?.MapPublicIpOnLaunch === true);
  hops.push(hop("way in", target, { open: !!publicIp, why: publicIp ? `${target.id} gets a public address` : `nothing in front of ${target.id} takes traffic from outside, and it has no public address` }));
  const out = anySubnet(subnets, (s) => {
    const w = awsWayOut(g, s);
    return { open: w.kind === "igw", why: w.why, gateway: w.gateway };
  });
  hops.push(hop("gateway", out.r.gateway || out.s, out.r));
  const nacl = anySubnet(subnets, (s) => awsNaclAllows(g, s, port, "0.0.0.0/0"));
  hops.push(hop("network ACL", nacl.r.by || nacl.s, nacl.r));
  const sgs = awsSgsOf(g, target);
  const r = awsSgsAllow(g, sgs, port, { cidr: "0.0.0.0/0" });
  hops.push(hop("security group", r.by || sgs[0] || target, r));
  return hops;
}

/** The hops from a card out to the internet. */
function awsWayOutOf(g, source, port) {
  const subnets = awsSubnetsOf(g, source);
  if (!subnets.length) return [hop("way out", source, { open: false, why: `${source.id} sits in no subnet this trace reads` })];
  const vpc = source.attrs?.NetworkConfiguration?.AwsvpcConfiguration;
  const out = anySubnet(subnets, (s) => {
    const w = awsWayOut(g, s);
    const publicIp = vpc ? vpc.AssignPublicIp === "ENABLED" : s.attrs?.MapPublicIpOnLaunch === true;
    const open = w.kind === "nat" || (w.kind === "igw" && publicIp);
    return { open, gateway: w.gateway, why: w.kind === "igw" && !publicIp ? `${w.why}, but ${source.id} has no public address` : w.why };
  });
  const hops = [hop("way out", out.r.gateway || out.s, out.r)];
  const sgs = awsSgsOf(g, source);
  if (sgs.length) {
    const r = awsSgsAllow(g, sgs, port, { cidr: "0.0.0.0/0" }, true);
    hops.push(hop("security group", r.by || sgs[0], r));
  }
  return hops;
}

function awsCardToCard(g, source, target, port) {
  const sSubnets = awsSubnetsOf(g, source);
  const tSubnets = awsSubnetsOf(g, target);
  // Declared, a `$ref`; read live, the provider's own id.
  const vpcOf = (s) => g.refIn(s.attrs?.VpcId) ?? (typeof s.attrs?.VpcId === "string" ? s.attrs.VpcId : undefined);
  const sameVpc = sSubnets.length && tSubnets.length && sSubnets.some((s) => tSubnets.some((t) => vpcOf(s) && vpcOf(s) === vpcOf(t)));
  if (!sameVpc) return null;
  const hops = [hop("route", tSubnets[0], { open: true, why: `inside ${vpcOf(tSubnets[0])}: the local route` })];
  const sSgs = awsSgsOf(g, source);
  const tCidr = tSubnets[0].attrs?.CidrBlock;
  if (sSgs.length) {
    const r = awsSgsAllow(g, sSgs, port, { cidr: tCidr }, true);
    hops.push(hop("security group", r.by || sSgs[0], r));
  }
  const sCidr = sSubnets[0].attrs?.CidrBlock;
  const outAcl = awsNaclAllows(g, sSubnets[0], port, tCidr, true);
  hops.push(hop("network ACL", outAcl.by || sSubnets[0], outAcl));
  const inAcl = anySubnet(tSubnets, (s) => awsNaclAllows(g, s, port, sCidr));
  hops.push(hop("network ACL", inAcl.r.by || inAcl.s, inAcl.r));
  const tSgs = awsSgsOf(g, target);
  if (tSgs.length) {
    const byGroup = awsSgsAllow(g, tSgs, port, { sgs: sSgs });
    const r = byGroup.open ? byGroup : awsSgsAllow(g, tSgs, port, { cidr: sCidr });
    hops.push(hop("security group", r.by || tSgs[0], r));
  }
  if (g.kindIs(target, AWS.lb)) {
    const listener = g.referring(AWS.listener, "LoadBalancerArn", target.id).find((l) => Number(l.attrs?.Port) === port);
    hops.push(hop("listener", listener || target, { open: !!listener, why: listener ? `${listener.id} takes ${port}` : `${target.id} has no listener on ${port}` }));
  }
  return hops;
}

// ---------------------------------------------------------------- GCP

const GCP_NEXT = [
  [/::ForwardingRule$/, "target"],
  [/::TargetHTTPS?Proxy$/, "urlMapRef"],
  [/::URLMap$/, ["defaultService", "pathMatcher", "pathMatchers"]],
  [/::BackendService$/, "backend"],
  [/::(Region)?NetworkEndpointGroup$/, ["cloudRun", "cloudFunction", "appEngine"]],
];

const gcpName = (n) => n?.attrs?.metadata?.name;

function gcpPortIn(range, port) {
  if (range === undefined || range === null || range === "") return true;
  const [a, b] = String(range).split("-").map(Number);
  return port >= a && port <= (b || a);
}

/** The invoker grant that opens a Cloud Run service to anyone. */
function gcpPublicGrant(g, service) {
  const name = gcpName(service);
  return g.ofKind(/^GCP::Iam::Policy(Member|Binding)$/).find((p) => {
    const a = p.attrs || {};
    const members = [a.member, ...(a.members || [])];
    const onIt = a.resourceRef?.name === name || g.refsIn(a.resourceRef).includes(service.id);
    return onIt && a.role === "roles/run.invoker" && members.some((m) => m === "allUsers" || m === "allAuthenticatedUsers");
  });
}

function gcpServiceHops(g, service, viaLb) {
  const ingress = service.attrs?.ingress || "INGRESS_TRAFFIC_ALL";
  const ok = ingress === "INGRESS_TRAFFIC_ALL" || (viaLb && ingress === "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER");
  const hops = [hop("ingress", service, { open: ok, why: ok ? `${service.id} takes traffic ${viaLb ? "from the load balancer" : "from anywhere"}` : `${service.id} takes ${ingress.replace("INGRESS_TRAFFIC_", "").toLowerCase().replace(/_/g, " ")} traffic only` })];
  const grant = gcpPublicGrant(g, service);
  hops.push(hop("invoker", grant || service, { open: !!grant, why: grant ? `${grant.id} lets ${grant.attrs.member || "anyone"} call it` : `no grant lets anyone call ${service.id}: callers need a credential` }));
  return hops;
}

function gcpFromOutside(g, target, port) {
  const next = (n) => {
    const rule = GCP_NEXT.find(([re]) => re.test(n.kind || ""));
    if (!rule) return [];
    const keys = Array.isArray(rule[1]) ? rule[1] : [rule[1]];
    return g.refsIn(keys.map((k) => n.attrs?.[k]));
  };
  for (const fr of g.ofKind(/^GCP::Compute::ForwardingRule$/)) {
    if (String(fr.attrs?.loadBalancingScheme || "EXTERNAL").startsWith("INTERNAL")) continue;
    const path = [];
    const walk = (id, seen) => {
      if (id === target.id) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      for (const nxt of next(g.byId.get(id))) {
        path.push(nxt);
        if (walk(nxt, seen)) return true;
        path.pop();
      }
      return false;
    };
    if (!walk(fr.id, new Set())) continue;
    const range = fr.attrs?.portRange;
    const hops = [hop("way in", fr, { open: gcpPortIn(range, port), why: gcpPortIn(range, port) ? `${fr.id} takes ${port} from the internet` : `${fr.id} takes ${range}, not ${port}` })];
    for (const id of path) {
      const n = g.byId.get(id);
      if (id === target.id && g.kindIs(n, /^GCP::Run::Service$/)) hops.push(...gcpServiceHops(g, n, true));
      else hops.push(hop("forward", n, { open: true, why: `forwards to ${next(n)[0] ?? id}` }));
    }
    return hops;
  }
  if (g.kindIs(target, /^GCP::Run::Service$/)) {
    const hops = gcpServiceHops(g, target, false);
    if (port !== 443) hops.unshift(hop("way in", target, { open: false, why: `${target.id}'s own address takes 443, not ${port}` }));
    return hops;
  }
  return [hop("way in", target, { open: false, why: `no forwarding rule reaches ${target.id}` })];
}

// ---------------------------------------------------------------- Azure

function azNsgRules(g, subnet) {
  const nsgId = g.refIn(subnet.attrs?.networkSecurityGroup ?? subnet.attrs?.properties?.networkSecurityGroup);
  const nsg = nsgId && g.byId.get(nsgId);
  if (!nsg) return null;
  const inline = nsg.attrs?.securityRules ?? nsg.attrs?.properties?.securityRules ?? [];
  const children = g.ofKind(/networkSecurityGroups[/_]securityRules$/).filter((r) => r.id.startsWith(nsg.id) || g.refsIn(r.attrs).includes(nsg.id));
  const rules = [...inline, ...children.map((c) => c.attrs)].map((r) => ({ name: r.name, ...(r.properties || r) }));
  return { nsg, rules };
}

const azFromAnyone = (r) => ["*", "Internet", "0.0.0.0/0", "Any"].includes(r.sourceAddressPrefix) || (r.sourceAddressPrefixes || []).some((p) => ["*", "Internet", "0.0.0.0/0"].includes(p));
function azPortIn(r, port) {
  const ranges = [r.destinationPortRange, ...(r.destinationPortRanges || [])].filter((x) => x !== undefined);
  return ranges.some((x) => x === "*" || gcpPortIn(x, port));
}

function azureFromOutside(g, target, port) {
  if (!g.kindIs(target, /^Microsoft\.App\/containerApps$/)) return [hop("way in", target, { open: false, why: `the trace reads a container app's way in; ${target.id} isn't one` })];
  const hops = [];
  const envId = g.refIn(target.attrs?.managedEnvironmentId);
  const env = envId && g.byId.get(envId);
  if (env) {
    const internal = env.attrs?.vnetConfiguration?.internal === true;
    hops.push(hop("way in", env, { open: !internal, why: internal ? `${env.id} is internal: it has no public address` : `${env.id} has a public address` }));
    const subnetId = g.refIn(env.attrs?.vnetConfiguration?.infrastructureSubnetId);
    const subnet = subnetId && g.byId.get(subnetId);
    if (subnet) {
      const nsg = azNsgRules(g, subnet);
      if (!nsg) hops.push(hop("security group", subnet, { open: true, why: `${subnet.id} has no network security group` }));
      else {
        const rule = nsg.rules
          .filter((r) => String(r.direction).toLowerCase() === "inbound" && azFromAnyone(r) && azPortIn(r, port))
          .sort((a, b) => Number(a.priority) - Number(b.priority))[0];
        const open = rule ? String(rule.access).toLowerCase() === "allow" : false;
        hops.push(hop("security group", nsg.nsg, { open, why: rule ? `${nsg.nsg.id} rule ${rule.name} ${open ? "allows" : "denies"} ${port}` : `no rule in ${nsg.nsg.id} allows ${port} from the internet` }));
      }
    }
  }
  const ingress = target.attrs?.configuration?.ingress;
  hops.push(hop("ingress", target, { open: ingress?.external === true, why: !ingress ? `${target.id} has no ingress` : ingress.external ? `${target.id} takes traffic from outside the environment` : `${target.id}'s ingress is internal to the environment` }));
  if (ingress) {
    const tcp = ingress.transport === "tcp";
    const listens = tcp ? [Number(ingress.exposedPort)] : [80, 443];
    const restricted = (ingress.ipSecurityRestrictions || []).filter((r) => String(r.action).toLowerCase() === "allow");
    hops.push(hop("listener", target, { open: listens.includes(port), why: listens.includes(port) ? `takes ${port} and forwards to ${ingress.targetPort}` : `takes ${listens.join(" and ")}, not ${port}` }));
    if (restricted.length) {
      const anyone = restricted.some((r) => ANYONE(r.ipAddressRange));
      hops.push(hop("address rules", target, { open: anyone, why: anyone ? "the address rules allow anyone" : `only ${restricted.map((r) => r.ipAddressRange).join(", ")} may call it` }));
    }
  }
  return hops;
}

// ---------------------------------------------------------------- trace

const cloudOf = (n) => (/^AWS::/.test(n?.kind || "") ? "aws" : /^GCP::/.test(n?.kind || "") ? "gcp" : /^Microsoft\./.test(n?.kind || "") ? "azure" : null);

function fromOutside(g, target, port) {
  const cloud = cloudOf(target);
  if (cloud === "aws") return awsFromOutside(g, target, port);
  if (cloud === "gcp") return gcpFromOutside(g, target, port);
  if (cloud === "azure") return azureFromOutside(g, target, port);
  return null;
}

/** The hops from a card to the internet, for a trace that leaves its network. */
function wayOutOf(g, source, port) {
  const cloud = cloudOf(source);
  if (cloud === "aws") return awsWayOutOf(g, source, port);
  if (cloud === "gcp") {
    const egress = source.attrs?.template?.vpcAccess?.egress;
    const viaVpc = egress === "ALL_TRAFFIC";
    const nat = g.ofKind(/^GCP::Compute::Router(NAT)?$/).some((r) => r.kind.endsWith("RouterNAT") || r.attrs?.nats);
    return [hop("way out", source, { open: !viaVpc || nat, why: viaVpc ? (nat ? "all traffic leaves through the VPC and its NAT" : "all traffic leaves through the VPC, which declares no NAT") : `${source.id} reaches the internet directly` })];
  }
  if (cloud === "azure") return [hop("way out", source, { open: true, why: `${source.id} reaches the internet through its environment` })];
  return [hop("way out", source, { open: false, why: `${source.id} isn't a card this trace reads` })];
}

/**
 * Trace `port` from `from` (OUTSIDE or a card id) to the card `to`. Returns
 * the hops in order, whether the traffic arrives, and the first hop that stops
 * it; or `{ unread }` with the reason when the trace can't be read here.
 */
export function traceRoute(ir, { from, to, port }) {
  const g = index(ir);
  const target = g.byId.get(to);
  const p = Number(port);
  if (!target) return { unread: `${to} isn't on this graph` };
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { unread: "a port is 1 to 65535" };
  let hops;
  if (from === OUTSIDE) hops = fromOutside(g, target, p);
  else {
    const source = g.byId.get(from);
    if (!source) return { unread: `${from} isn't on this graph` };
    hops = cloudOf(source) === "aws" && cloudOf(target) === "aws" ? awsCardToCard(g, source, target, p) : null;
    // Another network: out to the internet, and in from outside.
    if (!hops) {
      const inbound = fromOutside(g, target, p);
      hops = inbound && [...wayOutOf(g, source, p), ...inbound];
    }
  }
  if (!hops) return { unread: `the trace reads AWS, GCP and Azure networks; ${to} is ${target.kind}` };
  const stop = hops.find((h) => !h.open);
  return { from, to, port: p, hops, reached: !stop, stop: stop?.id };
}

// ---------------------------------------------------------------- findings

/** Address ranges from every cloud, each with the network it belongs to. */
function ranges(g) {
  const out = [];
  for (const n of g.nodes) {
    const a = n.attrs || {};
    if (n.kind === "AWS::EC2::VPC" && typeof a.CidrBlock === "string") out.push({ id: n.id, cidr: a.CidrBlock, net: n.id, level: "network" });
    if (n.kind === "AWS::EC2::Subnet" && typeof a.CidrBlock === "string") out.push({ id: n.id, cidr: a.CidrBlock, net: g.refIn(a.VpcId) ?? (typeof a.VpcId === "string" ? a.VpcId : n.id), level: "subnet" });
    if (n.kind === "Microsoft.Network/virtualNetworks") for (const c of a.addressSpace?.addressPrefixes || []) out.push({ id: n.id, cidr: c, net: n.id, level: "network" });
    if (/^Microsoft\.Network\/virtualNetworks[/_]subnets$/.test(n.kind || "")) {
      const vnet = g.nodes.find((v) => v.kind === "Microsoft.Network/virtualNetworks" && typeof a.name === "string" && a.name.startsWith(`${v.attrs?.name}/`));
      for (const c of [a.addressPrefix, ...(a.addressPrefixes || [])].filter(Boolean)) out.push({ id: n.id, cidr: c, net: vnet?.id ?? n.id, level: "subnet" });
    }
    if (n.kind === "GCP::Compute::Subnetwork" && typeof a.ipCidrRange === "string") out.push({ id: n.id, cidr: a.ipCidrRange, net: g.refIn(a.networkRef) ?? n.id, level: "network" });
  }
  return out;
}

/**
 * What is wrong with the networks without tracing anything: overlapping
 * ranges, a public subnet with no way out, a load balancer in one zone, and an
 * admin port open to anyone. Each finding names the cards it is about.
 */
export function networkFindings(ir) {
  const g = index(ir);
  const out = [];
  const rs = ranges(g);
  for (let i = 0; i < rs.length; i++) {
    for (let j = i + 1; j < rs.length; j++) {
      const [a, b] = [rs[i], rs[j]];
      if (a.id === b.id || !cidrsOverlap(a.cidr, b.cidr)) continue;
      // Networks apart from each other, or two subnets of one network.
      const apart = a.level === "network" && b.level === "network" && a.net !== b.net;
      const siblings = a.level === "subnet" && b.level === "subnet" && a.net === b.net;
      if (apart || siblings) out.push({ finding: "overlap", ids: [a.id, b.id], text: `${a.id} (${a.cidr}) and ${b.id} (${b.cidr}) overlap: ${apart ? "traffic between them can't be routed by address" : "one network can't hold both"}` });
    }
  }
  const facing = g.ofKind(AWS.lb).filter((lb) => lb.attrs?.Scheme !== "internal");
  const facingSubnets = new Set(facing.flatMap((lb) => awsSubnetsOf(g, lb).map((s) => s.id)));
  for (const s of g.ofKind(AWS.subnet)) {
    if (s.attrs?.MapPublicIpOnLaunch !== true && !facingSubnets.has(s.id)) continue;
    const w = awsWayOut(g, s);
    if (w.kind !== "igw") out.push({ finding: "no way out", ids: [s.id], text: `${s.id} is public but ${w.why}` });
  }
  for (const lb of g.ofKind(AWS.lb)) {
    const subnets = awsSubnetsOf(g, lb);
    const zones = new Set(subnets.map((s) => (typeof s.attrs?.AvailabilityZone === "string" ? s.attrs.AvailabilityZone : s.id)));
    if (subnets.length && zones.size < 2) out.push({ finding: "one zone", ids: [lb.id], text: `${lb.id} sits in one zone: if it goes, so does the way in` });
  }
  const admin = (from, to, proto) => Object.keys(ADMIN_PORTS).map(Number).filter((p) => proto === "-1" || ((proto === "tcp" || proto === "6") && portIn(p, from, to)));
  const say = (ports) => ports.map((p) => `${p} (${ADMIN_PORTS[p]})`).join(", ");
  for (const sg of g.ofKind(AWS.sg)) {
    const { rules } = awsSgRules(g, sg, false);
    const ports = [...new Set(rules.filter((r) => r.cidrs.some(ANYONE)).flatMap((r) => admin(r.from, r.to, r.proto)))];
    if (ports.length) out.push({ finding: "admin port", ids: [sg.id], text: `${sg.id} lets anyone reach ${say(ports)}` });
  }
  for (const fw of g.ofKind(/^GCP::Compute::Firewall$/)) {
    const a = fw.attrs || {};
    if ((a.direction || "INGRESS") !== "INGRESS" || !(a.sourceRanges || []).some(ANYONE)) continue;
    const ports = [...new Set((a.allow || []).flatMap((x) => (x.protocol === "all" ? admin(-1, -1, "-1") : x.protocol === "tcp" ? (x.ports?.length ? x.ports.flatMap((r) => { const [lo, hi] = String(r).split("-").map(Number); return admin(lo, hi ?? lo, "tcp"); }) : admin(-1, -1, "-1")) : [])))];
    if (ports.length) out.push({ finding: "admin port", ids: [fw.id], text: `${fw.id} lets anyone reach ${say(ports)}` });
  }
  for (const nsg of g.ofKind(/^Microsoft\.Network\/networkSecurityGroups$/)) {
    const rules = (nsg.attrs?.securityRules ?? nsg.attrs?.properties?.securityRules ?? []).map((r) => ({ name: r.name, ...(r.properties || r) }));
    const ports = [...new Set(rules.filter((r) => String(r.direction).toLowerCase() === "inbound" && String(r.access).toLowerCase() === "allow" && azFromAnyone(r)).flatMap((r) => Object.keys(ADMIN_PORTS).map(Number).filter((p) => azPortIn(r, p))))];
    if (ports.length) out.push({ finding: "admin port", ids: [nsg.id], text: `${nsg.id} lets anyone reach ${say(ports)}` });
  }
  return out;
}
