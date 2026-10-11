import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { S3Error } from "./s3-object.ts";
import { IMMUTABLE, NO_CACHE } from "./export.ts";
import { commitFiles, DEFAULT_KEEP, nextHistory, parseHistory, publishSnapshot, redirectPage, resolveCommit, type HistoryEntry } from "./publish-snapshots.ts";

// #510: a published view is one bundle per commit under views/<name>/, with
// history.json, latest.json and a redirecting index.html beside them. The
// bucket is a fake that records every call in order.

const P = "reports/views/behold";
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

function fakeBucket(objects: Record<string, string> = {}, opts: { deny?: boolean; getFails?: (k: string) => boolean } = {}) {
  const calls: string[] = [];
  const put: { key: string; type: string; cache: string | undefined; body: string }[] = [];
  const deleted: string[] = [];
  const client = {
    get: async (k: string) => {
      calls.push(`get ${k}`);
      if (opts.getFails?.(k)) throw new S3Error(`GET s3://acme/${k}: 403`, { status: 403, body: "<Error><Code>AccessDenied</Code></Error>" });
      return objects[k];
    },
    put: async (k: string, b: string | Uint8Array, type: string, cache?: string) => {
      calls.push(`put ${k}`);
      const body = typeof b === "string" ? b : Buffer.from(b).toString("utf8");
      put.push({ key: k, type, cache, body });
      objects[k] = body;
    },
    delete: async (k: string) => {
      calls.push(`delete ${k}`);
      if (opts.deny) throw new S3Error(`DELETE s3://acme/${k}: 403`, { status: 403, body: "<Error><Code>AccessDenied</Code></Error>" });
      deleted.push(k);
      delete objects[k];
    },
  };
  return { client, calls, put, deleted, objects };
}

/** A bundle as runExport leaves it, its manifest naming every file (#510). */
function bundle(capturedAt = "2026-10-10T12:00:00.000Z"): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-snap-"));
  mkdirSync(join(dir, "snapshots"));
  mkdirSync(join(dir, "icons", "k8s"), { recursive: true });
  const snap = "snapshots/api_project.0123456789abcdef.json";
  writeFileSync(join(dir, "index.html"), "<html>");
  writeFileSync(join(dir, "app.js"), "export {}");
  writeFileSync(join(dir, snap), "{}");
  writeFileSync(join(dir, "icons", "k8s", "pod.svg"), "<svg/>");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ static: true, capturedAt, projectDir: "shop", keyToFile: { "/api/project": snap }, files: ["app.js", "icons/k8s/pod.svg", "index.html", snap] }),
  );
  return dir;
}

const row = (commit: string, generated = "2026-10-01T00:00:00.000Z"): HistoryEntry => ({ commit, at: generated, project: "shop", generated });

