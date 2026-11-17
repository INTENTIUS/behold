import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// behold#1141: a command that prints a document and exits must let a piped
// stdout drain first. A pipe holds 64 KiB, so a larger document stopped there.

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "cli.ts");
const TSX = join(HERE, "..", "node_modules", ".bin", "tsx");

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A bare folder of .tf files whose graph document is well past 64 KiB. */
function bigFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "behold-1141-"));
  made.push(root);
  const dir = join(root, "big");
  mkdirSync(dir);
  const blocks = Array.from({ length: 150 }, (_, i) => `resource "aws_s3_bucket" "b${i}" { bucket = "bucket-number-${i}-with-a-longish-name" }`);
  writeFileSync(join(dir, "main.tf"), blocks.join("\n") + "\n");
  return dir;
}

/** Run the CLI with its stdout on a pipe, read slowly so the buffer fills. */
function piped(args: string[]): Promise<{ bytes: number; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [CLI, ...args], { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, BROWSER: "none" } });
    let bytes = 0;
    child.stdout.on("data", (b: Buffer) => void (bytes += b.length));
    child.on("error", reject);
    child.on("close", (code) => resolve({ bytes, code }));
  });
}

describe("a piped document", () => {
  it("behold graph --json prints as many bytes to a pipe as -o writes", async () => {
    const dir = bigFolder();
    const out = join(dir, "..", "doc.json");
    const flags = ["--json", "--every-card", "--detail", "3", "--source"];
    const file = await piped(["graph", dir, ...flags, "-o", out]);
    expect(file.code).toBe(0);
    const expected = statSync(out).size;
    expect(expected).toBeGreaterThan(65536 * 2);
    const pipe = await piped(["graph", dir, ...flags]);
    expect(pipe.code).toBe(0);
    expect(pipe.bytes).toBe(expected);
  }, 120_000);
});
