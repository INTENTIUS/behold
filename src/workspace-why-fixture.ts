/**
 * #471: a real workspace to read a "why" from, for the tests and the UI smoke.
 *
 * chant's reader conformance package generates a git repository with a chant
 * workspace in it: an `app` member, a `delivery` chant member with one node
 * (`delivery/appService`), a decided decision (fix-001) constraining both
 * members, one commit carrying a `Chant-Run` trailer, and that run in the run
 * ledger. On top of it this declares the decision kind in the declaration, so
 * `graph --intent` reads decisions without `--kind`, and commits a proposed
 * decision (fix-002) constraining `delivery`, so a "why" has one decided and
 * one proposed decision to show.
 *
 * Test support only: nothing in the server imports it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConformanceWorkspace, UNCOMMITTED_DECISION } from "@intentius/chant/workspace/conformance";

export interface WhyFixture {
  /** The workspace root. */
  dir: string;
  dispose(): void;
}

const GIT = ["-c", "user.name=behold", "-c", "user.email=behold@localhost", "-c", "commit.gpgsign=false"];
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

export function createWhyFixture(): WhyFixture {
  const ws = createConformanceWorkspace();
  try {
    const declPath = join(ws.dir, "chant.workspace.json");
    const decl = JSON.parse(readFileSync(declPath, "utf8")) as Record<string, unknown>;
    decl.records = [{ kind: "decisions/decision.kind.mjs" }];
    writeFileSync(declPath, `${JSON.stringify(decl, null, 2)}\n`);
    writeFileSync(join(ws.dir, ...UNCOMMITTED_DECISION.path.split("/")), UNCOMMITTED_DECISION.text);
    execFileSync("git", [...GIT, "add", "-A"], { cwd: ws.dir, env: GIT_ENV, stdio: "ignore" });
    execFileSync("git", [...GIT, "commit", "--quiet", "-m", "declare the decision kind, and propose fix-002"], { cwd: ws.dir, env: GIT_ENV, stdio: "ignore" });
    return ws;
  } catch (e) {
    ws.dispose();
    throw e;
  }
}
