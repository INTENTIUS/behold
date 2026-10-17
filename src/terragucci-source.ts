/**
 * Where a terragucci estate's reports are read from (#490): a local
 * directory (the CI artifact, or an `aws s3 sync` of the prefix), an S3
 * prefix, or an http(s) address that serves the bucket (terragucci's
 * `reports.url`, or the front door). An S3 prefix is read with credentials
 * from the environment when it holds some (a CI job), and through the aws CLI
 * otherwise (a laptop's profile or SSO).
 *
 * Every read is one GET of one object by its key under the prefix: the same
 * keys terragucci's reference page "The reports bucket" names, so a read-only
 * identity needs `GetObject` and nothing else. One caller lists: the live
 * carve lists `<project>/migrations/` to find the cycle's migrations
 * (`list`, which needs `s3:ListBucket`); a refused or unsupported list is
 * left out, and the carve falls back to the migration demo.json names. Through
 * the CLI (`aws s3 cp <key> -`) it uses whatever profile and region the
 * shell already has; with environment credentials it signs the GET itself
 * (src/s3-object.ts). behold keeps no credentials and ships no SDK.
 */
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hasEnvCredentials, S3Error, S3Object, s3FromEnv } from "./s3-object.ts";

export type TerragucciSourceKind = "dir" | "s3" | "http";

export interface TerragucciSource {
  kind: TerragucciSourceKind;
  /** As the operator wrote it, for messages: a path, `s3://bucket/prefix` or an address. */
  location: string;
  /** The object at `key` (relative to the prefix), or undefined when there is none. Throws on any other failure. */
  read(key: string): Promise<string | undefined>;
  /**
   * The keys one level under `prefix` (relative to the source's prefix, ending
   * in `/`), at most `max`: each object with its last-modified time when the
   * source knows it, and each sub-prefix. Keys come back relative to the
   * source's prefix. Absent on an http(s) source, which cannot list. Throws
   * {@link TerragucciDenied} when the listing is refused.
   */
  list?(prefix: string, max: number): Promise<SourceListing>;
}

export interface SourceListing {
  objects: { key: string; modified: string | null }[];
  prefixes: string[];
  /** More keys were under the prefix than `max`. */
  truncated: boolean;
}

/**
 * #523: S3 refused a read with 403 (AccessDenied). An S3 source's `read`
 * throws this, so a caller whose read is optional (audit.jsonl, a run view)
 * can say the record is not readable with these credentials and draw the
 * rest, while a required read (index.json, a report) still fails, now naming
 * the permission. S3 also answers 403 for a missing object when the
 * credentials lack `s3:ListBucket`, so the words name both.
 *
 * #537: an http(s) source throws it too when the server answers 403, with
 * words for a web address: behold sends no credentials there, so whatever
 * serves the bucket (a bucket website, a front door) has to allow the GET.
 */
export class TerragucciDenied extends Error {
  /** The key under the prefix. */
  readonly key: string;
  /** The full address, `s3://bucket/prefix/key` or `https://host/prefix/key`. */
  readonly url: string;
  /** Which kind of source refused, for the words. */
  readonly via: "s3" | "http";
  constructor(key: string, url: string, detail: string, via: "s3" | "http" = "s3") {
    super(
      via === "http"
        ? `${url} is not readable with these credentials (${detail}): the server refused the GET, and behold sends no credentials to an http(s) source, so whatever serves it has to allow reading that key (a bucket website answers 403 for a missing object too when it may not list the bucket)`
        : `${url} is not readable with these credentials (${detail}): reading it needs s3:GetObject on that key, and S3 answers 403 for a missing object too when the credentials lack s3:ListBucket on the bucket`,
    );
    this.key = key;
    this.url = url;
    this.via = via;
  }
}

/** The sentence an answer carries when an optional record answered 403. */
export const deniedWords = (e: TerragucciDenied, what: string): string =>
  e.via === "http"
    ? `${e.url} is not readable with these credentials, so ${what} is not shown: the server answered 403, so whatever serves it has to allow GET on ${e.key} (or read the bucket as s3:// with credentials instead). This says nothing about the record itself.`
    : `${e.url} is not readable with these credentials, so ${what} is not shown: grant s3:GetObject on ${e.key} (or s3:ListBucket on the bucket, if the object may not exist yet). This says nothing about the record itself.`;

