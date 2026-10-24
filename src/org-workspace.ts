/**
 * behold#931: an org-level workspace (INTENTIUS/chant#3168).
 *
 * An org declaration (`scope: "org"`) holds only members of kind `repo`, each
 * naming another repository's workspace by URL and pinned revision. chant
 * fetches each revision into the user's cache and reads it through that
 * repository's own `workspace graph`; the member's graph entry carries
 * `status`, `reason`, `nested` (that workspace's name, members and links) and
 * `repo` (`url`, `rev`, `workspace`, and `read`, the identity the other
 * repository's document gave). This module takes that one document and lists
 * what each repo member holds. It joins nothing: chant composes the nested
 * graphs, and behold shows the members as chant listed them, with chant's own
 * reason when a revision could not be fetched.
 *
 * behold fetches nothing, watches no directory for a repo member (its `dir`
 * is a `@repo/<name>` marker, not a path) and writes nothing. One read: `chant
 * workspace graph`, through the reader (src/workspace-reader.ts). The floor is
 * in src/chant-floors.ts (`ORG_SCOPE_CHANT_FLOOR`).
 */
import { floorFor, floorMet, floorRefusal } from "./chant-floors.ts";
import type { Workspace } from "./workspace.ts";
import { rootReader, WorkspaceReadError, type WorkspaceDocument, type WorkspaceReader, type WorkspaceRefusal } from "./workspace-reader.ts";

export interface OrgReason {
  code: string;
  message: string;
}

/** One member of the other repository's workspace, as its own graph lists it. */
export interface OrgNestedMember {
  name: string;
  kind: string;
  status: string;
  reason: OrgReason | null;
}

/** One repo member of the org workspace. */
export interface OrgRepo {
  /** The member's name in the org declaration. */
  name: string;
  url: string;
  rev: string;
  /** The workspace root inside that repository (`.` for its root). */
  workspace: string;
  /** chant's status for the member: composed, skipped or failed. */
  status: string;
  /** Why it is not composed, as chant gave it (a failed fetch is `command-failed`). */
  reason: OrgReason | null;
  /** The other repository's own identity, `repo.read`: what tells apart two repositories that declare one workspace name. Null when it gave none or the read failed. */
  read: string | null;
  /** The other repository's workspace name, or null when nothing was read. */
  workspaceName: string | null;
  /** `<workspace name> (<repository>)` when read, otherwise the URL. */
  label: string;
  members: OrgNestedMember[];
}

export interface OrgRepos {
  /** The org workspace's own `workspace.repo`, or null. */
  repo: string | null;
  repos: OrgRepo[];
}

export type OrgRead = { ok: true; org: OrgRepos } | { ok: false; refusal: WorkspaceRefusal };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const reasonOf = (v: unknown): OrgReason | null => (isRecord(v) ? { code: String(v.code ?? "unknown"), message: String(v.message ?? "") } : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The refusal when the project's chant is older than the org read's floor, else undefined. */
export function orgFloorRefusal(version: string | undefined): WorkspaceRefusal | undefined {
  const f = floorFor("org workspace");
  return floorMet(f, version) ? undefined : floorRefusal(f, version);
}

/** The repo members a `workspace graph` document lists, with the members of each one's workspace. */
export function orgReposFromGraph(doc: WorkspaceDocument): OrgRead {
  if (isRecord(doc.error)) {
    return { ok: false, refusal: { error: `chant workspace graph: ${String(doc.error.code)}: ${String(doc.error.message ?? "")}`, code: "workspace-graph", remedy: "`chant workspace check` names the problem and where it is." } };
  }
  if (!Array.isArray(doc.members)) {
    return { ok: false, refusal: { error: "That is not a workspace graph document: it has no `members`.", code: "workspace-graph", remedy: "Run `chant workspace graph` in the workspace root." } };
  }
  const repos: OrgRepo[] = [];
  for (const m of doc.members) {
    if (!isRecord(m) || m.kind !== "repo" || typeof m.name !== "string") continue;
    const ref = isRecord(m.repo) ? m.repo : {};
    const nested = isRecord(m.nested) ? m.nested : undefined;
    const read = str(ref.read);
    const workspaceName = nested ? str(nested.name) : null;
    const url = str(ref.url) ?? "";
    const members: OrgNestedMember[] = [];
    for (const n of nested && Array.isArray(nested.members) ? nested.members : []) {
      if (!isRecord(n) || typeof n.name !== "string") continue;
      members.push({ name: n.name, kind: str(n.kind) ?? "", status: str(n.status) ?? "", reason: reasonOf(n.reason) });
    }
    repos.push({
      name: m.name,
      url,
      rev: str(ref.rev) ?? "",
      workspace: str(ref.workspace) ?? ".",
      status: str(m.status) ?? "",
      reason: reasonOf(m.reason),
      read,
      workspaceName,
      label: workspaceName ? `${workspaceName} (${read ?? url})` : url,
      members,
    });
  }
  const ws = isRecord(doc.workspace) ? doc.workspace : {};
  return { ok: true, org: { repo: str(ws.repo), repos } };
}

/** Read the org workspace's repo members: one `chant workspace graph` at the root. */
export async function readOrgRepos(ws: Workspace, reader: WorkspaceReader = rootReader(ws.root)): Promise<OrgRead> {
  try {
    return orgReposFromGraph(await reader.read("graph", [ws.root]));
  } catch (e) {
    if (e instanceof WorkspaceReadError) return { ok: false, refusal: e.refusal };
    throw e;
  }
}
