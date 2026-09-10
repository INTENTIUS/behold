/**
 * Intra-estate edges for a choudoufu member (#393, "Missing" item 1).
 *
 * `choudoufu live-check -json` states two things: the roster (every declared
 * instance, by address) and `references[]` — data sources filtered on ANOTHER
 * estate's marker tags. That second list is a cross-estate list by
 * construction, so a 301-resource terralith of roles, policies, attachments
 * and their profiles produced not one edge, `edgelessNote` asserted "nothing
 * in this estate references anything else", and the audit measured a 455:1
 * strip because dagre had nothing to rank by.
 *
 * The references are not missing; nobody was reading them. chant's terraform
 * lexicon reads the same HCL the estate already has and, at 0.61 (chant#2265),
 * resolves a block's `"${…}"` interpolations into edges. So a choudoufu
 * member's source read now runs the terraform kind's read over its own
 * directory as well and JOINS the two documents by address. behold still
 * parses no HCL: the join is two lists of strings.
 *
 * ---------------------------------------------------------------------------
 * THE TWO DOCUMENTS DO NOT NAME THE SAME THINGS, and the whole of this module
 * is that mismatch.
 *
 * The lexicon names BLOCKS, in a path of module CALLS:
 *
 *     estate/aws_iam_role.count_team
 *     estate/module.team_pod/aws_iam_role.pod_role
 *     estate/module.team_pod                      (the call itself)
 *
 * choudoufu names INSTANCES, in a path of module INSTANCES:
 *
 *     aws_iam_role.count_team[0] … [7]
 *     module.team_pod["pod-a"].aws_iam_role.pod_role[0] … [3]
 *     module.team_pod["pod-b"].aws_iam_role.pod_role[0] … [3]
 *
 * So one lexicon node is 0, 1 or many roster cards, and one lexicon edge is
 * that product. Three rules turn it into edges a person can read, in
 * decreasing order of how much Terraform itself guarantees them:
 *
 * 1. **Same module instance, always.** A reference written inside
 *    `modules/team_pod/main.tf` resolves inside the instance that is
 *    evaluating it — `module.team_pod["pod-a"]`'s attachment names
 *    `pod-a`'s role and cannot name `pod-b`'s. That is Terraform's scoping
 *    rule, not an inference, and it is what keeps the two pods two clusters
 *    instead of one 8x8 mesh.
 * 2. **Key to key when both ends expand over the same keys.** Two blocks in
 *    one scope, expanded over `[0…3]` or over `["a","b"]`, are joined by that
 *    key. The lexicon states the reference between the BLOCKS and drops the
 *    index expression, so this is the one rule here that Terraform does not
 *    hand us: `role = aws_iam_role.count_team[count.index].name` and
 *    `role = aws_iam_role.count_team[0].name` reach this module identically.
 *    It is taken because the alternative is measurably worse on both counts —
 *    on `terralith-4` the full product is 666 edges of which ~400 say a role
 *    is attached to a policy it is not, against 266 that are each true — and
 *    because every edge here is `inferred`, which is the flag the pane and
 *    the overlay already read as "behold joined this, chant did not state it".
 *    Where the key sets differ (a `for_each` over one set referencing a
 *    `count` over another) there is no correspondence to take, and the scope's
 *    full product is drawn instead.
 * 3. **A module CALL is its whole interior.** An edge whose end is
 *    `module.team_pod` is a reference to one of the module's outputs, and an
 *    output is produced by the resources inside it — so the edge lands on
 *    every roster address under that call, in every instance of it. Lexicon
 *    0.61 descends into called modules, so this is rare rather than the common
 *    case #393 expected: on `terralith-4` the module call's only two edges go
 *    to `locals`, and rule 4 drops them.
 * 4. **An end with no roster card is dropped, whole.** `var.pod_size`,
 *    `locals~2`, a provider block, a `data` source the roster does not
 *    declare: real HCL, not estate, and choudoufu draws no card for any of
 *    them. 17 of `terralith-4`'s 175 lexicon edges go this way.
 *
 * `viaAttr` is the lexicon's own — `role`, `policy_arn`, `task_definition` —
 * so the inspect pane says which attribute made the reference rather than
 * "ref".
 * ---------------------------------------------------------------------------
 *
 * WHERE THIS RUNS. Inside the member's `read` (src/choudoufu-live.ts), on the
 * member's OWN ids — plain addresses, before `composeStacks` prefixes them
 * with the member name — so the estate passes downstream see a member that
 * simply has edges, and `addChoudoufuReferenceEdges`' cross-estate join is
 * untouched. The overlay paints the same node ids it always did.
 *
 * WHEN THE LEXICON IS ABSENT there are no edges and {@link choudoufuLexiconNote}
 * is the line that says so, carrying the terraform kind's own install remedy
 * so the two cannot drift. Saying nothing would leave the old sentence
 * standing, and "nothing in this estate references anything else" is a claim
 * behold has no reader to make.
 */
