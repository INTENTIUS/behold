/**
 * behold#1202: the ask demo's one read of a real AWS account goes into the
 * repository with the account id replaced, and nothing the recording writes
 * may carry another account id.
 *
 * `redactIndexVersion` takes the index version `behold index aws` wrote of
 * the real account and replaces every occurrence of its id with
 * {@link REDACTED_ACCOUNT}. The id is part of the version's scope, so the
 * scope key, the content digest and the version name are computed again with
 * chant's own functions over the redacted document, and chant's
 * `validateIndexDocument` must accept the result. Nothing derived from the
 * real id survives, not even as a hash.
 *
 * `foreignAccountIds` finds AWS account ids in text that are neither floci's
 * account nor the placeholder; scripts/ask-demo/record.ts and
 * scripts/ask-demo/check.ts refuse when it finds one.
 */
import { indexDocumentDigest, indexScopeKey, indexVersionName, validateIndexDocument } from "@intentius/chant/lifecycle/index-document";
import type { IndexDocument } from "../../src/graph-db/types.ts";

/** What the real account's id becomes in every committed file. */
export const REDACTED_ACCOUNT = "123456789012";
/** The account floci answers as. */
export const EMULATOR_ACCOUNT = "000000000000";

const ACCOUNT_ID = /^\d{12}$/;

/** A redacted index version, and the name it is stored under in its scope directory. */
export interface RedactedVersion {
  doc: IndexDocument;
  version: string;
}

/** The index version with `account` replaced everywhere, its key, digest and name computed again. */
export function redactIndexVersion(doc: IndexDocument, account: string): RedactedVersion {
  if (!ACCOUNT_ID.test(account)) throw new Error(`"${account}" is not an AWS account id`);
  if (account === REDACTED_ACCOUNT || account === EMULATOR_ACCOUNT) throw new Error(`${account} is the placeholder or floci's account, not a real one`);
  if (doc.stamp.scope.kind !== "cloud" || (doc.stamp.scope as { scopeId?: string }).scopeId !== account) {
    throw new Error(`the index version is not of AWS account ${account}`);
  }
  const text = JSON.stringify(doc).split(account).join(REDACTED_ACCOUNT);
  const out = JSON.parse(text) as IndexDocument & { stamp: { digest: string } };
  out.stamp.scopeKey = indexScopeKey(out.stamp.scope as Parameters<typeof indexScopeKey>[0]);
  out.stamp.digest = indexDocumentDigest(out as unknown as Parameters<typeof indexDocumentDigest>[0]);
  validateIndexDocument(out as unknown as Parameters<typeof validateIndexDocument>[0]);
  const final = JSON.stringify(out);
  if (final.includes(account)) throw new Error("the account id is still in the redacted version");
  return { doc: out, version: indexVersionName(out.stamp.observedAt, out.stamp.digest) };
}

/** Where an AWS account id appears: an ARN's account field, an index key's or scope key's account segment. */
const ACCOUNT_CONTEXTS = [/arn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:(\d{12}):/g, /\baws\/(\d{12})\//g, /"(?:scopeId|[A-Za-z]*OwnerId|AccountId|account)"\s*:\s*"(\d{12})"/g, /--account[ =](\d{12})\b/g];

/** Every AWS account id in `text` other than floci's and the placeholder, once each. */
export function foreignAccountIds(text: string): string[] {
  const out = new Set<string>();
  for (const re of ACCOUNT_CONTEXTS) for (const m of text.matchAll(re)) if (m[1] !== EMULATOR_ACCOUNT && m[1] !== REDACTED_ACCOUNT) out.add(m[1]!);
  return [...out].sort();
}
