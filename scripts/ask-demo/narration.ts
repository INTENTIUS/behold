/**
 * behold#1161: the pure half of the ask demo's recorder. Everything here
 * takes answers in and gives turns out; scripts/ask-demo/record.ts boots the
 * estate and makes the calls. src/ask-demo.test.ts runs these against a
 * stubbed `behold mcp`.
 *
 * A turn is what the page (behold#1163) plays: the person's prompt, the call
 * the agent made, the Cypher behold ran, the rows it answered, the estate
 * graph's nodes to light, when each source was read, and the agent's reply
 * with its numbers filled from the rows. ask-demo/narration.schema.json
 * describes each field.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { lightKeys } from "../../web/key-light.js";

/** The format string every narration carries. */
export const NARRATION_FORMAT = "behold-ask-demo-narration/1";

/** One `behold mcp ask` call: a Cypher query with its parameters, or a resource and a template to run on it. */
export type AskCall = { cypher: string; params?: Record<string, string | number | boolean | null> } | { resource: string; template: string; inputs?: Record<string, string> };

/** One entry of scripts/ask-demo/questions.ts. */
export interface Question {
  /** A short stable id, used in verdict lines and as the turn's id. */
  id: string;
  /** What the person types to their agent. */
  prompt: string;
  /** The one ask call the agent makes. */
  ask: AskCall;
  /** The agent's reply, with placeholders filled from the answer's rows ({@link fillReply}). */
  reply: string;
}

/** A source line as the graph pane's routes stamp it. */
export interface SourceStamp {
  scopeKey: string;
  source: string;
  name: string;
  member?: string;
  version?: string;
  observedAt: string | null;
  readAt: string;
  nodes?: number;
  edges?: number;
}

/** What an ask with cypher or a Cypher template answered (GET /api/graphdb/query or /template, through the tool). */
export interface GraphAnswer {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  keys: string[];
  truncated?: boolean;
  draw?: { nodes: unknown[]; edges: unknown[] };
  sources: SourceStamp[];
  /** A template's expansion: its name, and the query and parameters it ran. */
  expanded?: { template: string; language: string; query: string; params?: Record<string, unknown> };
  cypher?: string;
}

export interface TurnSource {
  scopeKey: string;
  source: string;
  name: string;
  readAt: string;
  observedAt: string | null;
  nodes?: number;
  edges?: number;
}

export interface Turn {
  id: string;
  kind: "load" | "question";
  prompt: string;
  call: { tool: "ask"; arguments: Record<string, string> } | { commands: string[] };
  busy: string;
  cypher: string | null;
  params: Record<string, unknown>;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  keys: string[];
  light: string[];
  draw?: { nodes: unknown[]; edges: unknown[] };
  sources: TurnSource[];
  reply: string;
}

export interface Narration {
  $schema?: string;
  format: typeof NARRATION_FORMAT;
  recordedAt: string;
  note: string;
  recordCommand: string;
  agentCommand: string;
  versions: { behold: string; chant: string; [tool: string]: string };
  turns: Turn[];
}

// ---------------------------------------------------------------------------
// Reply templates.
// ---------------------------------------------------------------------------

/** A reply that cannot be filled from the rows it was given. The question is dropped, never kept half-filled. */
export class ReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyError";
  }
}

