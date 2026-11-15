/**
 * behold#1072: run test/vscode/suite.cjs inside a real VS Code (the Extension
 * Development Host @vscode/test-electron downloads and starts), on a copy of
 * test/fixtures/tf-folder, with PATH cut down to the system directories so no
 * `node` is on it. The host opens a window; on a machine with no display run
 * it under xvfb-run (CI does).
 *
 *   node scripts/test-vscode.mjs [--version stable|1.90.0|...] [--vsix <file>]
 *
 * The extension under test is the .vsix (default: the one `npm run package`
 * wrote here), unpacked: the file set that ships, not this checkout, where the
 * reader would find the repository's own node_modules by walking up from dist/
 * and hide a dependency the VSIX left out.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = dirname(fileURLToPath(import.meta.url));
const ext = resolve(here, "..");
const at = process.argv.indexOf("--version");
const version = at >= 0 ? process.argv[at + 1] : "stable";
const vsixAt = process.argv.indexOf("--vsix");
const vsix = vsixAt >= 0 ? resolve(process.argv[vsixAt + 1]) : readdirSync(ext).filter((f) => f.endsWith(".vsix")).map((f) => join(ext, f))[0];
if (!vsix) {
  console.error("behold vscode test: no .vsix here; run `npm run package` first.");
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "behold-vscode-test-"));
const unpacked = join(work, "vsix");
const unzip = spawnSync("unzip", ["-q", vsix, "-d", unpacked], { stdio: "inherit" });
if (unzip.status !== 0) process.exit(unzip.status ?? 1);
const extensionPath = join(unpacked, "extension");
const workspace = join(work, "tf-folder");
cpSync(join(ext, "test", "fixtures", "tf-folder"), workspace, { recursive: true });

const env = { ...process.env, PATH: process.platform === "win32" ? process.env.PATH : "/usr/bin:/bin:/usr/sbin:/sbin", BEHOLD_TEST_WORKSPACE: workspace, VSCODE_CLI: "1" }; // VSCODE_CLI: keep the PATH as given, no login-shell lookup
delete env.NODE_OPTIONS;
try {
  await runTests({
    version,
    extensionDevelopmentPath: extensionPath,
    extensionTestsPath: join(ext, "test", "vscode", "suite.cjs"),
    extensionTestsEnv: env,
    launchArgs: [workspace, "--disable-extensions", "--disable-workspace-trust", "--user-data-dir", join(work, "user"), "--extensions-dir", join(work, "extensions")],
  });
} catch (err) {
  console.error(`behold vscode test: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
