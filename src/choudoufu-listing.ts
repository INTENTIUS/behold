/**
 * `choudoufu live-ls -json`, read for a move's evidence (#411,
 * src/choudoufu-moves.ts): which addresses the account lists under an
 * estate's marker after a `live-mv`. Ownership is not read from it: a
 * member's cards are painted from chant's live read (src/choudoufu-ownership.ts,
 * behold#1227).
 */
import { stripAnsiLines, type Captured, type ChoudoufuRefusal } from "./choudoufu-member.ts";

export interface LiveLsItem {
  id: string;
  type: string;
  address?: string;
  slot?: string;
  declared: boolean;
  source: string;
  tags: Record<string, string>;
}

export interface LiveLsGap {
  address: string;
  type: string;
  rung: string;
  detail: string;
}

export interface LiveLsDocument {
  estate: string;
  region?: string;
  consistent: boolean;
  stabilized: boolean;
  attempts: number;
  config_dir?: string;
  schemas?: string;
  items: LiveLsItem[];
  gaps?: LiveLsGap[] | null;
  gaps_skipped?: string;
}

export type LiveLsParse = { ok: true; doc: LiveLsDocument } | { ok: false; refusal: ChoudoufuRefusal };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const refuse = (error: string, remedy: string): { ok: false; refusal: ChoudoufuRefusal } => ({ ok: false, refusal: { error, code: "choudoufu-live-check", remedy } });
const CREDS = "Give behold the ambient read-only AWS credentials the estate's `live-ls` needs (AWS_PROFILE, or AWS_ENDPOINT_URL for an emulator), then reload.";

/** What a failed spawn said, as one line: choudoufu's own `Error:` line when there is one. */
function said(run: Captured, fallback: string): string {
  const lines = stripAnsiLines(run.stderr);
  return lines.find((l) => /^Error:/.test(l)) ?? lines[0] ?? fallback;
}

/** Validate `live-ls -json` output. Shallow: the fields read, plus the `schemas` key that marks a document new enough to trust. */
export function parseLiveLs(run: Captured, dir: string): LiveLsParse {
  if (run.code === 127) return refuse("choudoufu is not on PATH.", "Install choudoufu and put it on PATH.");
  const text = run.stdout.trim();
  if (!text) return refuse(`choudoufu live-ls could not list ${dir}: ${said(run, `exit ${run.code}`)}`, CREDS);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return refuse(`choudoufu live-ls printed something that is not JSON in ${dir}: ${said(run, "unparseable stdout")}`, CREDS);
  }
  if (!isRecord(json) || typeof json.estate !== "string" || !Array.isArray(json.items)) {
    return refuse("That is not a live-ls document — no `estate` and `items`.", CREDS);
  }
  if (typeof json.schemas !== "string") {
    return refuse("This live-ls document carries no `schemas` field: it was written by a choudoufu older than 0.16.0.", "Upgrade choudoufu to 0.16.0 or newer.");
  }
  return { ok: true, doc: json as unknown as LiveLsDocument };
}
