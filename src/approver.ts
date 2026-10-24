/**
 * #690: who behold approves a gate as.
 *
 * chant never signs a person in (ws-052). The surface that does maps the
 * person to a principal and passes it to chant's write commands as `--actor`
 * (ws-080, chant#3163): a forge identity (`github:<login>`, `gitlab:<login>`,
 * `<forge>@<host>:<login>`) or a principal the signers file lists. behold has
 * no login of its own, so it learns the person one of three ways, in this
 * order:
 *
 * 1. `header`: behold sits behind a proxy that signed the person in through
 *    the forge or OIDC and sets a header on every request (`--identity-header
 *    X-Forwarded-User`). Off unless configured. A bare login in the header is
 *    read as an account on `headerForge` (github unless set).
 * 2. `configured`: one person runs behold and names themselves (`--as
 *    github:alice`, BEHOLD_APPROVER, or the per-user settings' `approver.as`,
 *    src/user-settings.ts; #470 moved it out of `.behold.json`).
 * 3. `process`: neither, so chant's own fallback (GITHUB_ACTOR,
 *    GITLAB_USER_LOGIN, then USER), as before #690. behold passes no
 *    `--actor` then, and chant records what it always did.
 *
 * Without a trusted header, a request that carries one of the usual proxy
 * identity headers is refused rather than ignored: whoever sent it expects to
 * be recorded as the person it names, and behold would record someone else.
 *
 * A gate the workspace names in `identity.gates` counts only an approval
 * sealed with `chant approve --sign` by a key the signers file at base lists
 * for the approver. behold signs with the person's key when one is configured
 * (`--signing-key` for `--as`, or the per-user settings' `approver.keys` by
 * principal), and refuses the gate otherwise, as it did before. The key file
 * stays on this machine: chant reads it, and the page is told only whether
 * there is one.
 */
import { existsSync } from "node:fs";
import { keyPath, readUserSettings } from "./user-settings.ts";
import { localApprover } from "./workspace-gates.ts";

export { keyPath };

/** What `chant approve` gets as `--note` from behold, so the ledger line says where it came from. */
export const BEHOLD_CHANNEL_NOTE = "approved in behold";

/** How behold is told who is approving. */
export interface ApproverOptions {
  /** `--as`, BEHOLD_APPROVER, the per-user settings' `approver.as`: the person running behold. */
  as?: string;
  /** `--signing-key`, BEHOLD_SIGNING_KEY: the ssh key file `as` signs with. Absolute. */
  signingKey?: string;
  /** The per-user settings' `approver.keys`: a key file per principal. Absolute. */
  keys?: Record<string, string>;
  /** `--identity-header`, BEHOLD_IDENTITY_HEADER: the header an authenticating proxy sets. Lower-cased. */
  header?: string;
  /** `--identity-forge`: the forge a bare login in `header` is an account on, `github` unless set. */
  headerForge?: string;
}

export type ApproverSource = "header" | "configured" | "process";

export interface Approver {
  principal: string;
  source: ApproverSource;
  /** Whether `principal` is a forge identity, the form `identity.attribution: identified` takes without a signers entry. */
  forge: boolean;
  /** The key file behold signs with for this person, or null. Never sent to a page. */
  key: string | null;
}

export interface ApproverRefusal {
  error: string;
  code: "no-identity" | "identity-header";
  remedy: string;
}

export type ApproverRead = { ok: true; approver: Approver } | { ok: false; refusal: ApproverRefusal };

/** What a page is told about the approver: no key path. */
export interface ApproverView {
  principal: string;
  source: ApproverSource;
  forge: boolean;
  /** behold holds a key for this person, so it can approve a gate that needs a signed approval. */
  signs: boolean;
}

/** The headers an authenticating proxy commonly sets. Refused unless one is configured as trusted. */
export const PROXY_IDENTITY_HEADERS = [
  "x-forwarded-user",
  "x-forwarded-preferred-username",
  "x-forwarded-email",
  "x-auth-request-user",
  "x-auth-request-preferred-username",
  "x-auth-request-email",
  "x-remote-user",
  "remote-user",
  "x-webauth-user",
] as const;

