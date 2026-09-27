import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyConversion, declarationName, moveLayoutIds, planConversion } from "./workspace-convert.ts";

// #464, ws-015: `behold doctor --fix` writes the declaration for an estate
// behold served from `.behold.json`, and moves the saved layout so its ids
// still match the picture the declared workspace reads as.

const ROOT_TF = 'terraform {\n  required_providers {}\n}\nresource "aws_s3_bucket" "b" {}\n';

function estate(): string {
  const root = mkdtempSync(join(tmpdir(), "behold-convert-"));
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put("apps/api/chant.config.ts", "export default {};\n");
  // One member that holds two Terraform roots, and a called module that is neither.
  put("infra/network/main.tf", ROOT_TF);
  put("infra/app/main.tf", ROOT_TF);
  put("infra/modules/net/main.tf", 'terraform {}\nresource "aws_vpc" "v" {}\n');
  put("estates/Prod_East/estate.chdf.hcl", 'estate = "prod"\n');
  put(
    ".behold.json",
    JSON.stringify({
      members: [
        { dir: "apps/api", kind: "chant" },
        { dir: "infra", kind: "terraform" },
        { dir: "estates/Prod_East", kind: "choudoufu" },
      ],
    }),
  );
  return root;
}

describe("declarationName", () => {
  it("folds a name into what a declaration can hold", () => {
    expect(declarationName("api")).toBe("api");
    expect(declarationName("Prod_East")).toBe("prod-east");
    expect(declarationName("--x--")).toBe("x");
    expect(declarationName("___")).toBe("member");
    expect(declarationName("a".repeat(50))).toHaveLength(40);
  });
});

describe("planConversion", () => {
  it("declares one member per chant project, choudoufu estate and Terraform root", () => {
    const root = estate();
    const planned = planConversion(root);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const { declaration, moves } = planned.plan;
    expect(declaration.schema).toBe(1);
    expect(declaration.members).toEqual([
      { name: "api", dir: "apps/api", kind: "chant" },
      { name: "app", dir: "infra/app", kind: "terraform" },
      { name: "network", dir: "infra/network", kind: "terraform" },
      { name: "prod-east", dir: "estates/Prod_East", kind: "choudoufu" },
    ]);
    // chant reads a terraform member as a root named after the member.
    expect(moves).toContainEqual({ from: "infra/network/", to: "network/network/" });
    expect(moves).toContainEqual({ from: "infra/app/", to: "app/app/" });
    expect(moves).toContainEqual({ from: "Prod_East/", to: "prod-east/" });
    expect(moves.some((m) => m.from.startsWith("api/"))).toBe(false);
    expect(planned.plan.notes.join("\n")).toContain("2 Terraform roots");
  });

  it("refuses a root that already declares a workspace, and a directory with no member list", () => {
    const root = estate();
    writeFileSync(join(root, "chant.workspace.json"), "{}");
    expect(planConversion(root).ok).toBe(false);
    expect(planConversion(mkdtempSync(join(tmpdir(), "behold-convert-empty-"))).ok).toBe(false);
  });
});

describe("applyConversion", () => {
  it("writes the declaration and moves the first member's layout to the root", () => {
    const root = estate();
    mkdirSync(join(root, "apps/api/.behold"), { recursive: true });
    writeFileSync(
      join(root, "apps/api/.behold/layout.json"),
      JSON.stringify({ version: 1, lenses: { resources: { "api/Bucket": { dx: 1 }, "infra/network/aws_s3_bucket.b": { dx: 2 }, "Prod_East/aws_s3_bucket.x": { dy: 3 } } } }),
    );
    const planned = planConversion(root);
    if (!planned.ok) throw new Error(planned.error);
    const wrote = applyConversion(planned.plan);
    const decl = JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf8"));
    expect(decl.members).toHaveLength(4);
    expect(wrote.layout).toEqual({ wrote: join(root, ".behold/layout.json"), ids: 3 });
    const layout = JSON.parse(readFileSync(join(root, ".behold/layout.json"), "utf8"));
    expect(Object.keys(layout.lenses.resources).sort()).toEqual(["api/Bucket", "network/network/aws_s3_bucket.b", "prod-east/aws_s3_bucket.x"]);
    // The old file stays.
    expect(readFileSync(join(root, "apps/api/.behold/layout.json"), "utf8")).toContain("infra/network");
  });
});

describe("moveLayoutIds", () => {
  it("takes the longest matching prefix and leaves other ids alone", () => {
    const moved = moveLayoutIds(
      { version: 1, lenses: { l: { "a/b/x": { dx: 1 }, "a/y": { dx: 2 }, "z/q": { dx: 3 } } } },
      [
        { from: "a/b/", to: "b/b/" },
        { from: "a/", to: "aa/" },
      ],
    );
    expect(moved.lenses.l).toEqual({ "b/b/x": { dx: 1 }, "aa/y": { dx: 2 }, "z/q": { dx: 3 } });
  });
});
