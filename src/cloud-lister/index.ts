/**
 * behold#1029: the read-only cloud lister `behold index` (#1026) calls.
 *
 * One call lists one substrate and one account, subscription, project or
 * cluster (behold#1025 ruling Q6) and returns a {@link ListingResult}: the
 * design's listing-result source shape, which chant's `typeListing`
 * (chant#4521) types into an `IndexDocument`. It has no command of its own
 * (behold#1029's ruling), reads no project or configuration, and works in an
 * empty directory.
 *
 * Read-only by construction: no cloud SDK client is built. Every request is
 * a plain HTTP call through one {@link Transport}, which refuses anything
 * outside the read allowlist (src/cloud-lister/guard.ts) and, when the run
 * names an endpoint, anything not sent to that endpoint's origin. There is
 * no estate, no record store and no write call.
 */

import { sortResult, type ListerContext } from "./common.ts";
import { listAws, type AwsTarget } from "./aws.ts";
import { listAzure, type AzureTarget } from "./azure.ts";
import { listGcp, type GcpTarget } from "./gcp.ts";
import { listKubernetes, type KubernetesTarget } from "./kubernetes.ts";
import { sdkCredentialChains, type CredentialChains } from "./credentials.ts";
import { Transport, type Fetcher, type TlsOptions, type TransportOptions } from "./transport.ts";
import type { CloudScope, ListingResult } from "./types.ts";

export type { CloudScope, ListingResult, ListedResource, CoverageEntry, IndexNote, CloudId, ListedFacts, MarkerFact, Substrate, TagFilter } from "./types.ts";
export type { AwsTarget } from "./aws.ts";
export type { AzureTarget } from "./azure.ts";
export type { GcpTarget } from "./gcp.ts";
export type { KubernetesTarget } from "./kubernetes.ts";
export { kubeTargetFromKubeconfig } from "./kubernetes.ts";
export { ListerConfigError } from "./credentials.ts";
export { MutatingCallRefused, READ_OPERATIONS } from "./guard.ts";
export { OriginRefused } from "./transport.ts";
export { listedNodeId, parseListedNodeId } from "./ids.ts";

/** Where and how to reach the scope's substrate. The variant must match `scope.substrate`. */
export type SubstrateTarget =
  | { substrate: "aws"; aws: AwsTarget }
  | { substrate: "azure"; azure: AzureTarget }
  | { substrate: "gcp"; gcp: GcpTarget }
  | { substrate: "kubernetes"; kubernetes: KubernetesTarget };

export interface ListOptions {
  /** Replaces the network (tests). */
  fetcher?: Fetcher;
  /** Replaces the real-cloud SDK credential chains (tests prove none is touched with an endpoint). */
  chains?: CredentialChains;
  now?: () => Date;
  /** Throttle backoff, in ms; tests pass `[]`. */
  retryDelays?: readonly number[];
  /** behold's version, for `source.version`. */
  version?: string;
  /** Sees every call that passed the guard (tests record with it). */
  onSend?: TransportOptions["onSend"];
}

function sortedUnique(values: readonly string[] | "*"): readonly string[] | "*" {
  if (values === "*") return "*";
  return [...new Set(values)].sort();
}

/** The scope as the stamp records it: lists sorted and deduplicated (#1025 "Stamp"). */
export function canonicalScope(scope: CloudScope): CloudScope {
  return {
    substrate: scope.substrate,
    scopeId: scope.scopeId,
    locations: sortedUnique(scope.locations),
    types: sortedUnique(scope.types),
    ...(scope.tagFilter && Object.keys(scope.tagFilter).length > 0
      ? { tagFilter: Object.fromEntries(Object.entries(scope.tagFilter).sort(([a], [b]) => (a < b ? -1 : 1))) }
      : {}),
  };
}

function endpointAndTls(target: SubstrateTarget): { endpoint?: string; tls?: TlsOptions } {
  switch (target.substrate) {
    case "aws":
      return { endpoint: target.aws.endpoint, tls: target.aws.tls };
    case "azure":
      return { endpoint: target.azure.endpoint, tls: target.azure.tls };
    case "gcp":
      return { endpoint: target.gcp.endpoint, tls: target.gcp.tls };
    case "kubernetes":
      return { endpoint: target.kubernetes.server, tls: target.kubernetes.tls };
  }
}

export async function listCloud(scope: CloudScope, target: SubstrateTarget, options: ListOptions = {}): Promise<ListingResult> {
  if (scope.substrate !== target.substrate) {
    throw new Error(`scope is ${scope.substrate} but the target is ${target.substrate}`);
  }
  const canonical = canonicalScope(scope);
  const now = options.now ?? (() => new Date());
  const { endpoint, tls } = endpointAndTls(target);
  const transport = new Transport({
    fetcher: options.fetcher,
    tls,
    ...(endpoint !== undefined ? { pinnedOrigin: endpoint } : {}),
    ...(options.onSend ? { onSend: options.onSend } : {}),
  });
  const chains = options.chains ?? sdkCredentialChains;
  const ctx: ListerContext = { scope: canonical, transport, now, resources: [], coverage: [], notes: [] };
  const startedAt = now().toISOString();
  switch (target.substrate) {
    case "aws":
      await listAws(ctx, target.aws, chains, options.retryDelays);
      break;
    case "azure":
      await listAzure(ctx, target.azure, chains, options.retryDelays);
      break;
    case "gcp":
      await listGcp(ctx, target.gcp, chains, options.retryDelays);
      break;
    case "kubernetes":
      await listKubernetes(ctx, target.kubernetes, options.retryDelays);
      break;
  }
  sortResult(ctx);
  return {
    listing: "v1",
    source: { name: "behold-lister", version: options.version ?? "unknown" },
    scope: canonical,
    startedAt,
    completedAt: now().toISOString(),
    resources: ctx.resources,
    coverage: ctx.coverage,
    notes: ctx.notes,
  };
}