// chant's FORGES and FORGE_PRINCIPAL (packages/core/src/workspace/identity.ts),
// kept here so a request does not load chant's write-scope reader to read a
// name. src/approver.test.ts checks this against chant's own parseForgeIdentity.
const FORGES = ["github", "gitlab", "forgejo", "gitea"] as const;
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const LOGIN = "[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9_])?";
const FORGE_PRINCIPAL = new RegExp(`^(${FORGES.join("|")})(?:@(${LABEL}(?:\\.${LABEL})+))?:(${LOGIN})$`);
const NEEDS_HOST = new Set(["forgejo", "gitea"]);

/** Whether chant reads `principal` as a forge identity. Case is folded, as chant folds it. */
export function isForgeIdentity(principal: string): boolean {
  const m = FORGE_PRINCIPAL.exec(principal.trim().toLowerCase());
  return !!m && !(NEEDS_HOST.has(m[1]) && !m[2]);
}

/** Whether `forge` can prefix a bare login: `github`, `gitlab`, or `<forge>@<host>`. */
export function isForgePrefix(forge: string): boolean {
  return isForgeIdentity(`${forge}:x`);
}

/** A principal behold can hand chant as `--actor`: one line, no leading dash, not empty. */
export function principalProblem(principal: string): string | null {
  if (!principal.trim()) return "is empty";
  if (/[\r\n]/.test(principal)) return "spans more than one line";
  if (/\s/.test(principal.trim())) return "has a space in it";
  if (principal.trim().startsWith("-")) return "starts with a dash, which chant would read as a flag";
  if (principal.length > 200) return "is longer than 200 characters";
  return null;
}

/**
 * The per-user settings' `approver` block for the project at `dir`
 * (src/user-settings.ts, #470): `{as?, signingKey?, keys?, header?,
 * headerForge?}`. Key paths resolve against `dir`. A project served before
 * #470 has its `.behold.json` block copied in on the first read. Absent or
 * unreadable is `{}`.
 */
export function approverFromSettings(dir: string, cacheRoot?: string): ApproverOptions {
  const b = readUserSettings(dir, cacheRoot).approver;
  if (!b) return {};
  const keys: Record<string, string> = {};
  for (const [p, k] of Object.entries(b.keys ?? {})) keys[p] = keyPath(k, dir);
  return {
    ...(b.as ? { as: b.as } : {}),
    ...(b.signingKey ? { signingKey: keyPath(b.signingKey, dir) } : {}),
    ...(Object.keys(keys).length ? { keys } : {}),
    ...(b.header ? { header: b.header.toLowerCase() } : {}),
    ...(b.headerForge ? { headerForge: b.headerForge } : {}),
  };
}

/**
 * Why these options can't serve, or null. Checked once at startup, so a
 * mistyped principal or a missing key file stops `serve` rather than the
 * first approval.
 */
export function approverOptionsProblem(o: ApproverOptions, host?: string): string | null {
  if (o.header && o.as) return "--identity-header and --as both name the person; use one";
  if (o.header && !/^[a-z0-9-]+$/.test(o.header)) return `--identity-header must be a header name, not ${JSON.stringify(o.header)}`;
  if (o.header && host && !isLoopback(host)) {
    return `--identity-header trusts whoever reaches behold, and --host ${host} lets anyone on the network send that header; bind 127.0.0.1 and put the proxy in front`;
  }
  if (o.headerForge && !o.header) return "--identity-forge needs --identity-header";
  if (o.headerForge && !isForgePrefix(o.headerForge)) return `--identity-forge must be github, gitlab or <forge>@<host>, not ${JSON.stringify(o.headerForge)}`;
  if (o.as) {
    const p = principalProblem(o.as);
    if (p) return `--as ${JSON.stringify(o.as)} ${p}`;
  }
  if (o.signingKey && !o.as) return "--signing-key is a person's key, so it needs --as naming that person";
  for (const [who, file] of [...(o.signingKey && o.as ? [[o.as, o.signingKey]] : []), ...Object.entries(o.keys ?? {})]) {
    const p = principalProblem(who);
    if (p) return `the key for ${JSON.stringify(who)}: the principal ${p}`;
    if (!existsSync(file)) return `the key for ${who} is not at ${file}`;
  }
  return null;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "[::1]";
}

