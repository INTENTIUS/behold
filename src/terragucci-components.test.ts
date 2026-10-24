import { afterAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { GraphIR } from "@intentius/chant";
import { memberSourceStamp } from "./member-ir.ts";
import { renderGraph } from "./render.ts";
import { resourcesByRoot } from "./resources.ts";
import { ESTATE_LINK, discoverTerraformRoots, terraformMemberScan, writeTerraformScratchProject } from "./terraform-member.ts";
import {
  SCAFFOLD_NO_ROLLBACK,
  TERRAGUCCI_COMPONENTS_FILE,
  TERRAGUCCI_COMPONENT_MODULE,
  componentJobs,
  componentRootMap,
  componentsIrFromDeclaration,
  declaredRootScan,
  readTerragucciComponents,
  terragucciComponentModule,
  waveTitles,
  type TerragucciComponents,
} from "./terragucci-components.ts";

// Fixture provenance (#571): terragucci's `example-demo/` roots (network, app,
// edge, other; INTENTIUS/terragucci main) copied verbatim, with a hand-written
// `terragucci.components.json` in the terragucci.components/v1 shape `terragucci
// init` writes: waves network+other / app / edge, applied by jobs
// apply-wave-1..3 needing check / apply-wave-1 / apply-wave-2.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "__fixtures__", "terragucci-components");

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-tgc-test-"));
  made.push(dir);
  return dir;
}

const decl = (): TerragucciComponents => readTerragucciComponents(REPO)!;

describe("reading terragucci.components.json (#571)", () => {
  it("reads the fixture's declaration", () => {
    const d = decl();
    expect(d.schema).toBe("terragucci.components/v1");
    expect(Object.keys(d.roots).sort()).toEqual(["app", "edge", "network", "other"]);
    expect(d.components.map((c) => c.name)).toEqual(["network", "other", "app", "edge"]);
    expect(d.pipeline.jobs.map((j) => j.name)).toEqual(["apply-wave-1", "apply-wave-2", "apply-wave-3"]);
  });

  it("is no declaration when the file is absent, not JSON, another schema, or the wrong shape", () => {
    expect(readTerragucciComponents(tmp())).toBeUndefined();
    const write = (text: string): string => {
      const dir = tmp();
      writeFileSync(join(dir, TERRAGUCCI_COMPONENTS_FILE), text);
      return dir;
    };
    expect(readTerragucciComponents(write("{ not json"))).toBeUndefined();
    const good = JSON.parse(readFileSync(join(REPO, TERRAGUCCI_COMPONENTS_FILE), "utf8"));
    expect(readTerragucciComponents(write(JSON.stringify({ ...good, schema: "terragucci.components/v2" })))).toBeUndefined();
    expect(readTerragucciComponents(write(JSON.stringify({ ...good, roots: { app: {} } })))).toBeUndefined();
    expect(readTerragucciComponents(write(JSON.stringify({ ...good, components: [{ name: "app", deploy: [] }] })))).toBeUndefined();
    expect(readTerragucciComponents(write(JSON.stringify({ ...good, pipeline: { jobs: [{ name: "x", needs: [] }] } })))).toBeUndefined();
    // Fields the format adds later are ignored, not refused.
    expect(readTerragucciComponents(write(JSON.stringify({ ...good, extra: 1 })))).toBeDefined();
  });
});

