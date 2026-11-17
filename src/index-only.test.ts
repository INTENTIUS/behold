// behold#1026: while behold serves a directory with no chant project (an index store only),
// every route that acts refuses with 409, and the ones it still answers are the listed ones.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./server.ts";
import { INDEX_ONLY_WRITES, indexOnlyRefusal } from "./index-only.ts";
import { LOCAL_INDEX_DIR } from "./graph-db/sources.ts";

const FIXTURES = join(import.meta.dirname, "graph-db", "__fixtures__");
const headers = { host: "127.0.0.1", origin: "http://127.0.0.1", "content-type": "application/json" };

function indexOnlyDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-index-only-"));
  const idx = JSON.parse(readFileSync(join(FIXTURES, "index.json"), "utf8")) as { stamp: { scopeKey: string } };
  const scopeDir = join(dir, LOCAL_INDEX_DIR, ...idx.stamp.scopeKey.split("/"));
  mkdirSync(scopeDir, { recursive: true });
  writeFileSync(join(scopeDir, "20261026T120000Z-e2f92b265a4d.json"), JSON.stringify(idx));
  return dir;
}

const concrete = (p: string) => p.replace(/:[A-Za-z]+/g, "x");
const listed = (method: string, path: string) => INDEX_ONLY_WRITES.some((w) => w.method === method && w.pattern.test(path));

describe("an index-only serve refuses every route that acts", () => {
  it("answers 409 with the no-project message on each non-GET route not on the list, and starts nothing", async () => {
    const app = createApp({ projectDir: indexOnlyDir(), port: 0 });
    const writes = app.routes.filter((r) => r.method !== "GET" && r.method !== "ALL");
    const acting = writes.filter((r) => !listed(r.method, concrete(r.path)));
    // The walk is only worth something if it reaches the routes that matter.
    for (const must of ["/api/rollback", "/api/apply", "/api/ops/:name/run", "/api/operator/approve/:op/:gate", "/api/ops/:name/signal/:gate", "/api/ci/dispatch"]) {
      expect(acting.map((r) => r.path), must).toContain(must);
    }
    for (const r of acting) {
      const path = concrete(r.path);
      const res = await app.request(`${path}?to=HEAD&env=local`, { method: r.method, headers, body: "{}" });
      const body = (await res.json()) as { error?: string; code?: string };
      expect(res.status, `${r.method} ${path}`).toBe(409);
      expect(body.code, `${r.method} ${path}`).toBe("no-project");
      expect(body.error, `${r.method} ${path}`).toContain("there is no chant project here, so behold only reads");
    }
  });

  it("answers the listed writes, which the guard does not touch", () => {
    for (const w of INDEX_ONLY_WRITES) expect(indexOnlyRefusal(w.method, w.pattern.source.replace(/\\\//g, "/").replace(/[\^$]/g, "")), w.why).toBeUndefined();
    expect(indexOnlyRefusal("GET", "/api/graph")).toBeUndefined();
    expect(indexOnlyRefusal("POST", "/api/rollback")).toMatchObject({ code: "no-project" });
  });

  it("does not refuse once a chant project is served", async () => {
    const dir = indexOnlyDir();
    writeFileSync(join(dir, "chant.config.ts"), "export default { lexicons: [] };\n");
    const app = createApp({ projectDir: dir, port: 0 });
    const res = await app.request("/api/ops/x/run", { method: "POST", headers, body: "{}" });
    expect(res.status).toBe(404); // "no Op named x": the route's own answer, not the guard's
  });
});
