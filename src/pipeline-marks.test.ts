import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { atmosRepo, declaredRootTools, rootTools, sqlYodelerRepo, configKeys, forgeOfName, forgeOfPipelinePath, pipelineForge, repoTools, toolOfBinary } from "./pipeline-marks.ts";
import type { TerragucciComponents } from "./terragucci-components.ts";

// behold#571: the forge and the tools of a terragucci repo, from its files.
const repo = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "behold-marks-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    if (p.endsWith("/")) mkdirSync(join(dir, p), { recursive: true });
    else writeFileSync(join(dir, p), text);
  }
  return dir;
};
const decl = (pipeline: TerragucciComponents["pipeline"]): TerragucciComponents => ({ schema: "terragucci.components/v1", roots: {}, components: [], pipeline });
const noUnits = { terragrunt: () => false };

describe("pipelineForge", () => {
  it("takes the declaration's forge first", () => {
    const dir = repo({ ".github/workflows/x.yml": "", "terragucci.yml": "forge: gitlab\n" });
    expect(pipelineForge(decl({ forge: "forgejo", jobs: [] }), dir, join(dir, "terragucci.yml"))).toEqual({ forge: "forgejo", from: "declared" });
  });

  it("then terragucci.yml's forge", () => {
    const dir = repo({ "terragucci.yml": "forge: gitlab\nbinary: tofu\n" });
    expect(pipelineForge(decl({ jobs: [] }), dir, join(dir, "terragucci.yml"))).toEqual({ forge: "gitlab", from: "config" });
  });

  it("then the pipeline path, then the one workflow directory", () => {
    const dir = repo({ ".github/workflows/x.yml": "" });
    expect(pipelineForge(decl({ path: ".forgejo/workflows/terragucci.yml", jobs: [] }), dir)).toEqual({ forge: "forgejo", from: "pipeline-path" });
    expect(pipelineForge(decl({ jobs: [] }), dir)).toEqual({ forge: "github", from: "workflow-dir" });
    expect(pipelineForge(decl({ jobs: [] }), repo({ ".gitlab-ci.yml": "stages: []\n" }))).toEqual({ forge: "gitlab", from: "workflow-dir" });
  });

  it("is unknown when nothing says, or the repo has two workflow places", () => {
    expect(pipelineForge(decl({ forge: "woodpecker", jobs: [] }), repo({ "README.md": "" }))).toBeUndefined();
    expect(pipelineForge(decl({ jobs: [] }), repo({ ".github/workflows/a.yml": "", ".forgejo/workflows/b.yml": "" }))).toBeUndefined();
  });

  it("reads the words alone", () => {
    expect(forgeOfName("GitHub Actions")).toBe("github");
    expect(forgeOfName(3)).toBeUndefined();
    expect(forgeOfPipelinePath(".gitlab-ci.yaml")).toBe("gitlab");
    expect(forgeOfPipelinePath("Jenkinsfile")).toBeUndefined();
  });
});

