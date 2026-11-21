import { describe, it, expect, afterAll, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";

// #1238: the sql lexicon's live read connects to the profile's server. A fake
// chant stands in for it: it dials the port in YODEL_FAKE_DB_PORT, as the live
// read does, and answers an empty graph.
const made: string[] = [];
const servers: Server[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  delete process.env.BEHOLD_CHANT_BIN;
  delete process.env.YODEL_FAKE_DB_PORT;
  for (const s of servers.splice(0)) s.close();
});

async function listener(): Promise<{ port: number; attempts: () => number }> {
  let n = 0;
  const server = createServer((sock) => {
    n++;
    sock.destroy();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, attempts: () => n };
}

function fixture(): { dir: string; chant: string } {
  const dir = mkdtempSync(join(tmpdir(), "behold-yodel-live-"));
  made.push(dir);
  writeFileSync(join(dir, ".git"), "");
  writeFileSync(join(dir, "yodel.config.ts"), "export default {};\n");
  writeFileSync(join(dir, "chant.config.json"), JSON.stringify({ environments: ["prod"] }));
  const chant = join(dir, "fake-chant.cjs");
  writeFileSync(
    chant,
    `#!/usr/bin/env node
const net = require("node:net");
const live = process.argv[2] === "graph" && process.argv.includes("--live");
const done = () => { process.stdout.write(JSON.stringify({ nodes: [], edges: [], groups: {} })); };
if (!live) { done(); } else {
  const s = net.connect(Number(process.env.YODEL_FAKE_DB_PORT), "127.0.0.1");
  s.on("close", done); s.on("error", done);
}
`,
  );
  chmodSync(chant, 0o755);
  return { dir, chant };
}

function app(projectDir: string, extra: { yodelLive?: boolean } = {}) {
  const broadcaster = new Broadcaster();
  return createApp({ projectDir, port: 0, ...extra }, broadcaster, new FrameBuffer(), new OpRunner({ projectDir, broadcaster, onDone: () => {} }));
}

describe("a SQL Yodeler environment overlay needs --yodel-live (#1238)", () => {
  it("opens no connection without the flag and answers with the flag's name", async () => {
    const db = await listener();
    const { dir, chant } = fixture();
    process.env.BEHOLD_CHANT_BIN = chant;
    process.env.YODEL_FAKE_DB_PORT = String(db.port);
    const res = await app(dir).request("/api/overlay?env=prod");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; error: string; remedy: string };
    expect(body.code).toBe("yodel-live");
    expect(body.error).toContain("--yodel-live");
    expect(db.attempts()).toBe(0);
  });

  it("opens a connection with the flag", async () => {
    const db = await listener();
    const { dir, chant } = fixture();
    process.env.BEHOLD_CHANT_BIN = chant;
    process.env.YODEL_FAKE_DB_PORT = String(db.port);
    await app(dir, { yodelLive: true }).request("/api/overlay?env=prod");
    expect(db.attempts()).toBeGreaterThanOrEqual(1);
  });
});

// behold export takes the same flag: its overlay captures run in-process through createApp.
describe("behold export --yodel-live (#1238)", () => {
  const exportWith = async (flag: string[]): Promise<number> => {
    const db = await listener();
    const { dir, chant } = fixture();
    const out = join(dir, "out");
    await new Promise<void>((resolveRun) => {
      execFile(
        process.execPath,
        ["--import", "tsx", join(process.cwd(), "src/cli.ts"), "export", dir, "--env", "prod", "--out", out, ...flag],
        { env: { ...process.env, BEHOLD_CHANT_BIN: chant, YODEL_FAKE_DB_PORT: String(db.port) }, timeout: 60_000 },
        () => resolveRun(),
      );
    });
    return db.attempts();
  };

  it("opens no connection without the flag", async () => {
    expect(await exportWith([])).toBe(0);
  }, 90_000);

  it("opens a connection with the flag", async () => {
    expect(await exportWith(["--yodel-live"])).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