/** Runs `aws s3 cp <url> -`. Injectable so a test needs no aws CLI. */
export type AwsRun = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const realAws: AwsRun = (args) =>
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
export function terragucciSource(spec: string, opts: { cwd?: string; aws?: AwsRun; fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): TerragucciSource {
  const s3 = /^s3:\/\/([^/]+)\/?(.*)$/.exec(spec);
  if (s3) {
    const bucket = s3[1]!;
    const prefix = trim(s3[2] ?? "");
    const env = opts.env ?? process.env;
    // #491: a CI job (the estate job) holds its credentials in the
    // environment and often no aws CLI; sign the GET with them. A laptop signs
    // in through a profile or SSO, which only the CLI reads.
    if (!opts.aws && hasEnvCredentials(env)) {
      const client = new S3Object(s3FromEnv(bucket, env), opts.fetch as never);
      return {
        kind: "s3",
        location: `s3://${joinKey(bucket, prefix)}`,
        async read(key) {
          const k = joinKey(prefix, key);
          try {
            return await client.get(k);
          } catch (e) {
            if (e instanceof S3Error && (e.status === 403 || e.code === "AccessDenied")) {
              throw new TerragucciDenied(trim(key), `s3://${joinKey(bucket, k)}`, `${e.status ?? 403}${e.code ? ` ${e.code}` : ""}`);
            }
            throw e;
          }
        },
        async list(under, max) {
          const p = `${joinKey(prefix, under)}/`;
          try {
            return relative(await client.list(p, max), prefix);
          } catch (e) {
            if (e instanceof S3Error && (e.status === 403 || e.code === "AccessDenied")) {
              throw new TerragucciDenied(trim(under), `s3://${joinKey(bucket, p)}`, `${e.status ?? 403}${e.code ? ` ${e.code}` : ""}`);
            }
            throw e;
          }
        },
      };
    }
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
        // #523: a refused read is its own answer, so an optional read can degrade.
        if (/\b(403|AccessDenied|Forbidden)\b|Access Denied/i.test(r.stderr)) throw new TerragucciDenied(trim(key), url, /AccessDenied/i.test(r.stderr) ? "AccessDenied" : "403");
        throw new Error(r.code === -1 ? `could not run aws to read ${url}: ${r.stderr.trim()}` : `aws s3 cp ${url} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
      },
      async list(under, max) {
        const p = `${joinKey(prefix, under)}/`;
        const n = String(Math.max(1, Math.floor(max)));
        const r = await aws(["s3api", "list-objects-v2", "--bucket", bucket, "--prefix", p, "--delimiter", "/", "--max-items", n, "--page-size", n, "--output", "json"]);
        if (r.code !== 0) {
          if (/\b(403|AccessDenied|Forbidden)\b|Access Denied/i.test(r.stderr)) throw new TerragucciDenied(trim(under), `s3://${joinKey(bucket, p)}`, "AccessDenied");
          throw new Error(r.code === -1 ? `could not run aws to list s3://${joinKey(bucket, p)}: ${r.stderr.trim()}` : `aws s3api list-objects-v2 s3://${joinKey(bucket, p)} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
        }
        const doc = (r.stdout.trim() ? JSON.parse(r.stdout) : {}) as { Contents?: { Key?: string; LastModified?: string }[]; CommonPrefixes?: { Prefix?: string }[]; NextToken?: string };
        return relative(
          {
            objects: (doc.Contents ?? []).filter((c) => typeof c.Key === "string").map((c) => ({ key: c.Key!, modified: typeof c.LastModified === "string" ? c.LastModified : null })),
            prefixes: (doc.CommonPrefixes ?? []).map((c) => c.Prefix).filter((x): x is string => typeof x === "string"),
            truncated: !!doc.NextToken,
          },
          prefix,
        );
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
        const url = `${base}/${trim(key)}`;
        const res = await get(url);
        if (res.status === 404) return undefined;
        // #537: a refused read is its own answer, as for S3 (#523).
        if (res.status === 403) throw new TerragucciDenied(trim(key), url, "403", "http");
        if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
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
    async list(under, max) {
      const at = join(dir, ...trim(under).split("/"));
      let names;
      try {
        names = await readdir(at, { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return { objects: [], prefixes: [], truncated: false };
        throw e;
      }
      names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const out: SourceListing = { objects: [], prefixes: [], truncated: names.length > max };
      for (const n of names.slice(0, max)) {
        const k = joinKey(under, n.name);
        if (n.isDirectory()) out.prefixes.push(`${k}/`);
        else if (n.isFile()) out.objects.push({ key: k, modified: (await stat(join(at, n.name))).mtime.toISOString() });
      }
      return out;
    },
  };
}

/** A listing's full keys made relative to the source's prefix. */
function relative(l: SourceListing, prefix: string): SourceListing {
  const cut = prefix ? `${prefix}/` : "";
  const rel = (k: string): string => (cut && k.startsWith(cut) ? k.slice(cut.length) : k);
  return { objects: l.objects.map((o) => ({ ...o, key: rel(o.key) })), prefixes: l.prefixes.map(rel), truncated: l.truncated };
}
