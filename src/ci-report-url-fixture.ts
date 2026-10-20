/**
 * behold#818: a throwaway chant workspace that declares its CI report URL
 * (`ci.reportUrl`, chant#4160), for the real-chant test and for recording
 * src/__fixtures__/ci-report-url/.
 *
 * Member `web` (directory `web`), and a declaration whose `ci` block names
 * `reportUrl` (minReader 0.124.32, the first chant that knows it). Without
 * `reportUrl` the same workspace declares no `ci` block at all.
 *
 * Test support only: nothing in the server imports it. Every git call is made
 * in the directory given.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The URL the recorded ls.json declares. */
export const DECLARED_REPORT_URL = "s3://acme-ci/reports";

const AUTHOR = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_AUTHOR_DATE: "2026-10-01T10:00:00Z", GIT_COMMITTER_DATE: "2026-10-01T10:00:00Z" };
const git = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...AUTHOR }, stdio: ["pipe", "pipe", "pipe"] }).trim();

/** Make the workspace in `scratch/repo` and return its root. With `chant`, the project's chant is a shim at `version` that runs that binary. */
export function makeReportUrlWorkspace(scratch: string, opts: { reportUrl?: string; chant?: string; version?: string } = {}): string {
  const root = join(scratch, "repo");
  git(scratch, ["init", "-q", "-b", "main", root]);
  const decl = {
    name: "acme",
    schema: 1,
    minReader: opts.reportUrl ? "0.124.32" : "0.108.0",
    members: [{ name: "web", dir: "web", kind: "chant", because: "the app" }],
    ...(opts.reportUrl ? { ci: { reportUrl: opts.reportUrl } } : {}),
  };
  const files: Record<string, string> = {
    "chant.workspace.json": `${JSON.stringify(decl, null, 2)}\n`,
    "web/chant.config.ts": `export default { environments: ["staging", "prod"] };\n`,
    ".gitignore": "node_modules\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "workspace"]);
  if (opts.chant) {
    const pkg = join(root, "node_modules", "@intentius", "chant");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@intentius/chant", version: opts.version ?? "0.124.32", main: "index.js", bin: { chant: "bin/chant" } }));
    writeFileSync(join(pkg, "index.js"), "");
    writeFileSync(join(pkg, "bin", "chant"), `#!/bin/sh\nexec ${JSON.stringify(opts.chant)} "$@"\n`);
    chmodSync(join(pkg, "bin", "chant"), 0o755);
  }
  return root;
}