import type { GraphIR, IREdge } from "@intentius/chant";
import type { GraphOptions } from "./chant.ts";
import {
  TERRAFORM_LEXICON_PKG,
  terraformReaderState,
  writeTerraformScratchProject,
  type TerraformReaderState,
} from "./terraform-member.ts";

/**
 * The single root the generated reader config names for a choudoufu estate:
 * the estate directory itself, reached through the scratch project's `estate`
 * symlink. Fixed rather than derived from the directory's basename, because it
 * is only ever a prefix this module strips straight back off, and a constant
 * cannot collide with the `/` a module path uses as its separator.
 */
export const LEXICON_ROOT = "estate";

/** One declared instance, decomposed. */
export interface RosterInstance {
  /** The roster's own address, verbatim — the node id in the member's IR. */
  address: string;
  /** The chain of module INSTANCES it sits in, keys included, or `""` for the
   * root module: `module.team_pod["pod-a"]`. Two ends of an edge must agree on
   * this (rule 1). */
  scope: string;
  /** Its own expansion key with the brackets, or `""` when the block is not
   * expanded: `[0]`, `["host-0007"]`. */
  key: string;
}

/** The roster, indexed the way a lexicon id addresses it. */
export interface RosterIndex {
  /** The lexicon's path for a block (`module.team_pod/aws_iam_role.pod_role`)
   * → every instance of it, in roster order. */
  blocks: Map<string, RosterInstance[]>;
  /** A module CALL path (`module.team_pod`) → every instance under it, keyed
   * by the scope the CALL is written in (rule 3). */
  calls: Map<string, RosterInstance[]>;
}

/** A module instance at the head of an address: the call, its key, and the
 * dot that ends it. */
const MODULE_SEGMENT = /^module\.([A-Za-z0-9_-]+)(\[[^\]]*\])?\./;
/** A trailing expansion key. A block name cannot hold a bracket, so this is
 * unambiguous without a parse. */
const TRAILING_KEY = /(\[[^\]]*\])$/;

/** One roster address, decomposed into the lexicon's path for its block, the
 * module instances it sits in, and its own expansion key. */
export function decomposeAddress(address: string): RosterInstance & { blockPath: string } {
  let rest = address;
  const calls: string[] = [];
  const instances: string[] = [];
  for (;;) {
    const m = MODULE_SEGMENT.exec(rest);
    if (!m) break;
    calls.push(`module.${m[1]}`);
    instances.push(`module.${m[1]}${m[2] ?? ""}`);
    rest = rest.slice(m[0].length);
  }
  const k = TRAILING_KEY.exec(rest);
  return {
    address,
    scope: instances.join("."),
    key: k ? k[1] : "",
    blockPath: [...calls, k ? rest.slice(0, -k[1].length) : rest].join("/"),
  };
}

/** The scope a module call is WRITTEN in — its parent — given the instance
 * chain of something inside it. `module.a["x"].module.b[0]` under call path
 * `module.a/module.b` is written in `module.a["x"]`. */
function scopeAbove(scope: string, depth: number): string {
  return scope ? scope.split(".").slice(0, depth).join(".") : "";
}

