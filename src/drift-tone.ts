/**
 * behold#995 (B2): the colour of a card is one fixed table over chant's drift
 * record (INTENTIUS/chant#4451): the record's `status` and the `read` that
 * answered, and nothing else. No engine is named here. A chant member read
 * through `lifecycle diff --live`, a Terraform root read from its state or a
 * plan, a choudoufu estate read through `live-plan`, and a Pulumi stack read
 * with a refresh preview (path 2, chant#4453) all arrive as records, so they
 * all colour through {@link toneFor}, and a new engine needs no row of its own.
 *
 * The read is in the key because it limits what a status can claim:
 *
 * - An `ownership` read (choudoufu's `live-plan`) says who holds an object
 *   and never compares a value, so its `in-sync` is "bound: this is ours"
 *   (#404), green, and labelled so it is never read as "nothing changed".
 * - A `state` read says what the last apply recorded. chant refuses any state
 *   read status but `recorded`, `pending` and `not-observed`; `recorded` is
 *   neutral, since it is not a look at the account. A state-read row for any
 *   other status is a record chant would have refused, and it is neutral and
 *   labelled as such.
 *
 * A status or a read behold does not know is neutral and labelled unknown,
 * never a colour behold guessed (the epic's invariant, #993).
 *
 * ## UNOWNED (settled with chant)
 *
 * chant C1 decided that a choudoufu `UNOWNED` omission with no `unowned[]`
 * row is `not-observed` (`read-failed`), `engineCode: "UNOWNED"`: nothing in
 * the document says what holds the identity. behold painted it `warn` before.
 * It now follows chant: such a card is neutral and not observed. An `UNOWNED`
 * omission WITH its `unowned[]` row is `unclaimed`, as before, and `warn`.
 */

/** The pinhole status a card is painted with (`attrs._status`). */
export type CardTone = "good" | "warn" | "accent" | "neutral" | "runtime";

export interface Tone {
  tone: CardTone;
  /** The words beside the colour, in the record's terms. */
  label: string;
  /** Set when the tone says "behold does not know": the status or read is outside the table. */
  unknown?: true;
}

/** chant's statuses (`DRIFT_STATUSES`), in its order. */
export const TABLE_STATUSES = ["in-sync", "drifted", "pending", "missing", "unclaimed", "undeclared", "runtime", "recorded", "not-observed"] as const;
/** chant's reads (`DRIFT_READS`), in its order. */
export const TABLE_READS = ["state", "plan", "refresh", "live-read", "ownership"] as const;

type Status = (typeof TABLE_STATUSES)[number];
type Read = (typeof TABLE_READS)[number];

const t = (tone: CardTone, label: string): Tone => ({ tone, label });
/** A cell chant's own constructor refuses (a state read that claims to have looked). */
const refusedByChant = (status: string): Tone => ({ tone: "neutral", label: `${status} from a state read, which chant never writes`, unknown: true });

/**
 * The table. Every `(status, read)` pair has a cell; nothing is computed
 * outside it except `not-observed`'s reason, which goes into the label.
 */
export const DRIFT_TONE_TABLE: Readonly<Record<Status, Readonly<Record<Read, Tone>>>> = {
  "in-sync": {
    state: refusedByChant("in-sync"),
    plan: t("good", "in sync (plan: no change)"),
    refresh: t("good", "in sync (refresh: no change)"),
    "live-read": t("good", "in sync"),
    ownership: t("good", "bound (ownership only, values not compared)"),
  },
  drifted: {
    state: refusedByChant("drifted"),
    plan: t("warn", "drifted (plan)"),
    refresh: t("warn", "drifted (refresh)"),
    "live-read": t("warn", "drifted"),
    ownership: t("warn", "drifted"),
  },
  pending: {
    state: t("accent", "pending (not in state)"),
    plan: t("accent", "pending (plan creates it)"),
    refresh: t("accent", "pending"),
    "live-read": t("accent", "pending"),
    ownership: t("accent", "pending (absent)"),
  },
  missing: {
    state: t("warn", "missing"),
    plan: t("warn", "missing (deleted out of band)"),
    refresh: t("warn", "missing"),
    "live-read": t("warn", "missing"),
    ownership: t("warn", "missing"),
  },
  unclaimed: {
    state: t("warn", "unclaimed"),
    plan: t("warn", "unclaimed"),
    refresh: t("warn", "unclaimed"),
    "live-read": t("warn", "unclaimed"),
    ownership: t("warn", "unclaimed (not ours)"),
  },
  undeclared: {
    state: t("warn", "undeclared (in state, not declared)"),
    plan: t("warn", "undeclared"),
    refresh: t("warn", "undeclared"),
    "live-read": t("warn", "undeclared"),
    ownership: t("warn", "undeclared (marked ours, declared nowhere)"),
  },
  runtime: {
    state: t("runtime", "runtime"),
    plan: t("runtime", "runtime"),
    refresh: t("runtime", "runtime"),
    "live-read": t("runtime", "runtime"),
    ownership: t("runtime", "runtime (held by a controller)"),
  },
  recorded: {
    state: t("neutral", "recorded (state only, not a live read)"),
    plan: t("neutral", "recorded"),
    refresh: t("neutral", "recorded"),
    "live-read": t("neutral", "recorded"),
    ownership: t("neutral", "recorded"),
  },
  "not-observed": {
    state: t("neutral", "not observed"),
    plan: t("neutral", "not observed"),
    refresh: t("neutral", "not observed"),
    "live-read": t("neutral", "not observed"),
    ownership: t("neutral", "not observed"),
  },
};

/** The fields of a record the colour reads. `status` and `read` are strings: a value behold does not know still arrives. */
export interface ToneInput {
  status: string;
  read: string;
  unobserved?: { reason?: string } | undefined;
}

/** The colour of one record: the table's cell, or neutral and labelled unknown. */
export function toneFor(record: ToneInput): Tone {
  const row = (DRIFT_TONE_TABLE as Record<string, Record<string, Tone> | undefined>)[record.status];
  if (!row) return { tone: "neutral", label: `unknown status ${JSON.stringify(record.status)}`, unknown: true };
  const cell = row[record.read];
  if (!cell) return { tone: "neutral", label: `${record.status} from an unknown read ${JSON.stringify(record.read)}`, unknown: true };
  if (record.status === "not-observed") return { ...cell, label: `not observed: ${record.unobserved?.reason ?? "no reason given"}` };
  return cell;
}
