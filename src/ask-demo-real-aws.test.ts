/**
 * behold#1202: the ask demo's one read of a real AWS account. The account id
 * is redacted before anything is written, and the script that makes the
 * read refuses a region holding anything but its default groups.
 */
import { describe, expect, it } from "vitest";
import { indexDocumentDigest, indexScopeKey, indexVersionName, validateIndexDocument } from "@intentius/chant/lifecycle/index-document";
import { EMULATOR_ACCOUNT, foreignAccountIds, redactIndexVersion, REDACTED_ACCOUNT } from "../scripts/ask-demo/redact.ts";
import { openRules, regionProblem } from "../scripts/ask-demo/real-aws.ts";
import type { IndexDocument } from "./graph-db/types.ts";

const REAL = "111122223333";

function realVersion(account = REAL): IndexDocument {
  const scope = { kind: "cloud", substrate: "aws", scopeId: account, locations: ["us-west-2"], types: ["AWS::EC2::SecurityGroup", "AWS::EC2::SecurityGroupIngress"] };
  const sg = `aws/${account}/us-west-2/AWS::EC2::SecurityGroup/sg-0abc`;
  const rule = `aws/${account}/us-west-2/AWS::EC2::SecurityGroupIngress/sgr-0def`;
  const doc = {
    index: "v1",
    stamp: { source: { kind: "cloud", name: "chant-lister", version: "0.34.1" }, scope, scopeKey: indexScopeKey(scope as never), observedAt: "2026-11-18T20:51:37.121Z", completedAt: "2026-11-18T20:51:38.000Z", digest: "" },
    coverage: [{ listedType: "AWS::EC2::SecurityGroupIngress", location: "us-west-2", verdict: "listed" }],
    graph: {
      version: 1,
      nodes: [
        { id: sg, kind: "AWS::EC2::SecurityGroup", lexicon: "aws", attrs: { GroupName: "behold-ask-demo-ssh", OwnerId: account }, facts: { cloudIds: [{ kind: "arn", value: `arn:aws:ec2:us-west-2:${account}:security-group/sg-0abc` }] } },
        { id: rule, kind: "AWS::EC2::SecurityGroupIngress", lexicon: "aws", attrs: { GroupId: "sg-0abc", IpProtocol: "tcp", FromPort: 22, ToPort: 22, CidrIp: "0.0.0.0/0" }, facts: {} },
      ],
      edges: [],
      groups: { byLexicon: { aws: [sg, rule] } },
    },
    notes: [],
  };
  doc.stamp.digest = indexDocumentDigest(doc as never);
  return doc as unknown as IndexDocument;
}

describe("redacting the real account's index version", () => {
  it("replaces the id everywhere and computes the scope key, digest and version name again, as chant would", () => {
    const real = realVersion();
    const { doc, version } = redactIndexVersion(real, REAL);
    const text = JSON.stringify(doc);
    expect(text).not.toContain(REAL);
    expect(text).toContain(`aws/${REDACTED_ACCOUNT}/us-west-2/AWS::EC2::SecurityGroupIngress/sgr-0def`);
    expect(text).toContain(`arn:aws:ec2:us-west-2:${REDACTED_ACCOUNT}:security-group/sg-0abc`);
    expect(doc.stamp.scopeKey).toBe(indexScopeKey({ ...(real.stamp.scope as object), scopeId: REDACTED_ACCOUNT } as never));
    expect(doc.stamp.scopeKey).not.toBe(real.stamp.scopeKey.split(REAL).join(REDACTED_ACCOUNT));
    expect((doc.stamp as { digest: string }).digest).toBe(indexDocumentDigest(doc as never));
    expect(version).toBe(indexVersionName(doc.stamp.observedAt, (doc.stamp as { digest: string }).digest));
    expect(() => validateIndexDocument(doc as never)).not.toThrow();
    expect(foreignAccountIds(text)).toEqual([]);
    // The rule's own properties pass through untouched.
    expect(doc.graph.nodes[1]!.attrs).toEqual({ GroupId: "sg-0abc", IpProtocol: "tcp", FromPort: 22, ToPort: 22, CidrIp: "0.0.0.0/0" });
  });

  it("refuses an id that is not the version's account, the placeholder, floci's account, or not an id", () => {
    expect(() => redactIndexVersion(realVersion(), "444455556666")).toThrow(/not of AWS account/);
    expect(() => redactIndexVersion(realVersion(REDACTED_ACCOUNT), REDACTED_ACCOUNT)).toThrow(/placeholder/);
    expect(() => redactIndexVersion(realVersion(EMULATOR_ACCOUNT), EMULATOR_ACCOUNT)).toThrow(/placeholder or floci/);
    expect(() => redactIndexVersion(realVersion(), "1234")).toThrow(/not an AWS account id/);
  });
});

describe("finding an account id that should not be published", () => {
  it("finds ids in ARNs, index keys, scope keys, owner fields and --account, and passes floci's and the placeholder", () => {
    const text = [
      `arn:aws:iam::${REAL}:role/x`,
      "cloud/aws/222233334444/abc",
      '"OwnerId": "333344445555"',
      "behold index aws --account 555566667777 --regions us-west-2",
      `arn:aws:iam::${EMULATOR_ACCOUNT}:role/y aws/${REDACTED_ACCOUNT}/us-west-2/z`,
      "20261118T205137Z observedAt 1700000000000",
    ].join("\n");
    expect(foreignAccountIds(text)).toEqual([REAL, "222233334444", "333344445555", "555566667777"]);
    expect(foreignAccountIds(`--account ${REDACTED_ACCOUNT} aws/${EMULATOR_ACCOUNT}/x`)).toEqual([]);
  });
});

describe("the real account read's guards", () => {
  it("refuses a region holding any group not named default", () => {
    expect(regionProblem([{ GroupId: "sg-1", GroupName: "default" }])).toBeUndefined();
    expect(regionProblem([{ GroupId: "sg-1", GroupName: "default" }, { GroupId: "sg-2", GroupName: "web" }])).toMatch(/other than its default ones \(web sg-2\)/);
  });

  it("counts the rules opening a port to anywhere, whether ports come as numbers or strings, with no group to match", () => {
    const rules = [
      { CidrIp: "0.0.0.0/0", IpProtocol: "tcp", FromPort: "22", ToPort: "22" },
      { CidrIp: "0.0.0.0/0", IpProtocol: "tcp", FromPort: 0, ToPort: 1024 },
      { CidrIp: "10.0.0.0/8", IpProtocol: "tcp", FromPort: 443, ToPort: 443 },
      { CidrIp: "0.0.0.0/0", IpProtocol: "udp", FromPort: 443, ToPort: 443 },
    ];
    expect(openRules(rules, 22)).toBe(2);
    expect(openRules(rules, 443)).toBe(1);
    expect(openRules(rules, 8080)).toBe(0);
  });
});