const cell = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** "a", "a and b", "a, b and c". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function column(rows: ReadonlyArray<Record<string, unknown>>, columns: readonly string[], name: string, placeholder: string): string[] {
  if (!columns.includes(name)) throw new ReplyError(`${placeholder} names column ${name}, and the answer's columns are ${columns.join(", ") || "none"}`);
  const out: string[] = [];
  for (const r of rows) {
    const v = cell(r[name]);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Fill a reply from the rows. Placeholders:
 *
 *   {{count}}            the number of rows
 *   {{count:col}}        the number of distinct non-empty values in col
 *   {{sum:col}}          the sum of col, a number column
 *   {{list:col}}         col's distinct non-empty values, joined "a, b and c"
 *   {{first:col}}        col in the first row
 *   {{each:… {col} …}}   the pattern once per row, joined "a, b and c"
 *
 * A placeholder that names a column the answer lacks, or that would print
 * nothing, throws {@link ReplyError}: a reply never says less than it claims.
 */
export function fillReply(template: string, answer: { columns: readonly string[]; rows: ReadonlyArray<Record<string, unknown>> }): string {
  const { columns, rows } = answer;
  return template.replace(/\{\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\}/g, (whole, body: string) => {
    const [op, ...restParts] = body.split(":");
    const arg = restParts.join(":");
    if (op === "count" && !arg) return String(rows.length);
    if (!arg) throw new ReplyError(`${whole} is not a placeholder this filler knows`);
    if (op === "count") return String(column(rows, columns, arg, whole).length);
    if (op === "sum") {
      if (!columns.includes(arg)) throw new ReplyError(`${whole} names column ${arg}, and the answer's columns are ${columns.join(", ")}`);
      let total = 0;
      for (const r of rows) {
        const v = r[arg];
        if (typeof v !== "number") throw new ReplyError(`${whole}: ${arg} holds ${JSON.stringify(v)}, not a number`);
        total += v;
      }
      return String(total);
    }
    if (op === "list" || op === "first") {
      const values = column(rows, columns, arg, whole);
      if (!values.length) throw new ReplyError(`${whole} has no value to print: ${arg} is empty in every row`);
      return op === "list" ? joinList(values) : cell(rows[0]![arg]) || values[0]!;
    }
    if (op === "each") {
      const parts = rows.map((r) =>
        arg.replace(/\{([^{}]+)\}/g, (_, name: string) => {
          if (!columns.includes(name)) throw new ReplyError(`${whole} names column ${name}, and the answer's columns are ${columns.join(", ")}`);
          const v = cell(r[name]);
          if (!v) throw new ReplyError(`${whole}: ${name} is empty in a row`);
          return v;
        }),
      );
      return joinList([...new Set(parts)]);
    }
    throw new ReplyError(`${whole} is not a placeholder this filler knows`);
  });
}

// ---------------------------------------------------------------------------
// Answers.
// ---------------------------------------------------------------------------

/** A question that must not go in the file: it errored, or it answered nothing. */
export class Dropped extends Error {
  constructor(
    readonly questionId: string,
    readonly reason: string,
  ) {
    super(`${questionId}: ${reason}`);
    this.name = "Dropped";
  }
}

/**
 * The answer in a tool result, or why there is none. The first text block is
 * the route's answer, as JSON; the second is the tool's note, which names the
 * serve that answered. With `serve`, an answer behold made in the tool's own
 * process (no serve found) is dropped: it would not have read what the
 * serve loaded.
 */
export function answerOf(result: CallToolResult, id: string, serve?: string): GraphAnswer {
  const texts = result.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text);
  const text = texts[0] ?? "";
  if (result.isError) {
    let why = text;
    try {
      const e = JSON.parse(text) as { error?: unknown };
      if (typeof e.error === "string") why = e.error;
    } catch {
      // a plain-text refusal
    }
    throw new Dropped(id, `ask refused: ${why.split("\n")[0]!.slice(0, 300)}`);
  }
  if (serve && !texts.slice(1).some((t) => t.includes(serve))) throw new Dropped(id, `ask did not answer through the serve at ${serve}: ${(texts[1] ?? "no note").slice(0, 200)}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Dropped(id, `ask answered no JSON: ${text.slice(0, 200)}`);
  }
  const a = body as Partial<GraphAnswer> & { error?: unknown; search?: unknown };
  if (typeof a.error === "string") throw new Dropped(id, `ask answered an error: ${a.error}`);
  if (a.search !== undefined && !Array.isArray(a.rows)) throw new Dropped(id, "the template is a chant search pattern, which this recording does not run; pick a Cypher template");
  if (!Array.isArray(a.columns) || !Array.isArray(a.rows)) throw new Dropped(id, "ask answered no columns and rows");
  return { columns: a.columns, rows: a.rows, keys: Array.isArray(a.keys) ? a.keys : [], sources: Array.isArray(a.sources) ? a.sources : [], ...(a.truncated !== undefined ? { truncated: a.truncated } : {}), ...(a.draw ? { draw: a.draw } : {}), ...(a.expanded ? { expanded: a.expanded } : {}), ...(typeof a.cypher === "string" ? { cypher: a.cypher } : {}) };
}

/** The refusal of an empty answer: a question whose real answer is empty is dropped, never recorded empty. */
export function refuseEmpty(answer: GraphAnswer, id: string): GraphAnswer {
  if (!answer.rows.length) throw new Dropped(id, "the answer has no rows");
  if (answer.truncated) throw new Dropped(id, "the answer was truncated; narrow the query");
  return answer;
}

// ---------------------------------------------------------------------------
// Lighting.
// ---------------------------------------------------------------------------

/** The estate graph's nodes as GET /api/graph draws them: an id, and for a stacked card the ids it stands for. */
export type { IrNodeLike } from "../../web/key-light.js";

// behold#1163: the page lights a visitor's answer with the same two functions, so they live with it (web/key-light.js).
export { cardIndex, lightKeys } from "../../web/key-light.js";

// ---------------------------------------------------------------------------
// Turns.
// ---------------------------------------------------------------------------

/** The ask tool's arguments for a call, as the MCP tool takes them: strings, params and inputs as JSON. */
export function askArguments(call: AskCall): Record<string, string> {
  if ("cypher" in call) return { cypher: call.cypher, ...(call.params && Object.keys(call.params).length ? { params: JSON.stringify(call.params) } : {}) };
  return { resource: call.resource, template: call.template, ...(call.inputs && Object.keys(call.inputs).length ? { inputs: JSON.stringify(call.inputs) } : {}) };
}

/** The busy line the prompt pane shows while the call runs. */
export function busyLine(call: AskCall): string {
  if ("cypher" in call) return "behold mcp ask: running a Cypher query over the estate graph";
  return `behold mcp ask: resolving ${call.resource}, then running the ${call.template} template on it`;
}

export function turnSources(sources: readonly SourceStamp[]): TurnSource[] {
  return sources.map((s) => ({
    scopeKey: s.scopeKey,
    source: s.source,
    name: s.name,
    readAt: s.readAt,
    observedAt: s.observedAt ?? null,
    ...(typeof s.nodes === "number" ? { nodes: s.nodes } : {}),
    ...(typeof s.edges === "number" ? { edges: s.edges } : {}),
  }));
}

/**
 * The reply a question's turn carries (behold#1174): what ran and how many
 * rows came back, then the question's own template filled from the rows, then
 * where the Cypher is. Throws {@link ReplyError} when the template cannot be filled.
 */
export function questionReply(template: string, answer: { columns: readonly string[]; rows: ReadonlyArray<Record<string, unknown>> }): string {
  const n = answer.rows.length;
  return `behold's query ran and returned ${n} row${n === 1 ? "" : "s"}. ${fillReply(template, answer)} The Cypher it ran is in the Cypher pane; you can edit it there once I'm done.`;
}

/** One question's turn from its answer. Throws Dropped when the answer is empty or the reply cannot be filled. */
export function questionTurn(q: Question, answer: GraphAnswer, cards: ReadonlyMap<string, string>): Turn {
  refuseEmpty(answer, q.id);
  let reply: string;
  try {
    reply = questionReply(q.reply, answer);
  } catch (e) {
    if (e instanceof ReplyError) throw new Dropped(q.id, `the reply cannot be filled: ${e.message}`);
    throw e;
  }
  const cypher = "cypher" in q.ask ? q.ask.cypher : answer.expanded?.query;
  if (!cypher) throw new Dropped(q.id, "the answer does not say which Cypher ran");
  const params = "cypher" in q.ask ? (q.ask.params ?? {}) : (answer.expanded?.params ?? {});
  return {
    id: q.id,
    kind: "question",
    prompt: q.prompt,
    call: { tool: "ask", arguments: askArguments(q.ask) },
    busy: busyLine(q.ask),
    cypher,
    params,
    columns: answer.columns,
    rows: answer.rows,
    keys: answer.keys,
    light: lightKeys(answer, cards),
    ...(answer.draw ? { draw: answer.draw } : {}),
    sources: turnSources(answer.sources),
    reply,
  };
}

/** The load turn: the commands that filled behold, and what each source loaded, as GET /api/graphdb listed it. */
export function loadTurn(o: { prompt: string; commands: string[]; reply: string; sources: readonly SourceStamp[]; cards: ReadonlyMap<string, string> }): Turn {
  const columns = ["scopeKey", "source", "name", "nodes", "edges"];
  const rows = o.sources.map((s) => ({ scopeKey: s.scopeKey, source: s.source, name: s.name, nodes: s.nodes ?? 0, edges: s.edges ?? 0 }));
  if (!rows.length) throw new Dropped("load", "behold loaded no source");
  let reply: string;
  try {
    reply = fillReply(o.reply, { columns, rows });
  } catch (e) {
    if (e instanceof ReplyError) throw new Dropped("load", `the reply cannot be filled: ${e.message}`);
    throw e;
  }
  return {
    id: "load",
    kind: "load",
    prompt: o.prompt,
    call: { commands: o.commands },
    busy: `${o.commands[o.commands.length - 1]}: loading every source into one graph`,
    cypher: null,
    params: {},
    columns,
    rows,
    keys: [],
    light: [...new Set(o.cards.values())],
    sources: turnSources(o.sources),
    reply,
  };
}

export interface Verdict {
  id: string;
  ok: boolean;
  line: string;
}

/** The one line a question prints. */
export function verdictLine(r: { id: string; turn?: Turn; dropped?: string }): string {
  if (r.turn) return `ok    ${r.id}: ${r.turn.rows.length} row${r.turn.rows.length === 1 ? "" : "s"}, ${r.turn.light.length} card${r.turn.light.length === 1 ? "" : "s"} lit. ${r.turn.reply}`;
  return `DROP  ${r.id}: ${r.dropped}`;
}

/** The ask tool, as the recorder calls it: `client.callTool({ name: "ask", arguments })`, or a stub in tests. */
export type Ask = (args: Record<string, string>) => Promise<CallToolResult>;

/** Ask every question; keep each turn that answered, and drop the rest with the reason. */
export async function askAll(questions: readonly Question[], ask: Ask, cards: ReadonlyMap<string, string>, serve?: string): Promise<{ turns: Turn[]; verdicts: Verdict[] }> {
  const turns: Turn[] = [];
  const verdicts: Verdict[] = [];
  for (const q of questions) {
    try {
      const result = await ask(askArguments(q.ask));
      const turn = questionTurn(q, answerOf(result, q.id, serve), cards);
      turns.push(turn);
      verdicts.push({ id: q.id, ok: true, line: verdictLine({ id: q.id, turn }) });
    } catch (e) {
      const reason = e instanceof Dropped ? e.reason : `ask threw: ${(e as Error).message}`;
      verdicts.push({ id: q.id, ok: false, line: verdictLine({ id: q.id, dropped: reason }) });
    }
  }
  return { turns, verdicts };
}

/** The ids must be unique: a duplicate would make two turns the page cannot tell apart. */
export function checkQuestions(questions: readonly Question[]): void {
  const seen = new Set<string>(["load"]);
  for (const q of questions) {
    if (!/^[a-z0-9-]+$/.test(q.id)) throw new Error(`question id ${JSON.stringify(q.id)} is not lower-case words and dashes`);
    if (seen.has(q.id)) throw new Error(`question id ${q.id} is used twice`);
    seen.add(q.id);
  }
}

/** What is wrong with a narration against the schema (ask-demo/narration.schema.json), one line each; empty when it meets it. */
export function validateNarration(doc: unknown, schema: object): string[] {
  const check = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  return check(doc) ? [] : (check.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
}

/**
 * Fill every question turn's reply again from the templates in `questions`,
 * matching turns by id and leaving everything else as it is (behold#1174).
 * The load turn is kept. Throws naming the turn whose template no longer fills.
 */
export function refillNarration<N extends { turns: Array<{ id: string; kind: string; columns: string[]; rows: Array<Record<string, unknown>>; reply: string }> }>(doc: N, questions: readonly Question[]): N {
  const byId = new Map(questions.map((q) => [q.id, q]));
  return {
    ...doc,
    turns: doc.turns.map((t) => {
      if (t.kind !== "question") return t;
      const q = byId.get(t.id);
      if (!q) throw new Error(`turn ${t.id} has no question in scripts/ask-demo/questions.ts`);
      try {
        return { ...t, reply: questionReply(q.reply, t) };
      } catch (e) {
        if (e instanceof ReplyError) throw new Error(`turn ${t.id}: the reply cannot be filled: ${e.message}`);
        throw e;
      }
    }),
  };
}
