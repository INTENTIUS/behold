/**
 * Where a terragucci estate's reports are read from (#490): a local
 * directory (the CI artifact, or an `aws s3 sync` of the prefix), an S3
 * prefix, or an http(s) address that serves the bucket (terragucci's
 * `reports.url`, or the front door).
 *
 * Every read is one GET of one object by its key under the prefix: the same
 * keys terragucci's reference page "The reports bucket" names, and no list
 * call, so a read-only identity needs `GetObject` and nothing else. An S3
 * read goes through the operator's own `aws` CLI (`aws s3 cp <key> -`), so it
 * uses whatever profile and region their shell already has, and behold holds
 * no credentials and ships no SDK.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type TerragucciSourceKind = "dir" | "s3" | "http";

export interface TerragucciSource {
  kind: TerragucciSourceKind;
  /** As the operator wrote it, for messages: a path, `s3://bucket/prefix` or an address. */
  location: string;
  /** The object at `key` (relative to the prefix), or undefined when there is none. Throws on any other failure. */
  read(key: string): Promise<string | undefined>;
}

/** Runs `aws s3 cp <url> -`. Injectable so a test needs no aws CLI. */
export type AwsRun = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const realAws: AwsRun = (args) =>
  new Promise((res) => {
    const child = spawn(process.env.AWS_BIN || "aws", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => res({ code: -1, stdout, stderr: `${stderr}${e.message}` }));
    child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
  });

const trim = (s: string): string => s.replace(/^\/+|\/+$/g, "");
const joinKey = (...p: string[]): string => p.map(trim).filter(Boolean).join("/");

/** The source a `--terragucci` value names. A relative path is resolved against `cwd`. */
export function terragucciSource(spec: string, opts: { cwd?: string; aws?: AwsRun; fetch?: typeof fetch } = {}): TerragucciSource {
  const s3 = /^s3:\/\/([^/]+)\/?(.*)$/.exec(spec);
  if (s3) {
    const bucket = s3[1]!;
    const prefix = trim(s3[2] ?? "");
    const aws = opts.aws ?? realAws;
    return {
      kind: "s3",
      location: `s3://${joinKey(bucket, prefix)}`,
      async read(key) {
        const url = `s3://${joinKey(bucket, prefix, key)}`;
        const r = await aws(["s3", "cp", url, "-", "--only-show-errors"]);
        if (r.code === 0) return r.stdout;
        // A missing object is an answer (no estate.json yet); anything else is not.
        if (/\b(404|NoSuchKey|Not Found|does not exist)\b/i.test(r.stderr)) return undefined;
        throw new Error(r.code === -1 ? `could not run aws to read ${url}: ${r.stderr.trim()}` : `aws s3 cp ${url} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
      },
    };
  }
  if (/^https?:\/\//.test(spec)) {
    const base = spec.replace(/\/+$/, "");
    const get = opts.fetch ?? fetch;
    return {
      kind: "http",
      location: base,
      async read(key) {
        const res = await get(`${base}/${trim(key)}`);
        if (res.status === 404 || res.status === 403) return undefined;
        if (!res.ok) throw new Error(`GET ${base}/${trim(key)} answered ${res.status}`);
        return await res.text();
      },
    };
  }
  const dir = resolve(opts.cwd ?? process.cwd(), spec);
  return {
    kind: "dir",
    location: dir,
    async read(key) {
      try {
        return await readFile(join(dir, ...trim(key).split("/")), "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    },
  };
}