describe("the scaffold (#571)", () => {
  it("keys the roots by the declaration's names and dirs, not by discovery", () => {
    const d = decl();
    d.roots = { "net-core": { dir: "./network/" }, app: { dir: "app" } };
    expect(declaredRootScan(d)).toEqual({ roots: [{ name: "net-core", dir: "network" }, { name: "app", dir: "app" }], skipped: [] });
    expect(terraformMemberScan(REPO).scan.roots.map((r) => r.name).sort()).toEqual(["app", "edge", "network", "other"]);
    expect(terraformMemberScan(REPO).components).toBeDefined();
  });

  it("writes one component export per declared component, with a noRollback chant's lint asks for", () => {
    const text = terragucciComponentModule(decl());
    const exported = [...text.matchAll(/^export const (\w+) = (.*);$/gm)].map((m) => JSON.parse(m[2]!));
    expect(exported.map((c) => c.name)).toEqual(["network", "other", "app", "edge"]);
    expect(exported.find((c) => c.name === "app")).toEqual({
      name: "app",
      dependsOn: ["network"],
      deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "app", noRollback: SCAFFOLD_NO_ROLLBACK }] }],
    });
    expect(terragucciComponentModule(decl())).toBe(text);
  });

  it("writes the module and the declared config outside the repo, and empties the module when the declaration goes", () => {
    const before = memberSourceStamp(REPO);
    const { scan, components } = terraformMemberScan(REPO);
    const project = writeTerraformScratchProject(REPO, scan, tmp(), "tf", components);
    expect(memberSourceStamp(REPO)).toBe(before);
    expect(project.startsWith(REPO + sep)).toBe(false);
    expect(existsSync(join(REPO, TERRAGUCCI_COMPONENT_MODULE))).toBe(false);
    const config = readFileSync(join(project, "chant.config.ts"), "utf8");
    expect(config).toContain(`"network": { dir: "${ESTATE_LINK}/network" }`);
    expect(readFileSync(join(project, TERRAGUCCI_COMPONENT_MODULE), "utf8")).toBe(terragucciComponentModule(components!));

    writeTerraformScratchProject(REPO, discoverTerraformRoots(REPO), dirname(project));
    expect(readFileSync(join(project, TERRAGUCCI_COMPONENT_MODULE), "utf8")).not.toContain("export const");
  });

  it("reads a copied repo without its declaration as a plain terraform directory", () => {
    const copy = join(tmp(), "repo");
    cpSync(REPO, copy, { recursive: true, filter: (src) => !src.endsWith(TERRAGUCCI_COMPONENTS_FILE) });
    expect(terraformMemberScan(copy).components).toBeUndefined();
    expect(terraformMemberScan(copy).scan).toEqual(discoverTerraformRoots(copy));
  });
});

// What chant 0.124 answers for the fixture's scaffold (`chant graph
// --components --format ir`), trimmed to the fields read here.
const componentIr: GraphIR = {
  nodes: ["network", "app", "edge", "other"].map((id) => ({ id, kind: "Component", lexicon: "chant", attrs: {} })),
  edges: [
    { from: "app", to: "network", kind: "ref" },
    { from: "edge", to: "app", kind: "ref" },
  ],
  groups: { byWave: { "wave-1": ["network", "other"], "wave-2": ["app"], "wave-3": ["edge"] } } as GraphIR["groups"],
};

