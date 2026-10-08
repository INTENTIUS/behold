/**
 * Who may talk to behold. behold runs delegated writes (applies, ops, gate
 * approvals) with the credentials of whoever started it, so it answers only
 * the machine it runs on, and only pages of its own.
 *
 * - It binds 127.0.0.1 unless told otherwise (`--host`, BEHOLD_HOST).
 * - A request whose Host isn't a loopback name, the bound address, or a name
 *   the operator allowed (`--allow-host`, BEHOLD_ALLOWED_HOSTS) is refused.
 *   That closes DNS rebinding, where a page on evil.example resolves its own
 *   name to 127.0.0.1 and reads behold as same-origin.
 * - A write (anything but GET, HEAD, OPTIONS) is refused when the browser
 *   says it is cross-site (Sec-Fetch-Site), or when its Origin isn't behold's
 *   own Host or an allowed name. A form or a `no-cors` fetch from another
 *   site can still send a "simple" POST; this is what stops it.
 *
 * A host that frames behold through a proxy (arugula's block sites) passes
 * its site's name with `--allow-host`.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export interface GuardConfig {
  /** Names (no port) let in besides loopback and the bound address. */
  allowedHosts: string[];
  /** The address behold bound, when it's a specific one. */
  boundHost?: string;
}

export interface GuardRequest {
  method: string;
  /** The Host header, or the URL's host when there is none. */
  host: string;
  origin?: string | null;
  secFetchSite?: string | null;
}

export type GuardVerdict = { ok: true } | { ok: false; status: 403 | 421; error: string };

/** The name part of a Host header or an origin's host, lowercased, without the port. */
export function hostName(hostport: string): string {
  const h = hostport.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end >= 0 ? h.slice(0, end + 1) : h;
  }
  const colon = h.lastIndexOf(":");
  return colon >= 0 && h.indexOf(":") === colon ? h.slice(0, colon) : h;
}

export function isLoopbackName(name: string): boolean {
  return LOOPBACK.has(name) || name.endsWith(".localhost");
}

function allowedName(name: string, cfg: GuardConfig): boolean {
  if (isLoopbackName(name)) return true;
  if (cfg.boundHost && !isWildcard(cfg.boundHost) && hostName(cfg.boundHost) === name) return true;
  return cfg.allowedHosts.some((h) => hostName(h) === name);
}

function isWildcard(h: string): boolean {
  return h === "0.0.0.0" || h === "::" || h === "[::]";
}

export function guardRequest(req: GuardRequest, cfg: GuardConfig): GuardVerdict {
  const name = hostName(req.host);
  if (!allowedName(name, cfg)) {
    return { ok: false, status: 421, error: `behold doesn't answer to host ${name}. Start it with --allow-host ${name} if a proxy of yours sends that name.` };
  }
  if (SAFE.has(req.method.toUpperCase())) return { ok: true };
  if ((req.secFetchSite || "").toLowerCase() === "cross-site") {
    return { ok: false, status: 403, error: "a cross-site page can't write to behold" };
  }
  if (req.origin && req.origin !== "null") {
    let originHost: string;
    try {
      originHost = new URL(req.origin).host.toLowerCase();
    } catch {
      return { ok: false, status: 403, error: "a write with an unreadable Origin is refused" };
    }
    const same = originHost === req.host.trim().toLowerCase();
    if (!same && !cfg.allowedHosts.some((h) => hostName(h) === hostName(originHost))) {
      return { ok: false, status: 403, error: `a page from ${originHost} can't write to behold` };
    }
  } else if (req.origin === "null") {
    return { ok: false, status: 403, error: "a write from an opaque origin is refused" };
  }
  return { ok: true };
}

/** `--allow-host a,b` and BEHOLD_ALLOWED_HOSTS, as one list. */
export function allowedHostsFrom(flag: string[] = [], env: string | undefined = process.env.BEHOLD_ALLOWED_HOSTS): string[] {
  return [...flag, ...(env || "").split(",")].map((s) => s.trim()).filter(Boolean);
}
