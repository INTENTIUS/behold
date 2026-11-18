/**
 * behold#1161: the questions the ask demo asks, in the order it asks them.
 *
 * Each entry is the person's prompt (an engineer's worry, not a description
 * of the query), the agent's one-line reading of it (what it will look for),
 * the agent's reply as a template, and
 * the one `behold mcp ask` call the agent makes: a `cypher` query with its
 * `params`, or a `resource` and the name of a template from chant's catalog
 * (GET /api/graphdb/templates). scripts/ask-demo/record.ts asks each one of
 * the estate it boots and keeps only those with a non-empty answer; the
 * placeholders in `reply` and `headline` (behold#1198, the line above the
 * answer) are filled from the rows (fillReply in
 * ./narration.ts lists them), and a source names itself in plain words
 * (`{col|source}`), never by its scope key.
 *
 * The queries name no scope key, account id or generated name: those change
 * from run to run, so the queries select by source, kind and edge instead.
 */
import type { Question } from "./narration.ts";

/**
 * The load turn's prompt, busy line and reply. Its rows are the sources GET
 * /api/graphdb lists. The busy line says what happens in words (behold#1206);
 * the commands that did it are the turn's `call`, shown on hover.
 */
export const LOAD = {
  prompt: "Load my estate into behold: the three-cloud workspace, the AWS account, and the cluster.",
  busy: "behold is reading the workspace, the AWS account and the cluster into one graph",
  reply: "Loaded {{sum:nodes}} resources from {{count}} sources: {{each:{scopeKey|source} ({nodes})}}.",
};

