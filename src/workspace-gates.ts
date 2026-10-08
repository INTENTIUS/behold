/**
 * #477: the gates waiting on a person in a declared workspace, from
 * `chant workspace status <env> --json` under read contract 1.
 *
 * arugula's workspace block reads the same document and keys a gate
 * `member/op/gate`, so a framed behold and the block around it show one set
 * of gates. Only `pending` gates are kept: an approved or expired gate is no
 * longer waiting on anybody.
 *
 * Approving goes through `chant approve` in the member's directory with the
 * gate's env and plan digest, both taken from a fresh read rather than from
 * the page. The approver is whoever runs behold (chant's own fallback:
 * GITHUB_ACTOR, GITLAB_USER_LOGIN, then USER), which is why the page says so,
 * and why a framed behold leaves approving to its host, which knows who is
 * looking (#476).
 */
import { resolve } from "node:path";
import type { Workspace } from "./workspace.ts";
import { contractRefusal, rootReader, WorkspaceReadError, type WorkspaceDocument, type WorkspaceReader, type WorkspaceRefusal } from "./workspace-reader.ts";

export const STATUS_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/status/v1/status.schema.json";

export interface GateApproval {
  principal: string;
  at: string | null;
  channel: string | null;
}

export interface WorkspaceGate {
  /** `member/op/gate`, as arugula keys it. */
  key: string;
  member: string;
  /** The member's directory, absolute. Never sent by a page; always read. */
  dir: string;
  op: string;
  gate: string;
  env: string | null;
  planDigest: string | null;
  approvals: GateApproval[];
  needed: number;
  recordedAt: string | null;
  expiresAt: string | null;
  /** The gate wants a signed approval, which behold can't make. */
  signed: boolean;
  /** The line chant says approving runs, or the same built from the gate. */
  approve: string;
}

export type GatesRead = { ok: true; env: string; gates: WorkspaceGate[] } | { ok: false; refusal: WorkspaceRefusal };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The gate key arugula uses. */
export function gateKey(member: string, op: string, gate: string): string {
  return `${member}/${op}/${gate}`;
}

/** `chant approve` for a gate, with its env and plan, the way arugula builds it when status gives no line. */
export function approveArgs(g: Pick<WorkspaceGate, "op" | "gate" | "env" | "planDigest">): string[] {
  return ["approve", g.op, g.gate, ...(g.env ? ["--env", g.env] : []), ...(g.planDigest ? ["--plan", g.planDigest] : [])];
}

/**
 * Read a status document into its waiting gates. `root` resolves each
 * member's `dir`. A document with another contract is refused whole.
 */
export function parseWorkspaceStatus(text: string, root: string): GatesRead {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, refusal: { error: "chant workspace status printed something that is not JSON.", code: "workspace-status", remedy: "Run `chant workspace status <env> --json` in the workspace root to see what it says." } };
  }
  if (!isRecord(doc)) return { ok: false, refusal: { error: "chant workspace status printed JSON that is not an object.", code: "workspace-status", remedy: "Run `chant workspace status <env> --json` in the workspace root." } };
  return gatesFromStatus(doc, root);
}

/** The waiting gates in a status document the reader returned. */
export function gatesFromStatus(doc: WorkspaceDocument, root: string): GatesRead {
  const contract = contractRefusal(doc, "status");
  if (contract) return { ok: false, refusal: contract };
  if (isRecord(doc.error)) {
    const code = String(doc.error.code ?? "unknown");
    return { ok: false, refusal: { error: `chant could not read the workspace's status: ${code}: ${String(doc.error.message ?? "")}`, code, remedy: "`chant workspace check` names the problem and where it is." } };
  }
  const gates: WorkspaceGate[] = [];
  for (const m of Array.isArray(doc.members) ? doc.members : []) {
    if (!isRecord(m) || typeof m.name !== "string") continue;
    const dir = typeof m.dir === "string" ? (m.dir === "." ? resolve(root) : resolve(root, m.dir)) : resolve(root);
    for (const g of Array.isArray(m.gates) ? m.gates : []) {
      if (!isRecord(g)) continue;
      if (g.state !== undefined && g.state !== "pending") continue;
      const op = str(g.component);
      const gate = str(g.name);
      if (!op || !gate) continue;
      const env = str(g.env);
      const planDigest = str(g.planDigest);
      const approvals = (Array.isArray(g.approvals) ? g.approvals : []).filter(isRecord).map((a) => ({
        principal: String(a.principal ?? "unknown"),
        at: str(a.at),
        channel: str(a.channel),
      }));
      gates.push({
        key: gateKey(m.name, op, gate),
        member: m.name,
        dir,
        op,
        gate,
        env,
        planDigest,
        approvals,
        needed: typeof g.needed === "number" ? g.needed : 1,
        recordedAt: str(g.recordedAt),
        expiresAt: str(g.expiresAt),
        signed: isRecord(g.signed),
        // status's line already carries --sign for a signed gate; only the
        // line built here needs it added.
        approve: str(g.approve) ?? ["chant", ...approveArgs({ op, gate, env, planDigest }), ...(isRecord(g.signed) ? ["--sign"] : [])].join(" "),
      });
    }
  }
  return { ok: true, env: String(doc.env ?? ""), gates };
}

/** Ask the workspace's chant for its status in `env`, through the reader (#468). */
export async function readWorkspaceGates(ws: Workspace, env: string, reader: WorkspaceReader = rootReader(ws.root)): Promise<GatesRead> {
  try {
    return gatesFromStatus(await reader.read("status", [env]), ws.root);
  } catch (e) {
    if (e instanceof WorkspaceReadError) return { ok: false, refusal: e.refusal };
    throw e;
  }
}

/** An env name chant can take as a positional argument: never a flag. */
export function isEnvName(env: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(env);
}

/** Who `chant approve` records when behold runs it with no --actor: chant's own fallback. */
export function localApprover(env: NodeJS.ProcessEnv = process.env): string {
  return env.GITHUB_ACTOR ?? env.GITLAB_USER_LOGIN ?? env.USER ?? "unknown";
}