describe("the facets (#571)", () => {
  it("maps each component to the job that applies it", () => {
    expect(componentJobs(decl())).toEqual({
      network: { component: "network", jobName: "apply-wave-1", needs: ["check"], wave: 1 },
      other: { component: "other", jobName: "apply-wave-1", needs: ["check"], wave: 1 },
      app: { component: "app", jobName: "apply-wave-2", needs: ["apply-wave-1"], wave: 2 },
      edge: { component: "edge", jobName: "apply-wave-3", needs: ["apply-wave-2"], wave: 3 },
    });
  });

  it("prefers the wave job over a catch-all one, and names the catch-all", () => {
    const d = decl();
    d.pipeline.jobs.unshift({ name: "apply-comment", needs: ["plan"], applies: ["network", "other", "app", "edge"] });
    expect(componentJobs(d).app).toEqual({ component: "app", jobName: "apply-wave-2", needs: ["apply-wave-1"], wave: 2, alsoIn: ["apply-comment"] });
    // A job may name the root rather than the component.
    d.components[0]!.name = "net";
    expect(componentJobs(d).net?.jobName).toBe("apply-wave-1");
  });

  it("titles each wave box with the job(s) that apply its members", () => {
    expect(waveTitles(componentIr, decl())).toEqual({ "wave-1": "apply-wave-1", "wave-2": "apply-wave-2", "wave-3": "apply-wave-3" });
    const d = decl();
    d.pipeline.jobs[0]!.applies = ["network"];
    d.pipeline.jobs.push({ name: "apply-other", needs: ["check"], wave: 1, applies: ["other"] });
    expect(waveTitles(componentIr, d)["wave-1"]).toBe("apply-wave-1 + apply-other");
    const { svg } = renderGraph(componentIr, { waveTitles: waveTitles(componentIr, decl()) });
    expect(svg).toContain(">apply-wave-1<");
    expect(svg).toContain(">apply-wave-3<");
    expect(svg).not.toContain(">wave-1<");
  });

  it("joins a component to its root's resources on attrs.root", () => {
    const entities: GraphIR = {
      nodes: [
        { id: "network/terraform_data.release", kind: "Terraform::Resource", lexicon: "terraform", attrs: { root: "network" } },
        { id: "network/output.http_proxy_port", kind: "Terraform::Output", lexicon: "terraform", attrs: { root: "network" } },
        { id: "app/data.terraform_remote_state.network", kind: "terraform_remote_state", lexicon: "terraform", attrs: { root: "app", block: "data" } },
        { id: "app/variable.x", kind: "x", lexicon: "terraform", attrs: { root: "app", block: "variable" } },
      ],
      edges: [],
      groups: {} as GraphIR["groups"],
    };
    expect(componentRootMap(decl())).toEqual({ network: "network", other: "other", app: "app", edge: "edge" });
    const by = resourcesByRoot(entities, componentRootMap(decl()));
    expect(by.network!.map((r) => r.id)).toEqual(["network/terraform_data.release"]);
    expect(by.app!.map((r) => r.id)).toEqual(["app/data.terraform_remote_state.network"]);
    expect(by.edge).toEqual([]);
  });
});

describe("the components graph from the declaration, never from chant", () => {
  it("has one Component node per component, dependsOn edges consumer -> producer, and waves by depth", () => {
    const ir = componentsIrFromDeclaration(decl());
    expect(ir.nodes.map((n) => [n.id, n.kind, (n.attrs as { wave: number }).wave])).toEqual([
      ["network", "Component", 1],
      ["other", "Component", 1],
      ["app", "Component", 2],
      ["edge", "Component", 3],
    ]);
    expect(ir.edges.map((e) => `${e.from}->${e.to}`)).toEqual(expect.arrayContaining(["app->network", "edge->app"]));
    expect((ir.groups as { byWave: Record<string, string[]> }).byWave).toEqual({ "wave-1": ["network", "other"], "wave-2": ["app"], "wave-3": ["edge"] });
  });

  it("matches the wave titles the jobs give, so the boxes keep their pipeline names", () => {
    expect(waveTitles(componentsIrFromDeclaration(decl()), decl())).toEqual({ "wave-1": "apply-wave-1", "wave-2": "apply-wave-2", "wave-3": "apply-wave-3" });
  });

  it("ignores a dependsOn that names nothing and survives a cycle", () => {
    const d = decl();
    const odd: TerragucciComponents = {
      ...d,
      components: [
        { name: "a", dependsOn: ["b", "ghost", "a"], deploy: [] },
        { name: "b", dependsOn: ["a"], deploy: [] },
      ],
    };
    const ir = componentsIrFromDeclaration(odd);
    expect(ir.nodes).toHaveLength(2);
    expect(ir.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["a->b", "b->a"]);
  });

  it("draws a repo whose roots carry lint errors (literal provider credentials), with no chant run", () => {
    const dir = tmp();
    cpSync(REPO, dir, { recursive: true });
    writeFileSync(join(dir, "network", "main.tf"), 'provider "aws" {\n  access_key = "test"\n  secret_key = "test"\n}\n');
    const ir = componentsIrFromDeclaration(readTerragucciComponents(dir)!);
    expect(ir.nodes.map((n) => n.id)).toEqual(["network", "other", "app", "edge"]);
  });
});