function keyFor(o: ApproverOptions, principal: string): string | null {
  if (o.as && o.signingKey && same(o.as, principal)) return o.signingKey;
  for (const [who, file] of Object.entries(o.keys ?? {})) if (same(who, principal)) return file;
  return null;
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The person this request approves as. `header` reads one request header,
 * lower-cased name. `env` is chant's fallback's environment.
 */
export function approverFor(o: ApproverOptions, header: (name: string) => string | undefined, env: NodeJS.ProcessEnv = process.env): ApproverRead {
  if (o.header) {
    const value = (header(o.header) ?? "").trim();
    if (!value) {
      return { ok: false, refusal: { error: `behold reads who you are from the ${o.header} header, and this request has none`, code: "no-identity", remedy: "Open behold through the proxy that signs you in." } };
    }
    const principal = value.includes(":") ? value : `${o.headerForge ?? "github"}:${value}`;
    if (!isForgeIdentity(principal) || principalProblem(principal)) {
      return { ok: false, refusal: { error: `the ${o.header} header names ${JSON.stringify(value)}, which is not a forge login behold can pass to chant`, code: "identity-header", remedy: "Have the proxy send the forge login, or set --identity-forge to the forge it signs people in with." } };
    }
    return { ok: true, approver: { principal, source: "header", forge: true, key: keyFor(o, principal) } };
  }
  const sent = PROXY_IDENTITY_HEADERS.find((h) => (header(h) ?? "").trim());
  if (sent) {
    return { ok: false, refusal: { error: `this request names a person in the ${sent} header, and behold is not set to trust it`, code: "identity-header", remedy: `Start behold with --identity-header ${sent} when it sits behind a proxy that signs people in, or open it directly.` } };
  }
  if (o.as) return { ok: true, approver: { principal: o.as.trim(), source: "configured", forge: isForgeIdentity(o.as), key: keyFor(o, o.as) } };
  const principal = localApprover(env);
  return { ok: true, approver: { principal, source: "process", forge: isForgeIdentity(principal), key: null } };
}

/** What a page is told. */
export function approverView(a: Approver): ApproverView {
  return { principal: a.principal, source: a.source, forge: a.forge, signs: a.key !== null };
}

/**
 * The flags behold adds to `chant approve` (or `chant run approve`) for this
 * approver: `--actor` when behold knows the person, `--note` naming behold,
 * and `--sign <key>` when the gate needs a signed approval and behold holds
 * the person's key. chant's own fallback names the person when behold does
 * not, so a `process` approver passes no `--actor`.
 */
export function approverFlags(a: Approver, opts: { sign?: boolean; flag?: "--actor" | "--approver" } = {}): string[] {
  return [
    ...(a.source === "process" ? [] : [opts.flag ?? "--actor", a.principal.trim()]),
    "--note", BEHOLD_CHANNEL_NOTE,
    ...(opts.sign && a.key ? ["--sign", a.key] : []),
  ];
}

/**
 * The approver options from the command line and the environment, over the
 * per-user settings for `dir`. A flag beats the environment, and both beat
 * the settings. Key paths from a flag resolve against the working directory.
 */
export function resolveApproverOptions(
  flags: { as?: string; signingKey?: string; header?: string; headerForge?: string },
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): ApproverOptions {
  const file = approverFromSettings(dir);
  const as = flags.as ?? (env.BEHOLD_APPROVER || undefined) ?? file.as;
  const signingKeyArg = flags.signingKey ?? (env.BEHOLD_SIGNING_KEY || undefined);
  const signingKey = signingKeyArg ? keyPath(signingKeyArg, process.cwd()) : file.signingKey;
  const header = (flags.header ?? (env.BEHOLD_IDENTITY_HEADER || undefined) ?? file.header)?.toLowerCase();
  const headerForge = flags.headerForge ?? (env.BEHOLD_IDENTITY_FORGE || undefined) ?? file.headerForge;
  return {
    ...(as ? { as } : {}),
    ...(signingKey ? { signingKey } : {}),
    ...(file.keys ? { keys: file.keys } : {}),
    ...(header ? { header } : {}),
    ...(headerForge ? { headerForge } : {}),
  };
}
