/**
 * behold#1031: which layout the graph pane builds its LadybugDB with, and the
 * drift check between behold's vendored copy of chant's graph schema, the
 * layout generated from it, and the schema the installed chant ships.
 *
 * Build time: src/graph-db/chant-schema/graph.schema.json is a byte copy of
 * chant's packages/core/src/graph-schema/graph.schema.json (chant#4527) at
 * the commit src/graph-db/chant-schema/source.json names, with its sha256.
 * `npm run build` runs ./generate-layout.ts, which writes
 * ./layout.generated.ts from it.
 *
 * Run time: chant ships the schema in its package (`files` holds src/), not
 * as an export, so it is found as a file under the installed chant's package
 * directory. When it is there and differs from the vendored copy, the pane
 * lays it out and builds with that, falling back to the vendored layout with
 * a note when it cannot. The published chant behold builds against
 * (src/chant-release.ts) has no schema, and the vendored layout is used.
 *
 * The drift check (`npm run check:graph-layout`, and ./layout.test.ts) fails
 * when the vendored schema's bytes are not the recorded sha256, when a
 * fixture copied from chant is not the recorded one, when
 * ./layout.generated.ts is not what the generator writes for the vendored
 * schema, or when a chant it can find (the installed one, or a checkout
 * named with `--chant` / `$CHANT_DIR`) ships a schema other than the
 * vendored copy. Without such a chant that last check is skipped and says so.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { EdgeGrain, EngineCloudId, EngineFacts, EngineMarkers } from "./types.ts";
import type { CloudIdRow, KnownAsRow, RefRow, ResourceRow } from "./rows.ts";
import { generateLayout, layoutDiff, renderLayout, sha256, type GraphLayout, type SchemaSource } from "./layout-gen.ts";
import { GRAPH_LAYOUT } from "./layout.generated.ts";

export const VENDORED_LAYOUT: GraphLayout = GRAPH_LAYOUT;

/** Where chant keeps the schema: in its package, and in a chant checkout. */
export const CHANT_SCHEMA_PATHS = ["src/graph-schema/graph.schema.json", "packages/core/src/graph-schema/graph.schema.json"] as const;
/** Where chant keeps the fixtures beside it. */
const CHANT_FIXTURE_DIRS = ["src/graph-schema/fixtures", "packages/core/src/graph-schema/fixtures"] as const;

