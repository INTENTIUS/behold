/**
 * behold#998: streamed drift. Each card is coloured as its record arrives.
 *
 * `POST /api/workspace/drift/stream {member, resources?}` starts one run, and
 * the run is narrated over `/api/events` as `drift` frames, one per line chant
 * prints (src/workspace-reader.ts `streamDrift`):
 *
 * - `begin`: the member, and how it is asked (`plan`, below).
 * - `start`: a read opened, with the addresses it expects. The page shows
 *   each of them as reading, which is not a status: the fill stays what it
 *   was and the card is only dimmed and dashed.
 * - `record`: one record, with the tone it paints (src/drift-tone.ts `toneFor`, behold#995's `(status, read)` table).
 * - `settle`: the read closed. Every address its start expected that no
 *   record answered becomes `not-observed`, reason `not-reached`, chant's
 *   fold rule (`foldDriftLines`), sent as a `record` frame of its own just
 *   before the settle frame, so no card stays reading after a settle.
 * - `failed`: one read failed or printed something that is not a drift line.
 *   Its cards stop reading and keep the colour they had.
 * - `end`: the run is over.
 *
 * ## Per resource on a choudoufu member
 *
 * choudoufu's single-resource path (`live-plan -resource=ADDR`,
 * INTENTIUS/choudoufu#2245) plans one resource's cone, and writes its records
 * at the end of that plan, not one by one as reads return. A whole-estate
 * `live-plan` stream does not exist. So on a choudoufu member behold asks once
 * per resource (`--resource <block address>`), one after another, and the
 * cards change colour resource by resource. Any other member is asked once,
 * without `--resource`, and its cards change as chant prints its records.
 *
 * One run at a time, server-wide: a second start while one runs is refused.
 */
import type { Hono } from "hono";
import { resolveChant } from "./chant.ts";
import { floorFor, floorMet, floorRefusal } from "./chant-floors.ts";
import { MAX_BODY_BYTES } from "./layout.ts";
import type { Workspace, WorkspaceMember } from "./workspace.ts";
import { notReachedRecord, type DriftLine, type DriftRecord, type DriftStartLine } from "./drift-line.ts";
import { streamDrift, type DriftStreamAsk, type StreamTransport } from "./workspace-reader.ts";

/**
 * The colour of one record is behold#995's fixed `(status, read)` table
 * (src/drift-tone.ts). Everything that colours a streamed card calls
 * {@link toneFor} and nothing else.
 */
export { toneFor, type CardTone, type Tone } from "./drift-tone.ts";
import { toneFor, type CardTone } from "./drift-tone.ts";

/** An address behold passes to `--resource`: a managed resource, in any module. Never a flag, never a data source. */
const RESOURCE = /^(module\.[A-Za-z_][\w-]*(\[[^\]\n]{1,200}\])?\.)*[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*$/;

/**
 * The resource blocks to ask about, from the addresses of a member's cards:
 * each instance key dropped (choudoufu plans a block's whole cone and reports
 * every instance), data sources left out (`-resource` refuses them), each
 * block once, in the order first seen. An address that is not a resource
 * address is left out.
 */
export function resourceBlocks(addresses: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of addresses) {
    if (typeof a !== "string" || a.length > 512) continue;
    const block = a.replace(/\[[^\]]*\]$/, "");
    const local = block.replace(/^(module\.[^.[]+(\[[^\]]*\])?\.)*/, "");
    if (local.startsWith("data.")) continue;
    if (!RESOURCE.test(block) || out.includes(block)) continue;
    out.push(block);
  }
  return out;
}

export type DriftFrame =
  | { run: number; kind: "begin"; member: string; plan: "per-resource" | "member"; resources: string[] }
  | { run: number; kind: "start"; member: string; resource?: string; read: string; expected: string[] }
  | { run: number; kind: "record"; member: string; address: string; node: string | null; status: string; read: string; tone: CardTone; label: string; reason?: string; notReached?: true; unknown?: true }
  | { run: number; kind: "settle"; member: string; resource?: string; read: string; notReached: string[]; counts: Record<string, number> }
  | { run: number; kind: "failed"; member: string; resource?: string; error: string }
  | { run: number; kind: "end"; member: string };

