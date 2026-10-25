import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { ADOPTERS, ADOPTION_WAITS, adopterFor, adoptionRoutes } from "./adoption.ts";
import { Broadcaster } from "./events.ts";
import { OpRunner } from "./op-runner.ts";
import { publicReadRefusal } from "./public-mode.ts";
import {
  assertClassificationOnly,
  confirmCommandLine,
  parsePlungeAdopt,
  plungeBackendFor,
  plungeClassifyArgv,
  plungeEnv,
  pulumiPlanFor,
  stackFor,
  urnParts,
  type SpawnPlunge,
} from "./pulumi-adoption.ts";
import type { Workspace } from "./workspace.ts";

// behold#999, the Pulumi half. plunge's text is what
// pkg/cmd/pulumi/stack/stack_adopt.go `printAdoption` prints, and its refusal
// what pkg/backend/plunge/adopt.go `AdoptRefusedError` says, at plunge
// integration/pulumi-engine 3ea6673405.
const URNS = {
  bucket: "urn:pulumi:dev::app::aws:s3/bucket:Bucket::assets",
  role: "urn:pulumi:dev::app::aws:iam/role:Role::web",
  fn: "urn:pulumi:dev::app::my:mod:Web$aws:lambda/function:Function::handler",
  dep: "urn:pulumi:dev::app::kubernetes:apps/v1:Deployment::api",
  svc: "urn:pulumi:dev::app::aws-native:apprunner:Service::svc",
};
const CLASSIFIED = [
  "Adopting dev (checkpoint digest 0a1b2c):",
  `  ${URNS.bucket}  assets-1  ownership: pending (classed at the first run, from the provider's schema)`,
  `  ${URNS.dep}  default/api  ownership: marker`,
  `  ${URNS.role}    ownership: record (the type has no tags)`,
  `  ${URNS.fn}  fn  ownership: pending (classed at the first run, from the provider's schema)`,
  "",
].join("\n");
const UNCONFIRMED = "error: non-interactive mode requires --yes flag\n";
const REFUSED = [
  "error: plunge: refusing to adopt dev; nothing was written:",
  "  - the checkpoint has pending operations, which stock Pulumi must settle first (`pulumi refresh` or `pulumi stack export`/`import` after checking the cloud): urn:pulumi:dev::app::aws:s3/bucket:Bucket::assets (creating)",
  `  - plunge: refusing to mark ${URNS.svc}: aws-native:apprunner:Service's "tags" can only be set when the resource is created, so adding the ownership marker would replace the live resource, and plunge never replaces a resource to mark it. Leave this stack on stock Pulumi, or remove the resource from the stack before adopting`,
  "",
].join("\n");

describe("reading plunge stack adopt (behold#999)", () => {
  it("lists every resource plunge classed, with its fate, and treats the missing --yes as the gate holding", () => {
    const c = parsePlungeAdopt(CLASSIFIED, UNCONFIRMED);
    expect(c.outcome).toBe("classified");
    expect(c.stack).toBe("dev");
    expect(c.digest).toBe("0a1b2c");
    expect(c.entries.map((e) => e.urn)).toEqual([URNS.bucket, URNS.dep, URNS.role, URNS.fn]);
    expect(c.entries.map((e) => e.ownership)).toEqual(["pending", "marker", "record", "pending"]);
    expect(c.entries.every((e) => e.fate === "claimed" && e.why.length > 0)).toBe(true);
    // An empty ID still reads, and plunge's reason is kept verbatim.
    const role = c.entries.find((e) => e.urn === URNS.role)!;
    expect(role.id).toBe("");
    expect(role.detail).toBe("the type has no tags");
    expect(c.said).toBe("");
  });

  it("names every reason plunge refused for, and the resource it names", () => {
    const c = parsePlungeAdopt("", REFUSED);
    expect(c.outcome).toBe("refused");
    expect(c.entries).toEqual([]);
    expect(c.refused).toHaveLength(2);
    expect(c.refused[0]!.reason).toMatch(/pending operations/);
    expect(c.refused[0]!.urn).toBe(URNS.bucket);
    expect(c.refused[1]!.urn).toBe(URNS.svc);
  });

  it("says already adopted, and an ownership it does not know is unknown, not dropped", () => {
    const again = parsePlungeAdopt(`dev was already adopted from this checkpoint (digest 0a1b2c); nothing was written.\n  ${URNS.bucket}  assets-1  ownership: marker\n`, "");
    expect(again.outcome).toBe("already-adopted");
    expect(again.entries).toHaveLength(1);
    const odd = parsePlungeAdopt(`Adopting dev (checkpoint digest 0a):\n  ${URNS.bucket}  assets-1  ownership: borrowed\n`, UNCONFIRMED);
    expect(odd.entries[0]!.fate).toBe("unknown");
  });

  it("detects a plunge without stack adopt from its answer, not a version", () => {
    expect(parsePlungeAdopt("", 'error: unknown command "adopt" for "plunge stack"\n').outcome).toBe("no-adopt");
    expect(parsePlungeAdopt("", "error: no stack named 'dev' found\n").outcome).toBe("failed");
  });

  it("reads a URN's type and name, a parent's type left off", () => {
    expect(urnParts(URNS.fn)).toEqual({ type: "aws:lambda/function:Function", name: "handler" });
  });
});

