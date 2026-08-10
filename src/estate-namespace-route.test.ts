import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { spawn as spawnMock } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// #221 at the HTTP level: the estate overlay reading an app project in the
// namespace the CONTROL PLANE declares. src/estate.test.ts exercises the join
// against a mocked `graphIr`; this one mocks a layer deeper — `node:
// child_process`'s `spawn`, the same way server.test.ts and chant.test.ts do —
// so the argv chant would actually receive is the thing under test. The whole
// point of the change is a flag on a command line, and a mocked `graphIr`
// cannot show that `--namespace app-b` was ever spelled.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";

/** A minimal fake ChildProcess: emits `data` on stdout then `close`, once the
 * consumer attaches its `close` listener. Mirrors server.test.ts's `fakeProc`. */
function fakeProc(code: number, stdout = "", stderr = ""): ReturnType<typeof spawnMock> {
  const proc = new EventEmitter() as unknown as ReturnType<typeof spawnMock>;
  const out = new EventEmitter();
  const err = new EventEmitter();
  Object.assign(proc, { stdout: out, stderr: err });
  let fired = false;
  proc.on("newListener", (event) => {
    if (event !== "close" || fired) return;
    fired = true;
    queueMicrotask(() => {
      if (stdout) out.emit("data", Buffer.from(stdout));
      if (stderr) err.emit("data", Buffer.from(stderr));
      proc.emit("close", code);
    });
  });
  return proc;
}

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** The flux-estate demo in miniature, on disk: the app's `manifests/` really
 * there (the join checks it) and a chant new enough for chant#1629's flag
 * installed where both members resolve it (the join's version gate). */
function fixtureEstate(): { controlPlane: string; appB: string } {
  const root = mkdtempSync(join(tmpdir(), "behold-ns-route-"));
  made.push(root);
  const write = (rel: string, content: string): void => {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const chant = "node_modules/@intentius/chant";
  write(`${chant}/package.json`, JSON.stringify({ name: "@intentius/chant", version: "0.44.5", main: "index.js", bin: { chant: "bin/chant" } }));
  write(`${chant}/index.js`, "");
  write(`${chant}/bin/chant`, "#!/usr/bin/env node\n");
  write("example-flux-estate/control-plane/src/flux.ts", "");
  write("example-flux-estate/app-b/src/app.ts", "");
  write("example-flux-estate/app-b/manifests/app.yaml", "");
  return {
    controlPlane: join(root, "example-flux-estate", "control-plane"),
    appB: join(root, "example-flux-estate", "app-b"),
  };
}

/** The control plane's graph: a Namespace and the Kustomization carrying the
 * binding, both reconciled. `path` is what the join has to match. */
const controlPlaneIr = (path: string) => ({
  nodes: [
    { id: "nsAppB", kind: "K8s::Core::Namespace", lexicon: "k8s", attrs: { _status: "good", metadata: { name: "app-b" } } },
    {
      id: "appB",
      kind: "K8s::Flux::Kustomization",
      lexicon: "k8s",
      attrs: {
        _status: "good",
        metadata: { name: "app-b", namespace: "flux-system" },
        spec: { interval: "1m", path, targetNamespace: "app-b", sourceRef: { kind: "GitRepository", name: "behold" } },
      },
    },
  ],
  edges: [],
  groups: {},
});

/** The app project's graph. Its objects name no namespace — Flux stamps it at
 * apply time — so a read scoped to `app-b` finds them (`good`) and an
 * unscoped one looks in `default` and reports absence (`accent`). */
const appBIr = (status: "good" | "accent") => ({
  nodes: [
    { id: "deployment", kind: "K8s::Apps::Deployment", lexicon: "k8s", attrs: { _status: status, metadata: { name: "app-b" } } },
    { id: "service", kind: "K8s::Core::Service", lexicon: "k8s", attrs: { _status: status, metadata: { name: "app-b" } } },
  ],
  edges: [],
  groups: {},
});

function makeEstateApp(controlPlane: string, appB: string): ReturnType<typeof createApp> {
  const broadcaster = new Broadcaster();
  const runner = new OpRunner({ projectDir: controlPlane, broadcaster, onDone: () => {} });
  return createApp(
    { projectDir: controlPlane, projectDirs: [controlPlane, appB], env: "local", port: 0 },
    broadcaster,
    new FrameBuffer(),
    runner,
  );
}

/** Answer every `chant graph` the route makes, keyed by the spawn's cwd (the
 * member) and whether the invocation is the live read. The app project's live
 * answer depends on the argv: scoped to `app-b` it finds the objects, unscoped
 * it does not — which is exactly what chant does on the real cluster. */
function wireSpawn(controlPlane: string, appB: string, path: string): void {
  vi.mocked(spawnMock).mockImplementation(((_bin: string, args?: string[], opts?: { cwd?: string }) => {
    // Anything that isn't one of the two members' chant (the kubeconfig
    // probe, a substrate detector) fails harmlessly — every caller of those
    // treats a non-zero exit as "no opinion".
    if (!args || !opts?.cwd) return fakeProc(1);
    if (opts.cwd === controlPlane) return fakeProc(0, JSON.stringify(controlPlaneIr(path)));
    if (opts.cwd !== appB) return fakeProc(1);
    const live = args.includes("--live");
    const scoped = args[args.indexOf("--namespace") + 1] === "app-b";
    return fakeProc(0, JSON.stringify(appBIr(live && !scoped ? "accent" : "good")));
  }) as unknown as typeof spawnMock);
}

/** The argv of the live read issued in `dir`. */
const liveArgv = (dir: string): string[] | undefined =>
  vi.mocked(spawnMock).mock.calls.find(
    ([, args, opts]) => (opts as { cwd?: string })?.cwd === dir && (args as string[]).includes("--live"),
  )?.[1] as string[] | undefined;

describe("GET /api/overlay — the estate joins Kustomization targetNamespace (#221)", () => {
  beforeEach(() => vi.mocked(spawnMock).mockReset());

  it("spells --namespace app-b on the app project's own chant invocation, and only that one", async () => {
    const { controlPlane, appB } = fixtureEstate();
    wireSpawn(controlPlane, appB, "./example-flux-estate/app-b/manifests");

    const res = await makeEstateApp(controlPlane, appB).request("/api/overlay?env=local");
    expect(res.status).toBe(200);

    const argv = liveArgv(appB)!;
    expect(argv).toContain("--namespace");
    expect(argv[argv.indexOf("--namespace") + 1]).toBe("app-b");
    // The control plane's objects declare their own namespace; scoping its
    // read would be a default nobody asked for.
    expect(liveArgv(controlPlane)).not.toContain("--namespace");
  });

  it("paints the app project's objects live, and trades #192's note for the line naming where it read", async () => {
    const { controlPlane, appB } = fixtureEstate();
    wireSpawn(controlPlane, appB, "./example-flux-estate/app-b/manifests");

    const res = await makeEstateApp(controlPlane, appB).request("/api/overlay?env=local");
    const body = (await res.json()) as { ir: { nodes: { id: string; attrs?: { _status?: string } }[] }; meta: { note?: string } };

    const status = Object.fromEntries(body.ir.nodes.map((n) => [n.id, n.attrs?._status]));
    expect(status["app-b/deployment"]).toBe("good");
    expect(status["app-b/service"]).toBe("good");
    expect(body.meta.note).toContain('read app-b in "app-b"');
    expect(body.meta.note).not.toContain("declare no metadata.namespace");
  });

  it("leaves the pre-#221 picture exactly as it was when no declared path points at the member", async () => {
    const { controlPlane, appB } = fixtureEstate();
    // A path into a sibling that this estate does not contain: no alignment,
    // so no join — the conservative answer, and the old behaviour.
    wireSpawn(controlPlane, appB, "./example-flux-estate/app-a/manifests");

    const res = await makeEstateApp(controlPlane, appB).request("/api/overlay?env=local");
    const body = (await res.json()) as { ir: { nodes: { id: string; attrs?: { _status?: string } }[] }; meta: { note?: string } };

    expect(liveArgv(appB)).not.toContain("--namespace");
    const status = Object.fromEntries(body.ir.nodes.map((n) => [n.id, n.attrs?._status]));
    expect(status["app-b/deployment"]).toBe("accent");
    expect(body.meta.note).toContain("declare no metadata.namespace");
    expect(body.meta.note).not.toContain("read app-b in");
  });
});