/** Index a roster (the addresses `liveCheckToIr` made nodes of) for the join. */
export function indexRoster(addresses: readonly string[]): RosterIndex {
  const blocks = new Map<string, RosterInstance[]>();
  const calls = new Map<string, RosterInstance[]>();
  for (const address of addresses) {
    const { blockPath, ...instance } = decomposeAddress(address);
    const at = blocks.get(blockPath);
    if (at) at.push(instance);
    else blocks.set(blockPath, [instance]);
    // Every module call this address sits under, so an edge that lands on the
    // call lands on the whole interior (rule 3). The scope recorded is the
    // one the CALL is written in, not the one the card sits in.
    const segments = blockPath.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const callPath = segments.slice(0, depth).join("/");
      const written = { address, scope: scopeAbove(instance.scope, depth - 1), key: "" };
      const list = calls.get(callPath);
      if (list) list.push(written);
      else calls.set(callPath, [written]);
    }
  }
  return { blocks, calls };
}

/** Is this lexicon path a module CALL rather than a block inside one? */
function isModuleCall(path: string): boolean {
  return path.slice(path.lastIndexOf("/") + 1).startsWith("module.");
}

/** The roster cards one end of a lexicon edge means, grouped by the scope the
 * reference is written in. Empty for an end the roster does not declare —
 * a variable, a locals block, a provider, a data source nobody declared
 * (rule 4). */
function endOf(path: string, index: RosterIndex): Map<string, RosterInstance[]> {
  const found = index.blocks.get(path) ?? (isModuleCall(path) ? index.calls.get(path) : undefined);
  const byScope = new Map<string, RosterInstance[]>();
  for (const i of found ?? []) {
    const at = byScope.get(i.scope);
    if (at) at.push(i);
    else byScope.set(i.scope, [i]);
  }
  return byScope;
}

/** Do these two expansions carry the same set of keys, one card each (rule 2)? */
function sameKeys(from: readonly RosterInstance[], to: readonly RosterInstance[]): boolean {
  if (from.length < 2 || from.length !== to.length) return false;
  const keys = new Set(from.map((i) => i.key));
  if (keys.size !== from.length || keys.has("")) return false;
  return to.every((i) => keys.has(i.key)) && new Set(to.map((i) => i.key)).size === to.length;
}

/** The lexicon's id with its single root stripped: `estate/module.a/x.y` →
 * `module.a/x.y`. An id that is not under the root (nothing this reader
 * produces) is returned whole and simply matches no roster block. */
export function lexiconPath(id: string, root = LEXICON_ROOT): string {
  return id.startsWith(`${root}/`) ? id.slice(root.length + 1) : id;
}

/**
 * The join: lexicon edges over the lexicon's block ids, as edges over the
 * roster's instance addresses. Pure — the whole of rules 1 to 4 — so it is
 * tested off a recorded lexicon IR and a recorded live-check document with no
 * HCL parser present.
 *
 * Every edge is `inferred`, the flag behold already uses for a relationship it
 * joined rather than one its reader stated, and carries the lexicon's own
 * `viaAttr`. Self-edges (a block that references itself, which an expanded one
 * legitimately can) and duplicates are dropped.
 */