function recordFrame(run: number, member: string, r: DriftRecord, notReached = false): DriftFrame {
  const t = toneFor(r);
  return {
    run, kind: "record", member, address: r.address, node: r.node, status: r.status, read: r.read, tone: t.tone, label: t.label,
    ...(r.unobserved ? { reason: r.unobserved.reason } : {}),
    ...(notReached ? { notReached: true as const } : {}),
    ...(t.unknown ? { unknown: true as const } : {}),
  };
}

export interface DriftRunOptions {
  run: number;
  member: WorkspaceMember;
  /** The addresses of the member's cards, from the page. Read only on a choudoufu member. */
  addresses?: readonly string[];
  transport: StreamTransport;
  emit: (frame: DriftFrame) => void;
  /** Stop the run: the read in flight is killed and no further one starts. */
  signal?: AbortSignal;
  now?: () => string;
}

/**
 * Run the stream for one member. Frames are emitted as lines arrive; the
 * promise settles after the `end` frame. The member in each frame is the
 * workspace member behold asked about, not the record's own `member`
 * (choudoufu writes its estate name there).
 */
export async function runDriftStream(o: DriftRunOptions): Promise<void> {
  const name = o.member.name;
  const now = o.now ?? (() => new Date().toISOString());
  const perResource = o.member.kind === "choudoufu";
  const resources = perResource ? resourceBlocks(o.addresses ?? []) : [];
  o.emit({ run: o.run, kind: "begin", member: name, plan: perResource ? "per-resource" : "member", resources });
  if (perResource && resources.length === 0) {
    o.emit({ run: o.run, kind: "failed", member: name, error: "no resource cards to ask about: a choudoufu member is read one resource at a time, and the page sent no resource address" });
  }
  const asks: DriftStreamAsk[] = perResource ? resources.map((resource) => ({ member: name, resource })) : [{ member: name }];
  for (const ask of asks) {
    if (o.signal?.aborted) break;
    const open = new Map<string, DriftStartLine>();
    const answered = new Set<string>();
    let sawStart = false;
    const onLine = (line: DriftLine): void => {
      if (line.type === "drift-start") {
        sawStart = true;
        open.set(line.read, line);
        o.emit({ run: o.run, kind: "start", member: name, ...(ask.resource ? { resource: ask.resource } : {}), read: line.read, expected: line.expected.map((e) => e.address) });
      } else if (line.type === "drift-record") {
        const { type: _type, ...r } = line;
        answered.add(r.address);
        o.emit(recordFrame(o.run, name, r));
      } else {
        const start = open.get(line.read);
        open.delete(line.read);
        const expected = new Map((start?.expected ?? []).map((e) => [e.address, e]));
        for (const a of line.notReached ?? []) if (!expected.has(a)) expected.set(a, { address: a });
        const at = line.at ?? start?.at ?? now();
        const head: DriftStartLine = start ?? { type: "drift-start", drift: "v1", member: line.member, engine: line.engine, read: line.read, expected: [] };
        const notReached: string[] = [];
        for (const e of expected.values()) {
          if (answered.has(e.address)) continue;
          answered.add(e.address);
          notReached.push(e.address);
          o.emit(recordFrame(o.run, name, notReachedRecord(head, e, at), true));
        }
        o.emit({ run: o.run, kind: "settle", member: name, ...(ask.resource ? { resource: ask.resource } : {}), read: line.read, notReached, counts: line.counts as Record<string, number> });
      }
    };
    const read = streamDrift(o.transport, ask, onLine);
    const stop = (): void => read.kill();
    o.signal?.addEventListener("abort", stop, { once: true });
    const end = await read.done;
    o.signal?.removeEventListener("abort", stop);
    const unsettled = open.size > 0;
    if (end.refused || end.status !== 0 || unsettled) {
      const said = end.stderr.trim().split("\n").slice(-2).join(" ");
      const error = end.refused
        ?? (o.signal?.aborted ? "stopped" : end.status !== 0 ? `chant exited ${end.status ?? "on a signal"}${said ? `: ${said}` : ""}` : "the read ended without a drift-settle line");
      o.emit({ run: o.run, kind: "failed", member: name, ...(ask.resource ? { resource: ask.resource } : {}), error });
      // No start at all: the command itself is missing or refused, and every
      // further resource would fail the same way.
      if (!sawStart) break;
    }
  }
  o.emit({ run: o.run, kind: "end", member: name });
}