describe("what behold runs, and what it never runs", () => {
  it("classifies only: never --yes, -y or --file, always non-interactive", () => {
    const argv = plungeClassifyArgv("dev");
    expect(() => assertClassificationOnly(argv)).not.toThrow();
    expect(argv).not.toContain("--yes");
    for (const bad of [[...argv, "--yes"], [...argv, "-y"], [...argv, "--yes=true"], [...argv, "--file", "x.json"], ["up"], ["stack", "adopt", "--stack", "dev"]]) {
      expect(() => assertClassificationOnly(bad)).toThrow(/never to confirm/);
    }
  });

  it("drops PULUMI_SKIP_CONFIRMATIONS and points plunge at the member's backend", () => {
    const env = plungeEnv({ PATH: "/bin", PULUMI_SKIP_CONFIRMATIONS: "true", PULUMI_BACKEND_URL: "https://api.pulumi.com" }, "plunge+file:///s");
    expect(env.PULUMI_SKIP_CONFIRMATIONS).toBeUndefined();
    expect(env.PULUMI_BACKEND_URL).toBe("plunge+file:///s");
    expect(env.PATH).toBe("/bin");
  });

  it("takes the backend from Pulumi.yaml: a DIY url becomes plunge+, a plunge one stays, anything else is not offered", () => {
    const dir = mkdtempSync(join(tmpdir(), "behold-plunge-backend-"));
    const yaml = (body: string) => writeFileSync(join(dir, "Pulumi.yaml"), body);
    yaml("name: app\nruntime: nodejs\nbackend:\n  url: file:///var/lib/pulumi\n");
    expect(plungeBackendFor(dir)).toEqual({ ok: true, url: "plunge+file:///var/lib/pulumi", declared: "file:///var/lib/pulumi", onPlunge: false });
    yaml("name: app\nruntime: nodejs\nbackend:\n  url: plunge+s3://b/p\n");
    expect(plungeBackendFor(dir)).toMatchObject({ ok: true, url: "plunge+s3://b/p", onPlunge: true });
    yaml("name: app\nruntime: nodejs\nbackend:\n  url: https://api.pulumi.com\n");
    expect(plungeBackendFor(dir)).toMatchObject({ ok: false, declared: "https://api.pulumi.com" });
    yaml("name: app\nruntime: nodejs\n");
    expect(plungeBackendFor(dir)).toMatchObject({ ok: false, declared: null });
  });

  it("reads the stack off the checked-in export, and refuses a stack that looks like a flag", () => {
    const root = mkdtempSync(join(tmpdir(), "behold-plunge-stack-"));
    writeFileSync(join(root, "stack-export.json"), JSON.stringify({ version: 3, deployment: { resources: [{ urn: URNS.bucket }] } }));
    const m = { name: "app", dir: "app", kind: "pulumi", abs: root, reason: null, because: null };
    expect(stackFor(m)).toEqual({ ok: true, stack: "dev", from: "export" });
    expect(stackFor(m, "prod")).toEqual({ ok: true, stack: "prod", from: "request" });
    expect(stackFor(m, "--yes")).toMatchObject({ ok: false });
  });

  it("puts --yes only in the confirm line a person runs", () => {
    expect(confirmCommandLine("app", "plunge+file:///s", "dev")).toBe("cd app && PULUMI_BACKEND_URL=plunge+file:///s plunge stack adopt --stack dev --yes");
  });
});