export function joinLexiconEdges(edges: readonly IREdge[], index: RosterIndex, root = LEXICON_ROOT): IREdge[] {
  const out: IREdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, viaAttr: string | undefined): void => {
    if (from === to) return;
    const key = `${from}\0${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ from, to, kind: "ref", ...(viaAttr ? { viaAttr } : {}), inferred: true } as IREdge);
  };
  for (const e of edges) {
    const fromPath = lexiconPath(e.from, root);
    const toPath = lexiconPath(e.to, root);
    const from = endOf(fromPath, index);
    const to = endOf(toPath, index);
    if (from.size === 0 || to.size === 0) continue; // rule 4
    for (const [scope, fromCards] of from) {
      const toCards = to.get(scope); // rule 1
      if (!toCards) continue;
      if (!isModuleCall(fromPath) && !isModuleCall(toPath) && sameKeys(fromCards, toCards)) {
        const byKey = new Map(toCards.map((i) => [i.key, i.address]));
        for (const f of fromCards) add(f.address, byKey.get(f.key)!, e.viaAttr); // rule 2
        continue;
      }
      for (const f of fromCards) for (const t of toCards) add(f.address, t.address, e.viaAttr); // rules 2 (fallback) and 3
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The read.
// ---------------------------------------------------------------------------

/** How the lexicon half is read, injectable so the join above is testable off
 * a recorded IR with no lexicon installed. */
export type LexiconRead = (dir: string, opts: GraphOptions) => Promise<GraphIR>;

/**
 * Read `dir` through the terraform kind's reader as ONE root — the estate
 * directory itself.
 *
 * Root DISCOVERY is deliberately not used: a choudoufu estate is a Terraform
 * root by definition (choudoufu applies it), and a walk would additionally
 * find `modules/team_pod` and refuse it, or find a nested root and box it
 * separately — neither of which the roster knows anything about. One root, one
 * id prefix ({@link LEXICON_ROOT}), and the scratch-project machinery
 * (src/terraform-member.ts) unchanged: the config, the `node_modules` symlink
 * and the `estate` symlink all land under the OS temp directory, and nothing
 * is written under the estate.
 */
export async function readEstateLexicon(dir: string, opts: GraphOptions = {}): Promise<GraphIR> {
  const project = writeTerraformScratchProject(dir, { roots: [{ name: LEXICON_ROOT, dir: "." }], skipped: [] });
  // Detail 2 whatever the caller asked for: the join reads ids and `viaAttr`
  // and nothing else, so a detail-3 read would parse every block's body for an
  // answer that cannot change. Source only, for the reason `readTerraformMember`
  // gives — a reader lexicon has no live half.
  const { graphIr } = await import("./chant.ts");
  return graphIr(project, { detail: 2 });
}

/**
 * Add the intra-estate edges to a choudoufu member's IR, in place, and return
 * it. A no-op — the identical object, unchanged — when the lexicon is not
 * resolvable, when the estate holds no addresses, or when the read throws
 * (a directory the lexicon cannot parse is not a reason to refuse the roster
 * behold already has; the note says the reader is absent, and a reader that
 * broke says nothing louder than an empty edge set).
 */
export async function addIntraEstateEdges(
  ir: GraphIR,
  dir: string,
  state: TerraformReaderState = terraformReaderState(),
  read: LexiconRead = readEstateLexicon,
): Promise<GraphIR> {
  if (state.refusal || ir.nodes.length === 0) return ir;
  let lexicon: GraphIR;
  try {
    lexicon = await read(dir, {});
  } catch {
    return ir;
  }
  const index = indexRoster(ir.nodes.map((n) => n.id));
  const have = new Set(ir.edges.map((e) => `${e.from}\0${e.to}`));
  for (const e of joinLexiconEdges(lexicon.edges, index)) {
    if (have.has(`${e.from}\0${e.to}`)) continue;
    have.add(`${e.from}\0${e.to}`);
    ir.edges.push(e);
  }
  return ir;
}

// ---------------------------------------------------------------------------
// The note.
// ---------------------------------------------------------------------------

/**
 * What an edgeless choudoufu estate says when the reader that would have found
 * its references is not installed — in place of `edgelessNote`'s
 * "nothing in this estate references anything else", which behold has nothing
 * to base on here.
 *
 * The install line is the terraform kind's own refusal remedy, read from
 * behold's manifest through {@link terraformReaderState}, so the ranges quoted
 * here and the ones that reader refuses with cannot drift apart.
 */
export function choudoufuLexiconNote(state: TerraformReaderState = terraformReaderState()): string | undefined {
  if (!state.refusal) return undefined;
  return (
    "no edges — a choudoufu roster states only its cross-estate references; the ones inside the estate " +
    `need chant's terraform lexicon beside behold. ${state.refusal.remedy}`
  );
}

/** The version half of the member's cache stamp: an install of the lexicon has
 * to be a different key, or the estate keeps serving the edgeless IR it cached
 * before the install. Absent stamps as absent rather than throwing. */
export function lexiconStamp(state: TerraformReaderState = terraformReaderState()): string {
  return `${TERRAFORM_LEXICON_PKG}\0${state.lexicon.version ?? "absent"}\0${state.parser.version ?? "absent"}`;
}