describe("publishing a view per commit (#510)", () => {
  it("writes the commit's files under <commit>/, then history.json, then latest.json, then the root index.html", async () => {
    const b = fakeBucket();
    const done = await publishSnapshot(bundle(), { bucket: "acme", prefix: P }, { sha: A, at: "2026-10-09T08:00:00.000Z" }, b.client);
    const puts = b.calls.filter((c) => c.startsWith("put ")).map((c) => c.slice(4 + P.length + 1));
    expect(puts).toEqual([
      `${A}/app.js`,
      `${A}/icons/k8s/pod.svg`,
      `${A}/snapshots/api_project.0123456789abcdef.json`,
      `${A}/manifest.json`,
      `${A}/index.html`,
      "history.json",
      "latest.json",
      "index.html",
    ]);
    // Every write is under the view's prefix.
    expect(b.put.every((p) => p.key.startsWith(`${P}/`))).toBe(true);
    // One GET of the old history, no list call; the other GET is the commit's own previous manifest (#500's sweep).
    expect(b.calls.filter((c) => c.startsWith("get "))).toEqual([`get ${P}/${A}/manifest.json`, `get ${P}/history.json`]);
    expect(JSON.parse(b.objects[`${P}/history.json`]!)).toEqual([{ commit: A, at: "2026-10-09T08:00:00.000Z", project: "shop", generated: "2026-10-10T12:00:00.000Z" }]);
    expect(JSON.parse(b.objects[`${P}/latest.json`]!)).toEqual({ commit: A });
    const cache = Object.fromEntries(b.put.map((p) => [p.key.slice(P.length + 1), p.cache]));
    expect(cache["history.json"]).toBe(NO_CACHE);
    expect(cache["latest.json"]).toBe(NO_CACHE);
    expect(cache["index.html"]).toBe(NO_CACHE);
    expect(cache[`${A}/snapshots/api_project.0123456789abcdef.json`]).toBe(IMMUTABLE);
    expect(b.put.find((p) => p.key === `${P}/index.html`)!.type).toBe("text/html; charset=utf-8");
    expect(done).toMatchObject({ commit: A, files: 5, dropped: [], pruned: [], history: 1, warnings: [] });
  });

  it("puts the new commit on top of the old history and moves a republished commit up rather than listing it twice", async () => {
    const b = fakeBucket({ [`${P}/history.json`]: JSON.stringify([row(B), row(A)]) });
    await publishSnapshot(bundle(), { bucket: "acme", prefix: P }, { sha: A }, b.client);
    expect(JSON.parse(b.objects[`${P}/history.json`]!).map((e: HistoryEntry) => e.commit)).toEqual([A, B]);
  });

  it("drops commits past --keep from history.json and deletes their files as each one's manifest names them, after the root index.html", async () => {
    const old = {
      [`${P}/history.json`]: JSON.stringify([row(B), row(C)]),
      [`${P}/${C}/manifest.json`]: JSON.stringify({
        keyToFile: { "/api/project": "snapshots/p.1111111111111111.json", "/x": "../../estate.html", "/y": "snapshots/../../index.html" },
        files: ["index.html", "app.js", "snapshots/p.1111111111111111.json", "../latest.json", "/abs", "icons/./x.svg"],
      }),
    };
    const b = fakeBucket(old);
    const done = await publishSnapshot(bundle(), { bucket: "acme", prefix: P }, { sha: A }, b.client, { keep: 2 });
    expect(JSON.parse(b.objects[`${P}/history.json`]!).map((e: HistoryEntry) => e.commit)).toEqual([A, B]);
    expect(b.deleted).toEqual([`${P}/${C}/index.html`, `${P}/${C}/app.js`, `${P}/${C}/snapshots/p.1111111111111111.json`, `${P}/${C}/manifest.json`]);
    expect(done.dropped).toEqual([C]);
    expect(done.pruned).toEqual([C]);
    expect(done.warnings).toEqual([]);
    // Nothing outside the view's prefix, nothing of a kept commit.
    expect(b.deleted.every((k) => k.startsWith(`${P}/${C}/`))).toBe(true);
    // Every delete after the root index.html.
    expect(b.calls.indexOf(`put ${P}/index.html`)).toBeLessThan(b.calls.findIndex((c) => c.startsWith("delete ")));
  });

  it("publishes anyway when the credentials cannot delete, and names s3:DeleteObject", async () => {
    const b = fakeBucket({ [`${P}/history.json`]: JSON.stringify([row(B)]), [`${P}/${B}/manifest.json`]: JSON.stringify({ files: ["index.html"] }) }, { deny: true });
    const done = await publishSnapshot(bundle(), { bucket: "acme", prefix: P }, { sha: A }, b.client, { keep: 1 });
    expect(done.dropped).toEqual([B]);
    expect(done.pruned).toEqual([]);
    expect(done.warnings).toHaveLength(1);
    expect(done.warnings[0]).toContain("s3:DeleteObject");
    expect(done.warnings[0]).toContain(B);
    expect(JSON.parse(b.objects[`${P}/latest.json`]!)).toEqual({ commit: A });
  });

  it("starts the history again from this commit when the old one cannot be read, and deletes nothing it did not see", async () => {
    const b = fakeBucket({}, { getFails: (k) => k.endsWith("history.json") });
    const done = await publishSnapshot(bundle(), { bucket: "acme", prefix: P }, { sha: A }, b.client, { keep: 1 });
    expect(done.warnings[0]).toContain("previous history.json could not be read");
    expect(done.warnings[0]).toContain("s3:ListBucket");
    expect(JSON.parse(b.objects[`${P}/history.json`]!).map((e: HistoryEntry) => e.commit)).toEqual([A]);
    expect(b.deleted).toEqual([]);
  });

  it("leaves a view published before this layout where it is, replacing only its index.html", async () => {
    const legacy = { [`${P}/manifest.json`]: "{}", [`${P}/app.js`]: "old", [`${P}/index.html`]: "<old>" };
    const b = fakeBucket({ ...legacy });
    await publishSnapshot(bundle(), { bucket: "acme", prefix: P }, { sha: A }, b.client);
    expect(b.deleted).toEqual([]);
    expect(b.objects[`${P}/manifest.json`]).toBe("{}");
    expect(b.objects[`${P}/app.js`]).toBe("old");
    expect(b.objects[`${P}/index.html`]).toBe(redirectPage());
  });

  it("refuses a commit that is not hex and a keep below 1", async () => {
    const b = fakeBucket();
    await expect(publishSnapshot(bundle(), { bucket: "acme", prefix: P }, { sha: "../x" }, b.client)).rejects.toThrow(/hex/);
    await expect(publishSnapshot(bundle(), { bucket: "acme", prefix: P }, { sha: A }, b.client, { keep: 0 })).rejects.toThrow(/--keep/);
    expect(b.calls).toEqual([]);
  });
});