/**
 * behold#1005: the refusal a start gets when the project's chant is older
 * than {@link DRIFT_STREAM_CHANT_FLOOR} (src/chant-floors.ts), or undefined.
 * An unknown version meets it, as every floor.
 */
export function driftStreamFloorRefusal(version: string | undefined): { error: string; code: string; remedy: string } | undefined {
  const f = floorFor("streamed drift");
  return floorMet(f, version) ? undefined : floorRefusal(f, version);
}

export interface DriftStreamRouteOptions {
  workspace: () => Workspace | undefined;
  /** The stream transport over the workspace root's chant. */
  transport: (root: string) => StreamTransport;
  emit: (frame: DriftFrame) => void;
  /** The project's chant version. Default: the root's own chant (`resolveChant`). */
  chantVersion?: (root: string) => string | undefined;
  /**
   * The chant the stream runs instead of the root's (`BEHOLD_DRIFT_CHANT`: a
   * chant built ahead of its release, or the e2e's fake). The root's version
   * says nothing about it, so the floor is not checked against it.
   */
  chantBin?: string;
}

/**
 * behold#998: streamed drift. `POST /api/workspace/drift/stream` starts one
 * run of `chant workspace drift --member <name> --stream` (per resource on a
 * choudoufu member) and narrates it as `drift` frames on /api/events. It
 * reads and writes nothing, but it reaches the account, so it is a POST with
 * a JSON body like every other started command, refused under --public by
 * the request guard. The page sends its member's card addresses; the server
 * keeps only resource addresses from them, and they go to chant after
 * `--resource`, never as an operand. behold#1005: on a chant below
 * DRIFT_STREAM_CHANT_FLOOR the start answers 409 with the floor's refusal and
 * spawns nothing.
 */
export function driftStreamRoutes(app: Hono, opts: DriftStreamRouteOptions): void {
  const versionOf = opts.chantVersion ?? ((root: string) => resolveChant(root).version);
  let driftRun: { id: number; member: string; stop: AbortController } | null = null;
  let driftRuns = 0;
  app.post("/api/workspace/drift/stream", async (c) => {
    const ws = opts.workspace();
    if (!ws) return c.json({ error: "behold isn't serving a declared chant workspace, so there is no member to stream drift for.", code: "no-workspace" }, 404);
    if (!(c.req.header("content-type") ?? "").includes("application/json")) return c.json({ error: "send application/json", code: "bad-drift" }, 415);
    const text = await c.req.text().catch(() => "");
    if (text.length > MAX_BODY_BYTES * 4) return c.json({ error: `a drift stream body is capped at ${MAX_BODY_BYTES * 4} bytes`, code: "too-large" }, 413);
    let body: { member?: unknown; addresses?: unknown; stop?: unknown };
    try {
      body = JSON.parse(text || "null") ?? {};
    } catch {
      return c.json({ error: "body must be JSON", code: "bad-drift" }, 400);
    }
    if (body.stop === true) {
      if (driftRun) driftRun.stop.abort();
      return c.json({ stopped: driftRun ? driftRun.id : null });
    }
    const member = ws.members.find((m) => m.name === body.member);
    if (!member || member.reason) return c.json({ error: member ? `${member.name} can't be read: ${member.because ?? member.reason}` : `${String(body.member)} isn't a member of ${ws.name}.`, code: "drift-member" }, 400);
    if (opts.chantBin === undefined) {
      const version = versionOf(ws.root);
      const tooOld = driftStreamFloorRefusal(version);
      if (tooOld) return c.json({ ...tooOld, chant: version ?? null }, 409);
    }
    if (driftRun) return c.json({ error: `drift is already streaming for ${driftRun.member} (run ${driftRun.id}).`, code: "drift-streaming", run: driftRun.id }, 409);
    const addresses = Array.isArray(body.addresses) ? body.addresses.filter((a): a is string => typeof a === "string") : [];
    const run = { id: ++driftRuns, member: member.name, stop: new AbortController() };
    driftRun = run;
    void runDriftStream({
      run: run.id,
      member,
      addresses,
      transport: opts.transport(ws.root),
      emit: opts.emit,
      signal: run.stop.signal,
    })
      .catch((e) => opts.emit({ run: run.id, kind: "failed", member: member.name, error: (e as Error).message }))
      .finally(() => {
        if (driftRun === run) driftRun = null;
      });
    return c.json({ run: run.id, member: member.name, kind: member.kind }, 202);
  });
}
