// behold#631: under `serve --repos`, /api/project answers for the checkout
// `?repo=` names, its member kinds included. The demo host serves its
// Terraform repo by default and the chant repo beside it; the member kinds
// were the default's for every repo, so the kiosk read demo-chant as
// Terraform and hid its Components view.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";

const parent = mkdtempSync(join(tmpdir(), "behold-view-repos-project-"));
afterAll(() => rmSync(parent, { recursive: true, force: true }));

function checkout(name: string, files: Record<string, string>): string {
  const dir = join(parent, name);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  return dir;
}

// The host's shapes: demo is Terraform roots, demo-chant a chant project (its
// chant.config.ts imports nothing) with three roots and a Forgejo workflow.
const ROOT = 'terraform {\n  required_version = ">= 1.10"\n}\n\nresource "terraform_data" "a" {}\n';
const demo = checkout("demo", { "network/main.tf": ROOT, "app/main.tf": ROOT });
const chant = checkout("demo-chant", {
  "chant.config.ts": 'export default { lexicons: ["terraform"], terraform: { binary: "tofu", roots: { network: { dir: "network" } } } };\n',
  "network/main.tf": ROOT,
  ".forgejo/workflows/chant-pr.yml": "jobs:\n  plan:\n    steps:\n      - run: chant components pr-plan --pr 1 --env demo --gate pr-apply\n",
});

describe("/api/project under serve --repos (behold#631)", () => {
  const app = createApp({
    projectDir: demo,
    projectDirs: [demo],
    port: 0,
    public: true,
    viewRepos: { parent, repos: new Map([["demo", { projectDir: demo, projectDirs: [demo] }], ["demo-chant", { projectDir: chant }]]), defaultName: "demo" },
  } as Parameters<typeof createApp>[0]);
  const kinds = async (q: string) => ((await (await app.request(`/api/project${q}`)).json()) as { memberKinds: string[]; projectDir: string });

  it("answers the default checkout's kinds without ?repo=", async () => {
    expect(await kinds("")).toMatchObject({ projectDir: demo, memberKinds: ["terraform"] });
  });

  it("answers the named checkout's kinds with ?repo=, so a chant repo beside a Terraform one reads as chant", async () => {
    expect(await kinds("?repo=demo-chant")).toMatchObject({ projectDir: chant, memberKinds: ["chant"] });
    expect(await kinds("?repo=demo")).toMatchObject({ memberKinds: ["terraform"] });
  });
});
