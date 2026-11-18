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
 * placeholders in `reply` are filled from the rows (fillReply in
 * ./narration.ts lists them), and a source names itself in plain words
 * (`{col|source}`), never by its scope key.
 *
 * The queries name no scope key, account id or generated name: those change
 * from run to run, so the queries select by source, kind and edge instead.
 */
import type { Question } from "./narration.ts";

/** The load turn's prompt and reply. Its rows are the sources GET /api/graphdb lists. */
export const LOAD = {
  prompt: "Load my estate into behold: the three-cloud workspace, the AWS account, and the cluster.",
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
    reply: "{{count:record}} Route 53 records reach into another member ({{list:record}}), and between them they depend on {{count:reaches}} resources there: {{list:reaches}}.",
  },
  {
    id: "forwarding-rule-dependents",
    prompt: "What breaks if I delete the GCP load balancer's forwarding rule?",
    reading: "I'll find everything that depends on that forwarding rule.",
    ask: { resource: "webRule", template: "dependents-all" },
    reply: "{{count}} resources depend on webRule, all of them in {{list:scope|source}}: {{list:key}}.",
  },
  {
    id: "aws-account-unmanaged",
    prompt: "Is anything in our AWS account that nobody owns?",
    reading: "I'll compare the account's network and storage resources with what the workspace declares, and list those it does not.",
    ask: {
      cypher:
        "MATCH (i:Resource {source: 'index', lexicon: 'aws'}) " +
        "WHERE i.kind IN ['AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::SecurityGroup', 'AWS::S3::Bucket'] " +
        "WITH i, regexp_extract(i.facts, '\"address\":\"([^\"]+)\"', 1) AS owner " +
        "OPTIONAL MATCH (d:Resource {source: 'chant'}) WHERE owner <> '' AND d.key ENDS WITH ('/' + owner) " +
        "WITH i, d WHERE d IS NULL " +
        "RETURN i.key AS key, i.kind AS kind, i.name AS name ORDER BY kind, name",
    },
    reply: "{{count}} resources there have no owner in the workspace: {{each:{name} ({kind})}}.",
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
    reply: "{{count}} ServiceAccounts carry an IRSA annotation that names a role in the account: {{each:{serviceAccount} assumes {role}}}. behold joined them on {{list:via}} by the {{list:rule}} rule.",
  },
  {
    id: "orders-reader-readers",
    prompt: "Who outside AWS can use the orders-reader role?",
    reading: "I'll find what reaches the orders-reader role from outside the account.",
    ask: { resource: "orders-reader", template: "readers" },
    reply: "Readers from outside the account: {{count}}, from {{list:scope|source}}, joined on {{list:via}} by the {{list:rule}} rule.",
  },
];
