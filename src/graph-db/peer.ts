/**
 * behold#1027: the optional peer `@ladybugdb/core` (LadybugDB, formerly Kuzu:
 * an embedded property-graph database queried in Cypher).
 *
 * It is a native addon, so it is an optional peer and never a dependency:
 * #906 found that native graph packages fail to install often enough that
 * behold must not depend on one. Without it the graph pane refuses with the
 * install line, and everything else works: `chant search`, `ask` with a
 * search query, resolve-from-resource, and the templates that expand to a
 * `chant search` path pattern (behold#1022 ruling Q4).
 *
 * The import is by a computed specifier, so neither tsc nor esbuild resolves
 * it at build time, and behold builds and bundles with the package absent.
 * It is looked for beside behold first, then where `npm i -g` puts it (the
 * install line), as the shot's peer is (src/shot.ts `globalNodeModules`):
 * node never looks there, and a behold run through npx would not find it.
 * The API used is the small part of `lbug.d.ts` (0.22.0) below, held
 * structurally.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { globalNodeModules } from "../shot.ts";

/** The package name, checked on npm (`npm view @ladybugdb/core`, 0.22.0 on 2026-10-26). */
export const LADYBUG_PACKAGE = "@ladybugdb/core";

/** The range package.json's peerDependencies names. */
export const LADYBUG_RANGE = ">=0.22.0";

/** The line a person runs to turn the pane on. */
export const LADYBUG_INSTALL = `npm i -g ${LADYBUG_PACKAGE}`;

export interface LbugQueryResult {
  getAll(): Promise<Record<string, unknown>[]>;
  getColumnNames(): Promise<string[]>;
  close(): void;
}

export interface LbugPreparedStatement {
  isSuccess(): boolean;
  isReadOnly(): boolean;
  getErrorMessage(): string;
}

export interface LbugConnection {
  init(): Promise<void>;
  query(statement: string): Promise<LbugQueryResult | LbugQueryResult[]>;
  prepare(statement: string): Promise<LbugPreparedStatement>;
  execute(statement: LbugPreparedStatement, params?: Record<string, unknown>): Promise<LbugQueryResult | LbugQueryResult[]>;
  setQueryTimeout(ms: number): void;
  close(): Promise<void>;
}

export interface LbugDatabase {
  init(): Promise<void>;
  close(): Promise<void>;
}

/** The module, as much of it as behold uses. */
export interface LbugModule {
  Database: new (path?: string, bufferManagerSize?: number, enableCompression?: boolean, readOnly?: boolean) => LbugDatabase;
  Connection: new (db: LbugDatabase, numThreads?: number) => LbugConnection;
  VERSION?: string;
}

/** What the pane answers when the peer is missing: the install line, and what still works. */
export interface PeerRefusal {
  error: string;
  code: "graph-peer-missing";
  remedy: string;
  install: string;
  stillWorks: string[];
  detail?: string;
}

export function peerRefusal(detail?: string): PeerRefusal {
  return {
    error: `The graph pane needs the optional peer ${LADYBUG_PACKAGE}, which is not installed beside behold.`,
    code: "graph-peer-missing",
    remedy: `Run \`${LADYBUG_INSTALL}\` (or install it beside behold), then reload. Nothing else in behold needs it.`,
    install: LADYBUG_INSTALL,
    stillWorks: ["chant search queries (ask with query, the q view key)", "resolving a resource by name, id, address or cloud id", "templates that expand to a chant search path pattern"],
    ...(detail ? { detail } : {}),
  };
}

/** How the module is imported. Tests hand in their own. */
export type PeerImport = () => Promise<unknown>;

const specifier = (): string => [LADYBUG_PACKAGE][0]!;

/** Beside behold, then each global root. A package found nowhere throws ERR_MODULE_NOT_FOUND, as an import would. */
export const importLadybug: PeerImport = async () => {
  try {
    return await import(/* @vite-ignore */ specifier());
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") throw e;
    for (const g of globalNodeModules()) {
      const dir = join(g, ...LADYBUG_PACKAGE.split("/"));
      if (existsSync(join(dir, "package.json"))) return createRequire(join(g, "noop.js"))(dir) as unknown;
    }
    throw e;
  }
};

function looksLikeModule(m: unknown): m is LbugModule {
  const o = m as { Database?: unknown; Connection?: unknown } | undefined;
  return typeof o?.Database === "function" && typeof o?.Connection === "function";
}

/** The peer, or the refusal. Never throws. */
export async function loadLadybug(imp: PeerImport = importLadybug): Promise<{ ok: true; lbug: LbugModule } | { ok: false; refusal: PeerRefusal }> {
  let m: unknown;
  try {
    m = await imp();
  } catch (e) {
    const code = (e as { code?: string }).code;
    const missing = code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
    // A package that is there but whose native addon failed to load is #906's install-reliability case: same refusal, with what it said.
    return { ok: false, refusal: peerRefusal(missing ? undefined : `${LADYBUG_PACKAGE} is installed but did not load: ${(e as Error).message}`) };
  }
  const mod = looksLikeModule(m) ? m : looksLikeModule((m as { default?: unknown })?.default) ? ((m as { default: LbugModule }).default) : undefined;
  if (!mod) return { ok: false, refusal: peerRefusal(`${LADYBUG_PACKAGE} loaded, but has no Database and Connection`) };
  return { ok: true, lbug: mod };
}