describe("history.json and manifests (#510)", () => {
  it("keeps 30 commits by default and cuts the oldest", () => {
    expect(DEFAULT_KEEP).toBe(30);
    const old = Array.from({ length: 30 }, (_, i) => row(i.toString(16).padStart(7, "0")));
    const { history, dropped } = nextHistory(old, row(A), DEFAULT_KEEP);
    expect(history).toHaveLength(30);
    expect(history[0]!.commit).toBe(A);
    expect(dropped).toEqual(["000001d"]);
  });

  it("drops rows without a commit and refuses a document that is not a list", () => {
    expect(parseHistory(JSON.stringify([row(A), { commit: "../x" }, null, { at: "x" }])).map((e) => e.commit)).toEqual([A]);
    expect(() => parseHistory("{}")).toThrow();
  });

  it("names a commit's files index.html first and manifest.json last, falling back to the snapshots when files is absent", () => {
    expect(commitFiles(JSON.stringify({ keyToFile: { "/a": "snapshots/a.json" } }))).toEqual(["index.html", "snapshots/a.json", "manifest.json"]);
  });
});

describe("the root index.html (#510)", () => {
  function open(pathname: string, latest: unknown, ok = true) {
    const went: string[] = [];
    const asked: string[] = [];
    const el = { textContent: "" };
    let done!: () => void;
    const settled = new Promise<void>((r) => (done = r));
    const location = { pathname, search: "?env=prod", hash: "#n", replace: (u: string) => (went.push(u), done()) };
    const fetch = async (u: string) => (asked.push(u), { ok, status: ok ? 200 : 404, json: async () => latest });
    const document = { getElementById: () => new Proxy(el, { set: (t, k, v) => ((t as Record<string, unknown>)[k as string] = v, done(), true) }) };
    const script = /<script>([\s\S]*?)<\/script>/.exec(redirectPage())![1]!;
    runInNewContext(script, { location, fetch, document });
    return settled.then(() => ({ went, asked, message: el.textContent }));
  }

  it("opens the latest commit's view, keeping the lens in the query and the fragment", async () => {
    expect(await open("/reports/views/behold/", { commit: A })).toEqual({ went: [`${A}/index.html?env=prod#n`], asked: ["latest.json"], message: "" });
    expect((await open("/reports/views/behold/index.html", { commit: A })).went).toEqual([`${A}/index.html?env=prod#n`]);
    expect((await open("/reports/views/behold", { commit: A })).went).toEqual([`behold/${A}/index.html?env=prod#n`]);
  });

  it("says so rather than navigating when latest.json is missing or names no commit", async () => {
    expect((await open("/v/behold/", null, false)).message).toContain("latest.json: 404");
    expect((await open("/v/behold/", { commit: "../x" })).went).toEqual([]);
  });
});

describe("the commit a view is filed under (#510)", () => {
  it("takes --commit when given, the checkout's HEAD otherwise, and refuses a directory with neither", () => {
    expect(resolveCommit(tmpdir(), "ABCDEF1")).toEqual({ sha: "abcdef1" });
    expect(resolveCommit(tmpdir(), "main")).toHaveProperty("error");
    const bare = mkdtempSync(join(tmpdir(), "behold-nogit-"));
    expect(resolveCommit(bare)).toMatchObject({ error: expect.stringContaining("--commit") });
    const repo = mkdtempSync(join(tmpdir(), "behold-git-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_COMMITTER_DATE: "2026-10-09T08:00:00Z" } }).trim();
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "x");
    const head = git("rev-parse", "HEAD");
    expect(resolveCommit(repo)).toEqual({ sha: head, at: "2026-10-09T08:00:00.000Z" });
  });
});