describe("repoTools", () => {
  it("names the engine terragucci.yml's binary is", () => {
    const dir = repo({ "terragucci.yml": "binary: tofu\n" });
    expect(repoTools(dir, join(dir, "terragucci.yml"), noUnits)).toEqual(["opentofu"]);
    expect(toolOfBinary("/usr/local/bin/terraform")).toBe("terraform");
    expect(toolOfBinary("pulumi")).toBeUndefined();
  });

  it("puts the orchestrator the repo's files show first", () => {
    const dir = repo({ "terragucci.yml": "binary: tofu\n" });
    expect(repoTools(dir, join(dir, "terragucci.yml"), { terragrunt: () => true })).toEqual(["terragrunt", "opentofu"]);
    expect(repoTools(repo({ "cdktf.json": "{}" }), undefined, noUnits)).toEqual(["cdk-terrain"]);
    expect(repoTools(repo({ "atmos.yaml": "base_path: .\n" }), undefined, noUnits)).toEqual(["atmos"]);
    expect(repoTools(repo({ "chant.workspace.json": '{"members":[{"name":"a"}]}' }), undefined, noUnits)).toEqual(["chant"]);
  });

  it("reads a SQL Yodeler project", () => {
    expect(repoTools(repo({ "yodel.config.ts": "export default {};\n" }), undefined, noUnits)).toEqual(["sql-yodeler"]);
    expect(sqlYodelerRepo(repo({ "migrations/0001/up.sql": "", "package.json": '{"dependencies":{"@intentius/sql-yodeler":"^0.9.0"}}' }))).toBe(true);
    expect(sqlYodelerRepo(repo({ "migrations/0001/up.sql": "", "package.json": '{"dependencies":{"knex":"^3"}}' }))).toBe(false);
  });

  it("reads Atmos's stacks layout", () => {
    expect(atmosRepo(repo({ "stacks/dev.yaml": "", "components/terraform/vpc/main.tf": "" }))).toBe(true);
    expect(atmosRepo(repo({ "stacks/dev.yaml": "" }))).toBe(false);
  });

  it("names nothing it doesn't know, and no chant for terragucci's own gate workspace", () => {
    expect(repoTools(repo({ "chant.workspace.json": '{"members":[]}' }), undefined, noUnits)).toEqual([]);
    expect(repoTools(repo({ "terragucci.yml": "gate: on-destructive\n" }), undefined, noUnits)).toEqual([]);
  });

  it("reads a terragucci.ts by its words", () => {
    const dir = repo({ "terragucci.ts": 'export default { forge: "forgejo", binary: "terraform" };\n' });
    expect(configKeys(join(dir, "terragucci.ts"))).toEqual({ forge: "forgejo", binary: "terraform" });
    expect(configKeys(join(dir, "missing.yml"))).toEqual({});
  });
});

// terragucci#1080: example-demo's app root carries a SQL Yodeler project at app/schema/,
// which app's apply runs with `chant run wave --spec yodel-waves.json`.
describe("rootTools", () => {
  const demo = () =>
    repo({
      "network/main.tf": 'resource "terraform_data" "n" {}\n',
      "app/main.tf": 'resource "terraform_data" "a" {}\n',
      "app/schema.tf": "",
      "app/schema/chant.config.ts": "export default {};\n",
      "app/schema/yodel.config.ts": "export default {};\n",
      "app/schema/yodel-waves.json": '{"name":"yodel-apply"}\n',
      "app/schema/package.json": '{"dependencies":{"@intentius/sql-yodeler":"0.9.0"}}\n',
      "app/schema/migrations/20261016T0521-init/migration.json": "{}\n",
      "app/schema/migrations/20261016T0521-init/migration.sql": "CREATE TABLE users (id int);\n",
      "app/schema/ops/migrate-dev.op.ts": "",
      "edge/main.tf": "",
    });

  it("finds the SQL Yodeler project inside app, and none in the other roots", () => {
    const dir = demo();
    expect(rootTools(dir, "app")).toEqual(["sql-yodeler"]);
    expect(rootTools(dir, "network")).toEqual([]);
    expect(declaredRootTools(dir, { network: { dir: "network" }, app: { dir: "./app/" }, edge: { dir: "edge" } })).toEqual({ app: ["sql-yodeler"] });
  });

  it("finds one by its yodel-waves.json alone, or its migrations beside a chant config", () => {
    expect(rootTools(repo({ "app/db/yodel-waves.json": "{}" }), "app")).toEqual(["sql-yodeler"]);
    expect(rootTools(repo({ "app/db/chant.config.ts": "", "app/db/migrations/0001/migration.sql": "" }), "app")).toEqual(["sql-yodeler"]);
    expect(rootTools(repo({ "app/modules/migrations/0001.sql": "" }), "app")).toEqual([]);
  });

  it("looks no deeper than two levels, and never into node_modules", () => {
    expect(rootTools(repo({ "app/a/b/c/yodel.config.ts": "" }), "app")).toEqual([]);
    expect(rootTools(repo({ "app/node_modules/x/yodel.config.ts": "" }), "app")).toEqual([]);
    expect(rootTools(repo({}), "missing")).toEqual([]);
  });
});
