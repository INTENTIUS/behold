/**
 * behold#1035: the Forgejo HTTP API, for the one thing behold asks a Forgejo
 * repo to do: dispatch a product's committed workflow with inputs, follow
 * that run, and read the pull request it opened.
 *
 * GitHub goes through the operator's `gh` (src/gh-run.ts) and behold reads no
 * token there. `gh` does not speak to Forgejo, so here the operator's
 * `FORGEJO_TOKEN` is the credential: read from behold's environment per
 * request, sent only to the repo's own Forgejo host as `Authorization: token`,
 * never logged, never stored and never sent to a page. It is the first forge
 * credential behold holds. The workflow it dispatches is the product's own,
 * and what that run does with the repo is decided by the run's token in CI.
 *
 * The host comes from the repo's `origin` (`FORGEJO_URL` replaces it, for a
 * Forgejo served on another address than the one git pushes to).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The environment variable behold reads the operator's Forgejo token from. */
export const FORGEJO_TOKEN_ENV = "FORGEJO_TOKEN";
/** Replaces the API host derived from origin. */
export const FORGEJO_URL_ENV = "FORGEJO_URL";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Where a repo lives on its forge, from its origin. */
export interface OriginTarget {
  /** `https://host[:port]`, no trailing slash. */
  base: string;
  owner: string;
  repo: string;
}

/** The repo's `origin` URL: `git remote get-url origin`, else the `.git/config` of the nearest repo above `dir`. */
export function originUrl(dir: string): string | undefined {
  let at = resolve(dir);
  for (;;) {
    const cfg = join(at, ".git", "config");
    if (existsSync(cfg) && statSync(cfg).isFile()) {
      const m = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(readFileSync(cfg, "utf8"));
      if (m) return m[1];
      break;
    }
    if (existsSync(join(at, ".git"))) break;
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }
  try {
    return execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** An origin URL as a forge target: `https://host/owner/repo(.git)`, `ssh://git@host[:port]/owner/repo`, or `git@host:owner/repo`. */
export function targetOfOrigin(url: string, override?: string): OriginTarget | undefined {
  let host: string;
  let path: string;
  let base: string;
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(url);
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
    base = `https://${host}`;
  } else {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    path = u.pathname;
    base = u.protocol === "http:" || u.protocol === "https:" ? `${u.protocol}//${u.host}` : `https://${u.hostname}`;
  }
  const parts = path.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  return { base: (override || base).replace(/\/+$/, ""), owner: parts[parts.length - 2]!, repo: parts[parts.length - 1]! };
}

export class ForgejoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** A client for one repo, with the operator's token. */
export class ForgejoRepo {
  constructor(
    readonly target: OriginTarget,
    private readonly token: string,
    private readonly fetch: Fetch = globalThis.fetch as Fetch,
  ) {}

  /** The repo's API root: `<base>/api/v1/repos/<owner>/<repo>`. */
  get api(): string {
    return `${this.target.base}/api/v1/repos/${encodeURIComponent(this.target.owner)}/${encodeURIComponent(this.target.repo)}`;
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetch(`${this.api}${path}`, {
      ...init,
      headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), authorization: `token ${this.token}` },
    });
    return res;
  }

  private async json<T>(path: string): Promise<T> {
    const res = await this.call(path);
    if (!res.ok) throw new ForgejoError(`GET ${this.api}${path} answered ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  /** The repo's default branch. */
  async defaultBranch(): Promise<string> {
    const r = await this.json<{ default_branch?: unknown }>("");
    if (typeof r.default_branch !== "string" || !r.default_branch) throw new ForgejoError(`${this.api} names no default branch`);
    return r.default_branch;
  }

  /**
   * POST `actions/workflows/<file>/dispatches` with `ref` and the inputs. A
   * Forgejo that returns the run's details (`return_run_details`) gives its
   * id; an older one answers 204 and the run is not named.
   */
  async dispatch(file: string, ref: string, inputs: Record<string, string>): Promise<{ run?: number }> {
    const res = await this.call(`/actions/workflows/${encodeURIComponent(file)}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ ref, inputs, return_run_details: true }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const why = (() => {
        try {
          const m = (JSON.parse(text) as { message?: unknown }).message;
          return typeof m === "string" ? m : text;
        } catch {
          return text;
        }
      })();
      throw new ForgejoError(`the dispatch of ${file} answered ${res.status}${why ? `: ${why.trim().split("\n")[0]}` : ""}`, res.status);
    }
    if (res.status === 204) return {};
    const body = (await res.json().catch(() => ({}))) as { id?: unknown; run_id?: unknown };
    const id = typeof body.id === "number" ? body.id : typeof body.run_id === "number" ? body.run_id : undefined;
    return id !== undefined ? { run: id } : {};
  }

  /** A run's status and its page, or undefined when this Forgejo has no such read. */
  async run(id: number): Promise<{ status: string; url?: string } | undefined> {
    const res = await this.call(`/actions/runs/${id}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new ForgejoError(`GET ${this.api}/actions/runs/${id} answered ${res.status}`, res.status);
    const r = (await res.json()) as { status?: unknown; html_url?: unknown };
    return { status: typeof r.status === "string" ? r.status : "unknown", ...(typeof r.html_url === "string" ? { url: r.html_url } : {}) };
  }

  /** The pull request whose head is `branch`, in any state, or undefined. */
  async pullRequestOn(branch: string): Promise<{ number: number; url?: string } | undefined> {
    const rows = await this.json<Array<{ number?: unknown; html_url?: unknown; head?: { ref?: unknown } }>>("/pulls?state=all&limit=50");
    const hit = rows.find((r) => r.head?.ref === branch && typeof r.number === "number");
    return hit ? { number: hit.number as number, ...(typeof hit.html_url === "string" ? { url: hit.html_url } : {}) } : undefined;
  }
}

/** Forgejo's run statuses that end a run. */
export const FORGEJO_DONE = new Set(["success", "failure", "cancelled", "skipped"]);
