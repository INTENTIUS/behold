// The HTTP half of #268: the bundled demo catalog, one click from the panel's
// switcher. Two things are worth proving at the route level — that the listing
// carries per-entry satisfiability (so a demo needing k3d renders disabled with
// a reason instead of vanishing), and that the loader takes a catalog NAME and
// nothing else, so it cannot be aimed at a directory outside the install.
//
// `loadDemo` and `missingRequirements` are mocked: the real ones copy hundreds
// of files, shell out to npm, and probe the operator's PATH — none of which
// belongs in a route test. The fake loader still MAKES the target directory
// (with a chant.config.ts), because the route's post-load check is part of
// what's under test.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DemoEntry, DemoLoadOptions } from "./demos.ts";

// vi.mock is hoisted above the imports, so the spies have to be too; their
// implementations are installed below, where fs is in scope.
const loadDemoMock = vi.hoisted(() => vi.fn<(entry: DemoEntry, opts: DemoLoadOptions) => Promise<unknown>>());
const missingMock = vi.hoisted(() => vi.fn<(entry: DemoEntry) => string[]>());

vi.mock("./demos.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./demos.ts")>();
  return { ...actual, loadDemo: loadDemoMock, missingRequirements: missingMock };
});

/** The fake loader: no copy, no npm — but it does make the target directory a
 * chant project, because the route checks that before it switches. */
const fakeLoad = async (entry: DemoEntry, opts: DemoLoadOptions) => {
  const dirs = entry.serve.dirs?.length ? entry.serve.dirs.map((d) => join(opts.target, d)) : [opts.target];
  for (const d of dirs) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "chant.config.ts"), `export default { lexicons: ["aws"] };`);
  }
  return { ok: true as const, serveDirs: dirs };
};
// Every declared requirement is missing — deterministic on a laptop and on a
// runner, which the real PATH probe is not.
const fakeMissing = (entry: DemoEntry): string[] => [...entry.requires];

import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";

interface DemoRow {
  name: string;
  description: string;
  satisfiable: boolean;
  reason?: string;
  fetches: boolean;
  repo?: string;
  target: string;
  loaded: boolean;
}

const cwd = process.cwd();
let sandbox: string;
let store: string;

beforeAll(() => {
  // Demos load into `<cwd>/behold-demos/<name>` — run the whole file from a
  // throwaway directory so nothing lands in the checkout.
  // realpath: on macOS the tmpdir is a symlink (/var → /private/var) and the
  // route resolves the target through the real cwd.
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "behold-demo-route-")));
  store = mkdtempSync(join(tmpdir(), "behold-demo-recents-"));
  process.env.BEHOLD_RECENTS_FILE = join(store, "recents.json");
  process.chdir(sandbox);
});
afterAll(() => {
  process.chdir(cwd);
  delete process.env.BEHOLD_RECENTS_FILE;
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
});
beforeEach(() => {
  loadDemoMock.mockReset().mockImplementation(fakeLoad);
  missingMock.mockReset().mockImplementation(fakeMissing);
});

function makeApp(opts: { previewMode?: boolean } = {}) {
  const broadcaster = new Broadcaster();
  const projectDir = join(sandbox, "served");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "chant.config.ts"), `export default { lexicons: ["aws"] };`);
  const runner = new OpRunner({ projectDir, broadcaster, onDone: () => {} });
  return createApp({ projectDir, port: 0, ...opts }, broadcaster, new FrameBuffer(), runner);
}