// A workspace with a stock Pulumi stack on a DIY backend, one with no backend
// url, a terraform root (its half is on the other path) and a chant member.
function workspace(): { ws: Workspace; root: string } {
  const root = mkdtempSync(join(tmpdir(), "behold-adopt-pulumi-"));
  for (const d of ["app", "loose", "net", "web"]) mkdirSync(join(root, d));
  writeFileSync(join(root, "app", "Pulumi.yaml"), "name: app\nruntime: nodejs\nbackend:\n  url: file:///var/lib/pulumi/app\n");
  writeFileSync(join(root, "app", "stack-export.json"), JSON.stringify({ version: 3, deployment: { resources: [{ urn: URNS.bucket }] } }));
  writeFileSync(join(root, "loose", "Pulumi.yaml"), "name: loose\nruntime: nodejs\n");
  const m = (name: string, kind: string) => ({ name, dir: name, kind, abs: join(root, name), reason: null, because: null });
  return { root, ws: { name: "w", root, file: "chant.workspace.json", chant: "0.124.34", members: [m("app", "pulumi"), m("loose", "pulumi"), m("net", "terraform"), m("web", "chant")] } };
}

function served({ preview = false, stdout = CLASSIFIED, stderr = UNCONFIRMED, exit = 255 }: { preview?: boolean; stdout?: string; stderr?: string; exit?: number } = {}) {
  const { ws, root } = workspace();
  const broadcaster = new Broadcaster();
  const runner = new OpRunner({ projectDir: root, broadcaster, onDone: () => {} });
  const spawned: { args: string[]; cwd: string; env: Record<string, string> }[] = [];
  const spawnPlunge: SpawnPlunge = (args, cwd, env, out, err) => {
    assertClassificationOnly(args);
    spawned.push({ args, cwd, env });
    out(stdout);
    err(stderr);
    return { done: Promise.resolve(exit) };
  };
  const app = new Hono();
  // The Terraform half's chant floor is not met here (chantVersion 0.0.1): it must hold only the terraform root, never the pulumi stack.
  adoptionRoutes(app, {
    workspace: () => ws,
    runner,
    broadcaster,
    readReport: async () => {
      throw new Error("no terraform read in this test");
    },
    chantVersion: () => "0.0.1",
    preview: () => preview,
    spawnPlunge,
    env: () => ({ PATH: "/bin", PULUMI_SKIP_CONFIRMATIONS: "1" }),
  });
  const post = (body: unknown) => app.request("/api/adopt/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = async (url: string) => {
    const r = await app.request(url);
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  return { app, post, get, root, spawned, runner };
}

describe("the adoption routes for a pulumi member (behold#999)", () => {
  it("keys the adopter on the member kind, in the table the Terraform half shares", () => {
    expect(adopterFor("pulumi")?.engine).toBe("plunge");
    expect(Object.keys(ADOPTERS).sort()).toEqual(["pulumi", "terraform"]);
    expect(ADOPTION_WAITS.pulumi).toBeUndefined();
  });

  it("offers the stock stack, with what it gains and the command, and says why a stack with no backend url has no start", async () => {
    const s = served();
    const { body } = await s.get("/api/adopt");
    const app = body.offers.find((o: any) => o.member === "app");
    expect(app).toMatchObject({ offered: true, engine: "plunge", stack: { name: "dev", from: "export" }, backend: { url: "plunge+file:///var/lib/pulumi/app" }, start: { offered: true } });
    expect(app.gains.join(" ")).toMatch(/no stack lock|per resource|marker/i);
    expect(app.command).not.toMatch(/--yes/);
    expect(app.confirm).toMatch(/--yes$/);
    const loose = body.offers.find((o: any) => o.member === "loose");
    expect(loose.start).toMatchObject({ offered: false });
    expect(loose.start.why).toMatch(/backend\.url/);
    // The terraform root is the Terraform half's: offered to choudoufu. Its chant floor never holds the pulumi offer.
    expect(body.offers.find((o: any) => o.member === "net")).toMatchObject({ engine: "choudoufu" });
    expect(body.refusal).toMatchObject({ code: "chant-too-old" });
    expect(body.offers.some((o: any) => o.member === "web")).toBe(false);
    expect(s.spawned).toHaveLength(0);
  });

  it("the report is the classification: every resource with its fate, run without --yes and without PULUMI_SKIP_CONFIRMATIONS", async () => {
    const s = served();
    const { status, body } = await s.get("/api/adopt/report?member=app");
    expect(status).toBe(200);
    expect(body.outcome).toBe("classified");
    expect(body.report.total).toBe(4);
    expect(body.report.byOwnership).toEqual({ pending: 2, marker: 1, record: 1 });
    expect(body.confirm).toMatch(/plunge stack adopt --stack dev --yes$/);
    expect(s.spawned).toHaveLength(1);
    expect(s.spawned[0]!.args).not.toContain("--yes");
    expect(s.spawned[0]!.cwd).toBe(join(s.root, "app"));
    expect(s.spawned[0]!.env.PULUMI_SKIP_CONFIRMATIONS).toBeUndefined();
    expect(s.spawned[0]!.env.PULUMI_BACKEND_URL).toBe("plunge+file:///var/lib/pulumi/app");
  });

  it("a refused adoption lists each reason and offers no confirm", async () => {
    const s = served({ stdout: "", stderr: REFUSED });
    const { body } = await s.get("/api/adopt/report?member=app");
    expect(body.outcome).toBe("refused");
    expect(body.refused).toHaveLength(2);
    expect(body.confirm).toBeUndefined();
  });

  it("start runs the classification through the runner and answers the confirm line; nothing it ran confirms", async () => {
    const s = served();
    const r = await s.post({ member: "app" });
    expect(r.status).toBe(202);
    const started = (await r.json()) as Record<string, any>;
    expect(started.confirm).toMatch(/--yes$/);
    await vi.waitFor(() => expect(s.runner.running).toBeNull());
    const { body } = await s.get(`/api/adopt/runs/${started.id}`);
    expect(body.outcome).toBe("classified");
    expect(body.words).toMatch(/nothing was written/);
    expect(s.spawned.every((x) => !x.args.some((a) => a === "-y" || a.startsWith("--yes")))).toBe(true);
  });

  it("refuses a start in preview and a stack named like a flag, and leaves any other kind to the Terraform half's checks", async () => {
    expect((await served({ preview: true }).post({ member: "app" })).status).toBe(403);
    const s = served();
    expect((await s.post({ member: "app", stack: "--yes" })).status).toBe(422);
    // A chant member goes the Terraform half's way, whose chant floor (not met here) answers first.
    expect((await s.post({ member: "web" })).status).toBe(409);
    expect(s.spawned).toHaveLength(0);
  });

  it("is refused in a public view", () => {
    expect(publicReadRefusal("/api/adopt", new URLSearchParams())).toBeTruthy();
    expect(publicReadRefusal("/api/adopt/report", new URLSearchParams())).toBeTruthy();
  });

  it("a member's plan is refused before anything is spawned when it has no directory", () => {
    expect(pulumiPlanFor({ name: "x", dir: "x", kind: "pulumi", abs: "", reason: null, because: null })).toMatchObject({ ok: false });
  });
});
