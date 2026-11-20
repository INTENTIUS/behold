/**
 * A Pulumi member's card (behold#1227): its icon by provider token and the
 * rows it shows, as the presentation pack in src/render.ts registers them for
 * the `pulumi` lexicon.
 *
 * A node's kind is the Pulumi type token chant reads from the stack export,
 * `<package>:<module>[/<sub>]:<Type>` (`aws:ec2/vpc:Vpc`,
 * `kubernetes:apps/v1:Deployment`, `azure-native:app:ContainerApp`). The
 * icon is the one the same resource wears in a Terraform root: the token is
 * spelt as the provider's Terraform type names spell it, and the first
 * spelling src/cloud-icons.ts has an icon for wins. A Kubernetes resource
 * takes the Kubernetes icon for its kind word. A token none of them knows
 * keeps pinhole's keyword glyph.
 *
 * The rows: what the preview says the next update does (the plan rows a
 * Terraform card shows, from `attrs._plan`), chant's ownership word from an
 * engine's facts, the stack a StackReference reads, and the stack a stack
 * node stands for. No Node imports: src/render.ts bundles this for a browser.
 */
import type { PackGlyph } from "./icon-packs.ts";
import { terraformIconFor } from "./cloud-icons.ts";
import { engineOwnershipRows } from "./engine-ownership.ts";
import { k8sIconFor } from "./icon-packs.ts";
import { planCardRows } from "./terraform-lens.ts";

/** The lexicon every node of a Pulumi member carries. */
export const PULUMI_LEXICON = "pulumi";

/** A type token split into its package, module and type, or undefined for a string that is not one. */
export function parsePulumiToken(kind: string): { pkg: string; module: string; type: string } | undefined {
  const m = /^([A-Za-z0-9-]+):([A-Za-z0-9/._-]*):([A-Za-z0-9]+)$/.exec(kind);
  return m ? { pkg: m[1]!, module: m[2]!, type: m[3]! } : undefined;
}

/** `RolePolicyAttachment` -> `role_policy_attachment`, `BucketV2` -> `bucket_v2`. */
const snake = (s: string): string =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();

/** The Terraform resource-type prefix each provider package spells its types with. */
const TERRAFORM_PREFIX: Record<string, string> = { aws: "aws", gcp: "google", azure: "azurerm", "azure-native": "azurerm" };

/** The Terraform type names a token may be spelt as, most specific first. */
export function terraformSpellings(kind: string): string[] {
  const t = parsePulumiToken(kind);
  const prefix = t ? TERRAFORM_PREFIX[t.pkg] : undefined;
  if (!t || !prefix) return [];
  const module = snake(t.module.split("/")[0] ?? "");
  const type = snake(t.type);
  return [...new Set([module && `${prefix}_${module}_${type}`, `${prefix}_${type}`, module && `${prefix}_${module}`].filter(Boolean))];
}

/** The icon for a Pulumi type token, or undefined to fall through to pinhole's glyph. */
export function pulumiIconFor(kind: string): PackGlyph | undefined {
  const t = parsePulumiToken(kind);
  if (!t) return undefined;
  if (t.pkg === "kubernetes") return k8sIconFor(t.type);
  for (const name of terraformSpellings(kind)) {
    const icon = terraformIconFor(name);
    if (icon) return icon;
  }
  return undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The rows a Pulumi card shows, or undefined for pinhole's default when there are none. */
export function pulumiCardFields(node: { kind: string; attrs: Record<string, unknown> }): Array<{ label: string; value: string }> | undefined {
  const a = node.attrs ?? {};
  const rows = [...planCardRows(a._plan), ...engineOwnershipRows(node)];
  if (node.kind === "pulumi:pulumi:StackReference" && str(a.name)) rows.push({ label: "reads", value: a.name as string });
  if (node.kind === "pulumi:pulumi:Stack") {
    if (a.external === true && str(a.stack)) rows.push({ label: "external stack", value: a.stack as string });
    else if (str(a.stack)) rows.push({ label: "stack", value: a.stack as string });
  }
  return rows.length ? rows : undefined;
}