const post = (app: ReturnType<typeof makeApp>, body: unknown) =>
  app.request("/api/demos/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("GET /api/demos — the catalog, with per-entry satisfiability (#268)", () => {
  it("lists the committed catalog, each row saying whether it can run here", async () => {
    const res = await makeApp().request("/api/demos");
    expect(res.status).toBe(200);
    const { demos } = (await res.json()) as { demos: DemoRow[] };

    // The real demos.json (#209) is what ships, so it is what the panel lists.
    expect(demos.map((d) => d.name)).toEqual(expect.arrayContaining(["writes", "k8s", "argo-estate", "fountain"]));
    expect(demos.every((d) => typeof d.description === "string" && d.description.length > 0)).toBe(true);

    // argo-estate declares no requirements — always offerable, even where
    // Docker isn't. k8s wants docker/k3d/kubectl, which the mocked probe says
    // are missing: it stays in the list, disabled, with the reason.
    const argo = demos.find((d) => d.name === "argo-estate")!;
    expect(argo.satisfiable).toBe(true);
    expect(argo.reason).toBeUndefined();
    const k8s = demos.find((d) => d.name === "k8s")!;
    expect(k8s.satisfiable).toBe(false);
    expect(k8s.reason).toMatch(/needs docker, k3d, kubectl on PATH/);
  });

  it("flags the entry that would reach the network, and names the repo", async () => {
    const { demos } = (await (await makeApp().request("/api/demos")).json()) as { demos: DemoRow[] };
    const fountain = demos.find((d) => d.name === "fountain")!;
    expect(fountain.fetches).toBe(true);
    expect(fountain.repo).toContain("github.com/INTENTIUS/fountain-ops");
    // Copying out of the tarball is not a fetch, and must not claim to be.
    expect(demos.filter((d) => d.fetches).map((d) => d.name)).toEqual(["fountain"]);
  });

  it("reports whether a demo is already on disk, at the same path the CLI uses", async () => {
    const before = (await (await makeApp().request("/api/demos")).json()) as { demos: DemoRow[] };
    const argo = before.demos.find((d) => d.name === "argo-estate")!;
    expect(argo.target).toBe(join(sandbox, "behold-demos", "argo-estate"));
    expect(argo.loaded).toBe(false);

    mkdirSync(argo.target, { recursive: true });
    const after = (await (await makeApp().request("/api/demos")).json()) as { demos: DemoRow[] };
    expect(after.demos.find((d) => d.name === "argo-estate")!.loaded).toBe(true);
    rmSync(argo.target, { recursive: true, force: true });
  });

  it("says so when preview mode has the loader locked", async () => {
    const body = (await (await makeApp({ previewMode: true }).request("/api/demos")).json()) as { locked?: string };
    expect(body.locked).toMatch(/preview mode/);
  });
});

describe("POST /api/demos/open — a catalog name, never a path (#268)", () => {
  it("loads the named demo through the CLI's own code path and switches to it", async () => {
    const app = makeApp();
    const res = await post(app, { name: "argo-estate" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { demo: string; projectDir: string; projectDirs: string[]; env: string | null };

    // The shared loader ran, aimed at the catalog's own target directory.
    expect(loadDemoMock).toHaveBeenCalledTimes(1);
    const [entry, opts] = loadDemoMock.mock.calls[0];
    expect(entry.name).toBe("argo-estate");
    expect(opts.target).toBe(join(sandbox, "behold-demos", "argo-estate"));
    expect(existsSync(join(opts.pkgRoot, "demos.json"))).toBe(true);

    // #211: an estate demo is served composed, primary first — the same
    // serveDirs `behold demo argo-estate` would hand to `serve a b c`.
    expect(body.demo).toBe("argo-estate");
    expect(body.projectDirs).toHaveLength(3);
    expect(body.projectDir).toBe(body.projectDirs[0]);
    expect(body.projectDir).toBe(join(sandbox, "behold-demos", "argo-estate", "control-plane"));

    // And the server really switched: the routes read the demo now.
    const info = (await (await app.request("/api/project")).json()) as { projectDir: string; projectDirs?: string[] };
    expect(info.projectDir).toBe(body.projectDir);
    expect(info.projectDirs).toEqual(body.projectDirs);
  });

  it("400s a path instead of a name — the endpoint cannot be aimed outside the install", async () => {
    const app = makeApp();
    for (const name of [sandbox, join(sandbox, "served"), "../../etc", "./example-k8s", "/etc"]) {
      const res = await post(app, { name });
      expect(res.status, `${name} was accepted`).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/demo catalog/);
    }
    // A name with no catalog entry is refused the same way, as is no name.
    expect((await post(app, { name: "not-a-demo" })).status).toBe(400);
    expect((await post(app, {})).status).toBe(400);
    expect(loadDemoMock).not.toHaveBeenCalled();
  });

  it("400s a demo whose prerequisites are missing, with the same reason the listing showed", async () => {
    const res = await post(makeApp(), { name: "k8s" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/needs docker, k3d, kubectl on PATH/);
    expect(loadDemoMock).not.toHaveBeenCalled();
  });

  it("403s in preview mode — the demo build's no-arbitrary-switching contract", async () => {
    const res = await post(makeApp({ previewMode: true }), { name: "argo-estate" });
    expect(res.status).toBe(403);
    expect(loadDemoMock).not.toHaveBeenCalled();
  });

  it("surfaces a loader failure as an error, and leaves the served project alone", async () => {
    const app = makeApp();
    const served = ((await (await app.request("/api/project")).json()) as { projectDir: string }).projectDir;
    loadDemoMock.mockResolvedValueOnce({ ok: false, error: "clone of https://x/y failed" } as never);
    const res = await post(app, { name: "argo-estate" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/clone of/);
    expect(((await (await app.request("/api/project")).json()) as { projectDir: string }).projectDir).toBe(served);
  });
});