export const QUESTIONS: readonly Question[] = [
  {
    id: "dns-cross-cloud",
    prompt: "If GCP has an outage, which of our domains go with it?",
    reading: "I'll find the DNS records that depend on GCP resources.",
    ask: {
      cypher:
        "MATCH (rec:Resource {kind: $record})-[:REF*1..4]->(dep:Resource {source: 'chant'}) " +
        "WHERE dep.scopeKey <> rec.scopeKey " +
        "RETURN DISTINCT rec.key AS key, rec.name AS record, dep.key AS reaches, dep.kind AS kind ORDER BY record, reaches",
      params: { record: "AWS::Route53::RecordSet" },
    },
    reply: "{{count:record}} of our domains depend on {{list:reaches|member}} ({{list:record}}), and between them they go through {{list:reaches|id}}.",
    headline: "{{count:record}} domains depend on {{count:reaches}} resources in {{list:reaches|member}}",
  },
  {
    id: "forwarding-rule-dependents",
    prompt: "What breaks if I delete the GCP load balancer's forwarding rule?",
    reading: "I'll find everything that depends on that forwarding rule.",
    ask: { resource: "webRule", template: "dependents-all" },
    reply: "{{count}} resources in {{list:key|member}} depend on the forwarding rule, so they would break with it: {{each:{key|id} ({kind})}}.",
    headline: "{{count}} resources in {{list:key|member}} depend on the forwarding rule",
  },
  {
    id: "aws-account-unmanaged",
    prompt: "Is anything in our AWS account that nobody owns?",
    reading: "I'll compare the network and storage resources in the account the workspace deploys to with what the workspace declares, and list those it does not.",
    ask: {
      // behold#1202: only the account the workspace deploys to, the one whose
      // index holds resources with the aws member's ownership markers; the
      // real account's read for the SSH question holds none.
      cypher:
        "MATCH (i:Resource {source: 'index', lexicon: 'aws'}) " +
        "WHERE i.kind IN ['AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::SecurityGroup', 'AWS::S3::Bucket'] " +
        "WITH i, regexp_extract(i.facts, '\"address\":\"([^\"]+)\"', 1) AS owner " +
        "OPTIONAL MATCH (d:Resource {source: 'chant'}) WHERE owner <> '' AND d.key ENDS WITH ('/' + owner) " +
        "WITH i, d WHERE d IS NULL " +
        "MATCH (o:Resource {source: 'index', lexicon: 'aws'}) WHERE o.scopeKey = i.scopeKey AND o.facts CONTAINS '\"address\":' " +
        "RETURN DISTINCT i.key AS key, i.kind AS kind, i.name AS name ORDER BY kind, name",
    },
    reply: "Yes, {{count}} resources in the account have no owner in the workspace: {{each:{name} ({kind})}}.",
    headline: "{{count}} network and storage resources in the AWS account have no owner in the workspace",
  },
  {
    // behold#1202: floci lists no ingress rules, so this reads the one real
    // AWS account read (just ask-demo-read-real-aws), kept with its id
    // redacted. Only that source indexes AWS::EC2::SecurityGroupIngress.
    id: "aws-ssh-open",
    prompt: "Is SSH open to the internet anywhere in our AWS account?",
    reading: "I'll look for ingress rules that open port 22 to anywhere.",
    ask: {
      cypher:
        "MATCH (r:Resource {source: 'index', kind: 'AWS::EC2::SecurityGroupIngress'}) " +
        "WITH r, regexp_extract(r.attrs, '\"IpProtocol\":\"([^\"]+)\"', 1) AS protocol, regexp_extract(r.attrs, '\"FromPort\":(-?[0-9]+)', 1) AS fromPort, " +
        "regexp_extract(r.attrs, '\"ToPort\":(-?[0-9]+)', 1) AS toPort, regexp_extract(r.attrs, '\"CidrIp\":\"([^\"]+)\"', 1) AS cidr, regexp_extract(r.attrs, '\"CidrIpv6\":\"([^\"]+)\"', 1) AS cidr6 " +
        "WHERE cidr = '0.0.0.0/0' OR cidr6 = '::/0' " +
        "WITH r, cidr + cidr6 AS source, " +
        "CASE WHEN protocol = '-1' THEN 'all traffic' WHEN fromPort = toPort THEN protocol + ' ' + fromPort ELSE protocol + ' ' + fromPort + '-' + toPort END AS opens, " +
        "(protocol = '-1' OR ((protocol = 'tcp' OR protocol = '6') AND CAST(CASE WHEN fromPort = '' THEN '-9' ELSE fromPort END AS INT64) <= 22 AND CAST(CASE WHEN toPort = '' THEN '-9' ELSE toPort END AS INT64) >= 22)) AS ssh " +
        "RETURN r.key AS key, r.nativeId AS rule, opens, source, r.location AS region, " +
        "CASE WHEN ssh THEN r.nativeId ELSE '' END AS sshRule, CASE WHEN ssh THEN '' ELSE r.nativeId + ' (' + opens + ')' END AS other ORDER BY sshRule DESC, rule",
    },
    reply:
      "Yes: {{count:sshRule}} ingress {{pick:sshRule|rule opens|rules open}} SSH (tcp port 22) to anywhere, {{list:sshRule}} in {{list:region}}. " +
      "The other {{pick:other|rule open to anywhere is|rules open to anywhere are}} {{list:other}}.",
    headline: "{{count:sshRule}} {{pick:sshRule|rule opens|rules open}} SSH to the internet",
  },
  {
    id: "serviceaccount-roles",
    prompt: "Which AWS roles can our Kubernetes pods use?",
    reading: "Pods get AWS roles through their ServiceAccounts, so I'll find the roles the cluster's ServiceAccounts point at.",
    ask: {
      cypher:
        "MATCH (sa:Resource {kind: 'K8s::Core::ServiceAccount'})-[e:REF]->(role:Resource {kind: 'AWS::IAM::Role'}) " +
        "RETURN sa.key AS key, sa.name AS serviceAccount, role.key AS roleKey, role.name AS role, e.viaAttr AS via, e.rule AS rule ORDER BY serviceAccount",
    },
    reply: "Our pods can use {{count:roleKey}} AWS roles: {{each:{role} through the {serviceAccount} ServiceAccount}}. Each ServiceAccount's role annotation names its role.",
    headline: "Pods in the cluster can use {{count:roleKey}} AWS roles through {{count:key}} ServiceAccounts",
  },
  {
    id: "orders-reader-readers",
    prompt: "Who outside AWS can use the orders-reader role?",
    reading: "I'll find what reaches the orders-reader role from outside the account.",
    ask: { resource: "orders-reader", template: "readers" },
    reply: "{{count}} resource from outside AWS can use it: {{list:key|name}}, from {{list:scope|source}}. Its role annotation names the role.",
    headline: "{{count}} resource from {{list:scope|source}} can use the role",
  },
];
