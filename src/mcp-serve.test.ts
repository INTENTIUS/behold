// behold#916, end to end: a real `behold serve` writes its registry entry and removes it at exit,
// and a real `behold mcp` over stdio finds that serve through the registry and moves its tab.
import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { realDir } from "./serve-registry.ts";

const ROOT = join(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const scratch = mkdtempSync(join(tmpdir(), "behold-mcp-serve-"));
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
});

const env = { ...process.env, BEHOLD_SERVES_DIR: join(scratch, "serves"), BEHOLD_RECENTS_FILE: join(scratch, "recents.json") };

async function until<T>(fn: () => T | undefined, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("behold serve and behold mcp, as processes", () => {
  it("the serve registers itself outside the project, behold mcp finds it, and the entry goes at exit", async () => {
    const project = join(scratch, "proj");
    mkdirSync(project);
    writeFileSync(join(project, "chant.config.json"), JSON.stringify({ lexicons: ["aws"], environments: ["prod"] }));
    const serve = spawn(TSX, ["src/cli.ts", "serve", project, "--port", "0"], { cwd: ROOT, env, stdio: "ignore" });
    children.push(serve);
    // tsx runs the CLI in a child process: the entry names that process's pid.
    const dir = env.BEHOLD_SERVES_DIR;
    const name = await until(() => (existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(".json")) : undefined), 30_000, "the registry entry");
    const file = join(dir, name);
    const entry = JSON.parse(readFileSync(file, "utf8")) as { url: string; pid: number; projectDir: string; version: string; startedAt: string };
    expect(name).toBe(`${entry.pid}.json`);
    expect(entry.projectDir).toBe(realDir(project));
    expect(entry.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(Object.keys(entry).sort()).toEqual(["pid", "projectDir", "startedAt", "url", "version"]);

    const transport = new StdioClientTransport({ command: TSX, args: ["src/cli.ts", "mcp", project], cwd: ROOT, env: env as Record<string, string>, stderr: "ignore" });
    const client = new Client({ name: "test-agent", version: "1" });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["ask", "show", "shot", "capabilities"]);
    // No tab is open on the serve: the route's answer, from the serve the registry named.
    const r = (await client.callTool({ name: "show", arguments: { env: "prod", node: "a" } })) as CallToolResult;
    const body = JSON.parse((r.content[0] as { text: string }).text) as { code: string; link: string };
    expect(r.isError).toBe(true);
    expect(body.code).toBe("no-tab");
    expect(body.link.startsWith(entry.url)).toBe(true);
    await client.close();

    serve.kill("SIGTERM");
    await until(() => (existsSync(file) ? undefined : true), 10_000, "the entry's removal");
    expect(readdirSync(project)).toEqual(["chant.config.json"]);
  }, 60_000);
});
