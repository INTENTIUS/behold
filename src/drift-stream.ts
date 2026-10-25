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
 * - `record`: one record, with the tone it paints ({@link toneFor}).
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
import type { WorkspaceMember } from "./workspace.ts";
import { notReachedRecord, type DriftLine, type DriftRecord, type DriftStartLine } from "./drift-line.ts";
import { streamDrift, type DriftStreamAsk, type StreamTransport } from "./workspace-reader.ts";

/** The pinhole status a card is painted with (`attrs._status`). */
export type CardTone = "good" | "warn" | "accent" | "neutral" | "runtime";

export interface Tone {
  tone: CardTone;
  /** The words beside the colour, in the record's terms. */
  label: string;
}

/**
 * The colour of one record.
 *
 * behold#995 (B2) replaces this function with its fixed `(status, read)`
 * table over the same record; everything that colours a streamed card calls
 * this one function and nothing else, so the swap is one import. Until then
 * the status alone decides, and a status it does not know is neutral and
 * says so.
 */
export function toneFor(record: Pick<DriftRecord, "status" | "read" | "unobserved">): Tone {
  switch (record.status) {
    case "in-sync": return { tone: "good", label: "in sync" };
    case "drifted": return { tone: "warn", label: "drifted" };
    case "pending": return { tone: "accent", label: "pending" };
    case "missing": return { tone: "warn", label: "missing" };
    case "unclaimed": return { tone: "warn", label: "unclaimed" };
    case "undeclared": return { tone: "warn", label: "undeclared" };
    case "runtime": return { tone: "runtime", label: "runtime" };
    case "recorded": return { tone: "neutral", label: "recorded (state only)" };
    case "not-observed": return { tone: "neutral", label: `not observed: ${record.unobserved?.reason ?? "no reason given"}` };
    default: return { tone: "neutral", label: `unknown status ${JSON.stringify(record.status)}` };
  }
}

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
  | { run: number; kind: "record"; member: string; address: string; node: string | null; status: string; read: string; tone: CardTone; label: string; reason?: string; notReached?: true }
  | { run: number; kind: "settle"; member: string; resource?: string; read: string; notReached: string[]; counts: Record<string, number> }
  | { run: number; kind: "failed"; member: string; resource?: string; error: string }
  | { run: number; kind: "end"; member: string };

function recordFrame(run: number, member: string, r: DriftRecord, notReached = false): DriftFrame {
  const t = toneFor(r);
  return {
    run, kind: "record", member, address: r.address, node: r.node, status: r.status, read: r.read, tone: t.tone, label: t.label,
    ...(r.unobserved ? { reason: r.unobserved.reason } : {}),
    ...(notReached ? { notReached: true as const } : {}),
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
