import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import { refusedWrite, terragucciConfig, TERRAGUCCI_REFUSED_WRITES } from "./terragucci-repo.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-tg-"));
  made.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

function app(projectDir: string) {
  const broadcaster = new Broadcaster();
  return createApp({ projectDir, port: 0 }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir, broadcaster, onDone: () => {} }));
}

describe("terragucciConfig (#489)", () => {
  it("finds terragucci.yml in the served directory", () => {
    const dir = repo({ ".git/HEAD": "", "terragucci.yml": "binary: tofu\n" });
    expect(terragucciConfig(dir)).toBe(join(dir, "terragucci.yml"));
  });

  it("finds it above a served subdirectory, up to the git root", () => {
    const dir = repo({ ".git/HEAD": "", "terragucci.yaml": "", "envs/prod/main.tf": "" });
    expect(terragucciConfig(join(dir, "envs/prod"))).toBe(join(dir, "terragucci.yaml"));
  });

  it("does not look past the git root", () => {
    const dir = repo({ "terragucci.yml": "", "inner/.git/HEAD": "", "inner/main.tf": "" });
    expect(terragucciConfig(join(dir, "inner"))).toBeUndefined();
  });

  it("is undefined for a repo without one", () => {
    expect(terragucciConfig(repo({ ".git/HEAD": "", "main.tf": "" }))).toBeUndefined();
  });
});

describe("a terragucci repo refuses every write that deploys, approves or starts a run (#489)", () => {
  const writes = [
    "/api/apply?env=prod",
    "/api/local/reset",
    "/api/ops/prod-apply/run",
    "/api/ops/prod-apply/signal/approve",
    "/api/operator/approve/prod-apply/approve",
    "/api/workspace/gates/approve",
    "/api/substrates/floci/up",
    "/api/ci/dispatch?env=prod",
    "/api/ci/readopt",
    "/api/rollback?to=HEAD~1",
  ];

  it.each(writes)("POST %s answers 409 terragucci, naming the pipeline", async (path) => {
    const dir = repo({ ".git/HEAD": "", "terragucci.yml": "binary: tofu\n" });
    const res = await app(dir).request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string; remedy: string };
    expect(body.code).toBe("terragucci");
    expect(body.error).toContain("applied by its pipeline only");
    expect(body.remedy).toContain("terragucci approve wave-<k>");
  });

  it("refuses from a served subdirectory of the repo too", async () => {
    const dir = repo({ ".git/HEAD": "", "terragucci.yml": "", "envs/prod/main.tf": "" });
    const res = await app(join(dir, "envs/prod")).request("/api/apply?env=prod", { method: "POST" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("terragucci");
  });

  it("leaves a repo without terragucci alone", async () => {
    const dir = repo({ ".git/HEAD": "" });
    const res = await app(dir).request("/api/apply", { method: "POST" });
    expect(((await res.json()) as { code?: string }).code).not.toBe("terragucci");
  });

  it("tells the page, so it offers no Deploy", async () => {
    const dir = repo({ ".git/HEAD": "", "terragucci.yml": "" });
    const project = (await (await app(dir).request("/api/project")).json()) as { terragucci?: { config: string; code: string } };
    expect(project.terragucci?.config).toBe(join(dir, "terragucci.yml"));
    expect(project.terragucci?.code).toBe("terragucci");
  });

  // A new POST route has to be put on one side or the other: refused on a
  // terragucci repo, or named here as one that writes nothing outside behold.
  it("classifies every POST route behold registers", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "server.ts"), "utf8");
    const posts = [...src.matchAll(/app\.post\("([^"]+)"/g)].map((m) => m[1]!.replace(/:[a-z]+/g, "x"));
    const notWrites = new Set([
      "/api/carve/emit", // the carve walkthrough's scratch dir
      "/api/carve/bridge",
      "/api/carve/observe",
      "/api/carve/plan",
      "/api/project/open", // switching what is served
      "/api/project/reveal",
      "/api/demos/open",
      "/api/layout", // the layout sidecar
      "/api/refresh", // drops caches
    ]);
    const unclassified = posts.filter((p) => !notWrites.has(p) && !refusedWrite(p));
    expect(unclassified).toEqual([]);
    expect(TERRAGUCCI_REFUSED_WRITES.length).toBe(posts.length - notWrites.size);
  });
});
