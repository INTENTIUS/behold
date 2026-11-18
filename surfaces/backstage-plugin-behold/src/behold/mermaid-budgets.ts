/**
 * behold#1060: how much Mermaid each forge draws, in one table.
 *
 * The github row comes from the live check on a test repository (#1065). The
 * gitlab and forgejo rows come from the same check run on a local GitLab CE
 * 19.5.5 and a local Forgejo 17.0.1 (#1060, #1064). Updating a forge after
 * such a check is an edit to its row here and nothing else: the emitter
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
    confirmed: true,
    basis: "GitLab's renderer constants (render_sandboxed_mermaid.js), confirmed on a local GitLab CE 19.5.5: a block of 2,000 characters drew and 2,001 showed the Display button instead, 30 `&` chains drew and 31 did not, and 150 edges in 1,834 characters drew. A page total over 2,000 characters is refused, so one block is the whole budget. The comment figure is not measured",
  },
  github: {
    blockChars: 200_000,
    maxEdges: 500,
    commentChars: 262_144,
    confirmed: true,
    basis: "measured on INTENTIUS/behold-sandbox (#1065): a comment drew 500 edges and sources up to 260,000 characters, drew nothing at 501 edges, and accepted a body of 262,144 characters and refused 262,145, although the error text says 65,536",
  },
  forgejo: {
    blockChars: 49_999,
    maxEdges: 500,
    commentChars: 1_000_000,
    confirmed: true,
    basis: "measured on a local Forgejo 17.0.1 with default settings, in comments: 500 edges drew and 501 did not, a source of 49,999 characters drew and 50,000 did not (Gitea's MERMAID_MAX_SOURCE_CHARACTERS default of 50,000, which an administrator can change), and a comment body of 1,000,000 characters was accepted, so no ceiling was found",
  },
};

export const FORGES = Object.keys(FORGE_BUDGETS) as Forge[];

export const DEFAULT_FORGE: Forge = "github";

export function isForge(name: string): name is Forge {
  return Object.prototype.hasOwnProperty.call(FORGE_BUDGETS, name);
}
