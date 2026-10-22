import { describe, it, expect } from "vitest";
import { attributeFields, summarize } from "./attribute-fields.ts";

describe("attribute fields (the attributes zoom)", () => {
  it("summarizes a structured value to one short line", () => {
    expect(summarize([80, 443])).toBe("80, 443");
    expect(summarize(["10.0.0.0/24", "10.0.1.0/24", "10.0.2.0/24"])).toBe("3 values");
    expect(summarize([{ IpProtocol: "tcp" }, { IpProtocol: "udp" }])).toBe("2 entries");
    expect(summarize({ $ref: "aws/webAlbSg.GroupId" })).toBe("→ webAlbSg");
    expect(summarize([{ Ref: "a" }, { Ref: "b" }])).toBe("→ a, b");
    expect(summarize({ Type: "HTTP", Port: 80 })).toBe("2 settings");
    expect(summarize([])).toBeUndefined();
  });

  it("prints the plain values first, then what the structured ones hold, four lines at most", () => {
    const attrs = {
      GroupDescription: "web",
      _status: "good",
      SecurityGroupIngress: [{ IpProtocol: "tcp", FromPort: 80 }],
      VpcId: { $ref: "aws/vpc.VpcId" },
      Tags: [{ Key: "a" }, { Key: "b" }],
      Zzz: { a: 1 },
    };
    expect(attributeFields({ attrs })).toEqual([
      { label: "GroupDescription", value: "web" },
      { label: "SecurityGroupIngress", value: "1 entry" },
      { label: "Tags", value: "2 entries" },
      { label: "VpcId", value: "→ vpc" },
    ]);
  });
});
