/**
 * behold#1060: how much Mermaid each forge draws, in one table.
 *
 * The github row comes from the live check on a test repository (#1065). The
 * gitlab and forgejo rows are provisional until the same check is run there. Updating a forge
 * after that check is an edit to its row here and nothing else: the emitter
 * (src/graph-mermaid.ts), `behold graph --mermaid --forge` and the action
 * (#1062) all read this table. Set `confirmed` to true when a row comes from
 * the check.
 *
 * Imports nothing, so a browser host can load it.
 */

export type Forge = "gitlab" | "github" | "forgejo";

export interface ForgeBudget {
  /** Characters in one Mermaid block, the source between the fence lines. */
  blockChars: number;
  /** Edges in one block, when the forge sets a limit (or Mermaid's own default is the lowest known figure). */
  maxEdges?: number;
  /** `&` link chains in one block. The emitter writes one edge per line and never uses `&`, so this is checked, not spent. */
  maxChains?: number;
  /** Blocks on one page, a comment or a note. The emitter writes one. */
  maxBlocks?: number;
  /** Characters in a whole comment: the marker, the count line, the fence and the diagram. */
  commentChars: number;
  /** True once the live check has confirmed the row. */
  confirmed: boolean;
  /** Where the figures come from. */
  basis: string;
}

export const FORGE_BUDGETS: Readonly<Record<Forge, ForgeBudget>> = {
  gitlab: {
    blockChars: 2_000,
    maxChains: 30,
    maxBlocks: 50,
    commentChars: 60_000,
    confirmed: false,
    basis: "GitLab's renderer constants (render_sandboxed_mermaid.js); a page total over 2,000 characters is refused, so one block is the whole budget",
  },
  github: {
    blockChars: 200_000,
    maxEdges: 500,
    commentChars: 262_144,
    confirmed: true,
    basis: "measured on INTENTIUS/behold-sandbox (#1065): a comment drew 500 edges and sources up to 260,000 characters, drew nothing at 501 edges, and accepted a body of 262,144 characters and refused 262,145, although the error text says 65,536",
  },
  forgejo: {
    blockChars: 20_000,
    maxEdges: 250,
    commentChars: 60_000,
    confirmed: false,
    basis: "under Gitea's MERMAID_MAX_SOURCE_CHARACTERS default of 50,000; Forgejo's default is unknown",
  },
};

export const FORGES = Object.keys(FORGE_BUDGETS) as Forge[];

export const DEFAULT_FORGE: Forge = "github";

export function isForge(name: string): name is Forge {
  return Object.prototype.hasOwnProperty.call(FORGE_BUDGETS, name);
}