/** The installed `@intentius/chant` package directory, if one resolves from here. */
export function installedChantDir(from: string = import.meta.url): string | undefined {
  let entry: string;
  try {
    entry = createRequire(from).resolve("@intentius/chant");
  } catch {
    return undefined;
  }
  for (let d = dirname(entry); d !== dirname(d); d = dirname(d)) {
    const pkg = join(d, "package.json");
    if (!existsSync(pkg)) continue;
    try {
      if ((JSON.parse(readFileSync(pkg, "utf8")) as { name?: unknown }).name === "@intentius/chant") return d;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The graph schema under a chant package directory or checkout, if it ships one. */
export function chantSchemaPath(chantDir: string): string | undefined {
  return CHANT_SCHEMA_PATHS.map((p) => join(chantDir, p)).find((p) => existsSync(p));
}

function chantVersion(chantDir: string): string | undefined {
  for (const p of [join(chantDir, "package.json"), join(chantDir, "packages", "core", "package.json")]) {
    try {
      const v = (JSON.parse(readFileSync(p, "utf8")) as { name?: unknown; version?: unknown });
      if (v.name === "@intentius/chant" && typeof v.version === "string") return v.version;
    } catch {
      // not this one
    }
  }
  return undefined;
}

export interface ActiveLayout {
  layout: GraphLayout;
  /** `vendored`: behold's copy; `chant`: the installed chant's schema, laid out at run time. */
  from: "vendored" | "chant";
  /** The schema file laid out, when it is chant's. */
  path?: string;
  chantVersion?: string;
  /** What a reader of the pane should know: the installed schema differs, or could not be laid out. */
  notes: string[];
}

/**
 * The layout a session builds with. `chantDir: null` skips looking for chant
 * (tests); absent, the installed chant is looked for.
 */
export function activeLayout(o: { chantDir?: string | null } = {}): ActiveLayout {
  const dir = o.chantDir === null ? undefined : (o.chantDir ?? installedChantDir());
  const path = dir ? chantSchemaPath(dir) : undefined;
  if (!dir || !path) return { layout: VENDORED_LAYOUT, from: "vendored", notes: [] };
  const version = chantVersion(dir);
  const shown = `chant${version ? ` ${version}` : ""}'s graph schema (${path})`;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { layout: VENDORED_LAYOUT, from: "vendored", notes: [`${shown} could not be read (${(e as Error).message}); the graph uses behold's vendored layout (chant ${VENDORED_LAYOUT.source.commit.slice(0, 12)})`] };
  }
  const digest = sha256(text);
  if (digest === VENDORED_LAYOUT.source.sha256) return { layout: VENDORED_LAYOUT, from: "vendored", path, ...(version ? { chantVersion: version } : {}), notes: [] };
  try {
    const layout = generateLayout(JSON.parse(text), { repo: "INTENTIUS/chant", path, ref: version ? `v${version}` : "installed", commit: version ?? "installed", sha256: digest });
    const diff = layoutDiff(VENDORED_LAYOUT, layout);
    return {
      layout,
      from: "chant",
      path,
      ...(version ? { chantVersion: version } : {}),
      notes: diff.length ? [`the graph follows ${shown}, which lays out differently from behold's vendored copy: ${diff.join("; ")}`] : [],
    };
  } catch (e) {
    return {
      layout: VENDORED_LAYOUT,
      from: "vendored",
      path,
      ...(version ? { chantVersion: version } : {}),
      notes: [`${shown} could not be laid out (${(e as Error).message}); the graph uses behold's vendored layout (chant ${VENDORED_LAYOUT.source.commit.slice(0, 12)})`],
    };
  }
}

/** src/graph-db/chant-schema/source.json. */
export interface VendoredSource extends SchemaSource {
  /** sha256 of each fixture in ./__fixtures__ copied from chant's graph-schema/fixtures. */
  fixtures: Record<string, string>;
}

export const GRAPH_DB_DIR = import.meta.dirname;
export const VENDORED_SCHEMA = (dir: string = GRAPH_DB_DIR): string => join(dir, "chant-schema", "graph.schema.json");
export const VENDORED_SOURCE = (dir: string = GRAPH_DB_DIR): string => join(dir, "chant-schema", "source.json");
export const GENERATED_LAYOUT = (dir: string = GRAPH_DB_DIR): string => join(dir, "layout.generated.ts");

export function readVendoredSource(dir: string = GRAPH_DB_DIR): VendoredSource {
  return JSON.parse(readFileSync(VENDORED_SOURCE(dir), "utf8")) as VendoredSource;
}

/** The layout source.json records for the vendored schema (without the fixture list). */
export function layoutSource(src: VendoredSource): SchemaSource {
  return { repo: src.repo, path: src.path, ref: src.ref, commit: src.commit, sha256: src.sha256 };
}

/** The generated file's text for the vendored schema under `dir`. */
export function renderVendored(dir: string = GRAPH_DB_DIR): string {
  const src = readVendoredSource(dir);
  return renderLayout(generateLayout(JSON.parse(readFileSync(VENDORED_SCHEMA(dir), "utf8")), layoutSource(src)));
}

export interface DriftReport {
  problems: string[];
  /** Checks that could not run, and why. */
  skipped: string[];
  /** The chant compared against, when one was found. */
  chant?: { dir: string; schema: string };
}

/**
 * The drift check. `dir` is the graph-db directory (tests hand in a copy);
 * `chantDir` a chant package directory or checkout to compare with, `null`
 * for none, absent for the installed chant.
 */
export function checkDrift(o: { dir?: string; chantDir?: string | null } = {}): DriftReport {
  const dir = o.dir ?? GRAPH_DB_DIR;
  const problems: string[] = [];
  const skipped: string[] = [];
  const src = readVendoredSource(dir);
  const schemaText = readFileSync(VENDORED_SCHEMA(dir), "utf8");
  const schemaSha = sha256(schemaText);
  if (schemaSha !== src.sha256) {
    problems.push(`chant-schema/graph.schema.json is not the copy source.json records (sha256 ${schemaSha}, recorded ${src.sha256}): it was edited by hand; re-copy it with \`npm run generate:graph-layout -- --sync <chant dir>\``);
  }
  for (const [name, want] of Object.entries(src.fixtures ?? {})) {
    const p = join(dir, "__fixtures__", name);
    const got = existsSync(p) ? sha256(readFileSync(p)) : "missing";
    if (got !== want) problems.push(`__fixtures__/${name} is not chant's fixture source.json records (sha256 ${got}, recorded ${want})`);
  }
  let expected: string | undefined;
  try {
    expected = renderLayout(generateLayout(JSON.parse(schemaText), layoutSource(src)));
  } catch (e) {
    problems.push(`the vendored schema cannot be laid out: ${(e as Error).message}`);
  }
  if (expected !== undefined) {
    const got = existsSync(GENERATED_LAYOUT(dir)) ? readFileSync(GENERATED_LAYOUT(dir), "utf8") : "";
    if (got !== expected) problems.push("layout.generated.ts is not the layout of the vendored schema: run `npm run generate:graph-layout`");
  }
  const chantDir = o.chantDir === null ? undefined : (o.chantDir ?? installedChantDir());
  const chantSchema = chantDir ? chantSchemaPath(chantDir) : undefined;
  if (!chantDir || !chantSchema) {
    skipped.push(
      chantDir
        ? `the chant at ${chantDir} ships no graph schema (a chant before chant#4527's release); the vendored copy is checked against source.json only`
        : "no chant found to compare with; pass --chant <dir> or set CHANT_DIR",
    );
    return { problems, skipped };
  }
  const theirs = readFileSync(chantSchema, "utf8");
  if (sha256(theirs) !== schemaSha) {
    let detail = "";
    try {
      const diff = layoutDiff(
        generateLayout(JSON.parse(schemaText), layoutSource(src)),
        generateLayout(JSON.parse(theirs), { ...layoutSource(src), sha256: sha256(theirs) }),
      );
      detail = diff.length ? ` The layout changes: ${diff.join("; ")}.` : " The layout is the same (descriptions or order only).";
    } catch (e) {
      detail = ` Its schema cannot be laid out: ${(e as Error).message}.`;
    }
    problems.push(`chant's graph schema at ${chantSchema} is not behold's vendored copy (chant ${src.commit.slice(0, 12)}).${detail} Run \`npm run generate:graph-layout -- --sync ${chantDir}\``);
  }
  const fixtureDir = CHANT_FIXTURE_DIRS.map((p) => join(chantDir, p)).find((p) => existsSync(p));
  if (fixtureDir) {
    for (const name of Object.keys(src.fixtures ?? {})) {
      const theirsPath = join(fixtureDir, name);
      if (existsSync(theirsPath) && sha256(readFileSync(theirsPath)) !== src.fixtures[name]) problems.push(`chant's fixture ${theirsPath} is not behold's copy __fixtures__/${name}`);
    }
  }
  return { problems, skipped, chant: { dir: chantDir, schema: chantSchema } };
}

// The row types and chant's own types (re-exported by ./types.ts since
// behold#1005), checked against the vendored layout by the compiler:
// `tsc --noEmit` fails when the generated layout has a column a row type
// lacks (or the other way), or an enum chant's type spells differently from
// the vendored schema.
type Table<N extends string> = Extract<(typeof GRAPH_LAYOUT.tables)[number], { name: N }>;
type Column<N extends string> = Table<N>["columns"][number]["name"];
type Enum<K extends keyof typeof GRAPH_LAYOUT.enums> = (typeof GRAPH_LAYOUT.enums)[K][number];
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

export const LAYOUT_TYPE_CHECKS: {
  resourceRow: Same<Column<"Resource">, keyof ResourceRow>;
  cloudIdRow: Same<Column<"CloudId">, keyof CloudIdRow>;
  knownAsRow: Same<Table<"KNOWN_AS">["from"]["param"] | Table<"KNOWN_AS">["to"]["param"], keyof KnownAsRow>;
  refRow: Same<Column<"REF"> | Table<"REF">["from"]["param"] | Table<"REF">["to"]["param"], keyof RefRow>;
  refOrigin: Same<RefRow["origin"], Enum<"IREdge.origin">>;
  refRelation: Same<RefRow["relation"], Enum<"IREdge.relation">>;
  edgeGrain: Same<EdgeGrain, Enum<"EdgeGrain">>;
  cloudIdKind: Same<EngineCloudId["kind"], Enum<"EngineCloudId.kind">>;
  engineOwnership: Same<NonNullable<EngineFacts["ownership"]>, Enum<"EngineFacts.ownership">>;
  ownedBy: Same<NonNullable<EngineFacts["ownedBy"]>, Enum<"EngineFacts.ownedBy">>;
  markerEncoding: Same<EngineMarkers["encoding"], Enum<"EngineMarkers.encoding">>;
  markerSource: Same<EngineMarkers["source"], Enum<"EngineMarkers.source">>;
} = {
  resourceRow: true,
  cloudIdRow: true,
  knownAsRow: true,
  refRow: true,
  refOrigin: true,
  refRelation: true,
  edgeGrain: true,
  cloudIdKind: true,
  engineOwnership: true,
  ownedBy: true,
  markerEncoding: true,
  markerSource: true,
};
