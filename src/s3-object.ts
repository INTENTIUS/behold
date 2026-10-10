/**
 * The little of S3 behold needs (#491): read one object, and write one, signed
 * with AWS Signature Version 4 from `node:crypto`. No SDK, no list call.
 *
 * Ported from terragucci's report store (INTENTIUS/terragucci,
 * packages/terragucci/src/report/s3.ts, Apache-2.0), so behold reads a
 * reports bucket with exactly the credentials terragucci's own jobs use:
 * static keys in `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (with
 * `AWS_SESSION_TOKEN`), or `AWS_ROLE_ARN` assumed with the job's OIDC token in
 * `AWS_WEB_IDENTITY_TOKEN_FILE`. `AWS_ENDPOINT_URL_S3`, then
 * `AWS_ENDPOINT_URL`, names an S3-compatible store, addressed path-style; AWS
 * itself is addressed virtual-hosted.
 *
 * A laptop usually holds none of these and signs in through a profile or SSO,
 * which only the aws CLI reads; src/terragucci-source.ts uses this client
 * only when the environment holds credentials, and the CLI otherwise.
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3WebIdentity {
  roleArn: string;
  tokenFile: string;
  sessionName: string;
  /** STS's address, https://host[:port], no path. */
  endpoint: string;
}

export interface S3Location {
  bucket: string;
  /** https://host[:port], no path. Default: AWS's regional endpoint. */
  endpoint?: string;
  region: string;
}

export type S3Target = S3Location & (S3Credentials | { webIdentity: S3WebIdentity });

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class S3Error extends Error {}

const encodeStrict = (v: string): string => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = (key: string): string => key.split("/").map(encodeStrict).join("/");
const xmlText = (xml: string, tag: string): string | undefined => {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m?.[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
};

/** Whether the environment holds credentials this client can sign with. */
export function hasEnvCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!((env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) || (env.AWS_ROLE_ARN && env.AWS_WEB_IDENTITY_TOKEN_FILE));
}

/** The target for `bucket` from the AWS environment variables. Throws when the environment holds no credentials. */
export function s3FromEnv(bucket: string, env: NodeJS.ProcessEnv = process.env): S3Target {
  const endpoint = env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL;
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";
  const where = { bucket, ...(endpoint ? { endpoint: endpoint.replace(/\/+$/, "") } : {}), region };
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) return { ...where, accessKeyId, secretAccessKey, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) };
  if (env.AWS_ROLE_ARN && env.AWS_WEB_IDENTITY_TOKEN_FILE) {
    return {
      ...where,
      webIdentity: {
        roleArn: env.AWS_ROLE_ARN,
        tokenFile: env.AWS_WEB_IDENTITY_TOKEN_FILE,
        sessionName: env.AWS_ROLE_SESSION_NAME || "behold",
        endpoint: (env.AWS_ENDPOINT_URL_STS || env.AWS_ENDPOINT_URL || `https://sts.${region}.amazonaws.com`).replace(/\/+$/, ""),
      },
    };
  }
  throw new S3Error("no AWS credentials in the environment: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE");
}

/** STS AssumeRoleWithWebIdentity. The request carries the token and is not signed. */
async function assumeRole(w: S3WebIdentity, fetchFn: Fetch): Promise<S3Credentials> {
  let token: string;
  try {
    token = readFileSync(w.tokenFile, "utf8").trim();
  } catch (e) {
    throw new S3Error(`cannot read the OIDC token in ${w.tokenFile}: ${(e as Error).message}`);
  }
  if (!token) throw new S3Error(`the OIDC token file ${w.tokenFile} is empty`);
  const body = new URLSearchParams({ Action: "AssumeRoleWithWebIdentity", Version: "2011-06-15", RoleArn: w.roleArn, RoleSessionName: w.sessionName, WebIdentityToken: token }).toString();
  const res = await fetchFn(`${w.endpoint}/`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8", accept: "application/xml" }, body });
  const xml = await res.text();
  if (!res.ok) throw new S3Error(`AssumeRoleWithWebIdentity for ${w.roleArn}: ${res.status} ${[xmlText(xml, "Code"), xmlText(xml, "Message")].filter(Boolean).join(": ") || xml.slice(0, 300)}`);
  const accessKeyId = xmlText(xml, "AccessKeyId");
  const secretAccessKey = xmlText(xml, "SecretAccessKey");
  const sessionToken = xmlText(xml, "SessionToken");
  if (!accessKeyId || !secretAccessKey || !sessionToken) throw new S3Error(`AssumeRoleWithWebIdentity for ${w.roleArn} answered without credentials`);
  return { accessKeyId, secretAccessKey, sessionToken };
}

const sha256 = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex");
const hmac = (key: string | Buffer, s: string): Buffer => createHmac("sha256", key).update(s).digest();

/** The address of `key`: path-style on a custom endpoint, virtual-hosted on AWS. */
export const objectUrl = (t: S3Location, key: string): string =>
  `${t.endpoint ? `${t.endpoint}/${t.bucket}` : `https://${t.bucket}.s3.${t.region}.amazonaws.com`}/${encodePath(key)}`;

/** Signature Version 4 headers for one request. */
export function sign(t: Pick<S3Location, "region"> & S3Credentials, method: string, rawUrl: string, extra: Record<string, string>, payload: string, now: Date): Record<string, string> {
  const url = new URL(rawUrl);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payload,
    "x-amz-date": amzDate,
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])),
    ...(t.sessionToken ? { "x-amz-security-token": t.sessionToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const query = [...url.searchParams].map(([k, v]) => `${encodeStrict(k)}=${encodeStrict(v)}`).sort().join("&");
  const canonical = [method, url.pathname, query, ...names.map((n) => `${n}:${headers[n]!.trim()}`), "", names.join(";"), payload].join("\n");
  const scope = `${day}/${t.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key4 = hmac(hmac(hmac(hmac(`AWS4${t.secretAccessKey}`, day), t.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key4).update(toSign).digest("hex");
  const { host: _host, ...sent } = headers;
  return { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${t.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

export class S3Object {
  private creds?: Promise<S3Credentials>;
  constructor(
    readonly target: S3Target,
    private readonly fetchFn: Fetch = fetch as unknown as Fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async signer(): Promise<S3Location & S3Credentials> {
    const t = this.target;
    if (!("webIdentity" in t)) return t;
    this.creds ??= assumeRole(t.webIdentity, this.fetchFn).catch((e: unknown) => {
      this.creds = undefined;
      throw e;
    });
    return { bucket: t.bucket, ...(t.endpoint ? { endpoint: t.endpoint } : {}), region: t.region, ...(await this.creds) };
  }

  /** The object's text, or undefined when there is none. */
  async get(key: string): Promise<string | undefined> {
    const t = await this.signer();
    const url = objectUrl(t, key);
    const res = await this.fetchFn(url, { method: "GET", headers: sign(t, "GET", url, {}, sha256(""), this.now()) });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new S3Error(`GET s3://${t.bucket}/${key}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.text();
  }

  /** Write an object. */
  async put(key: string, body: string | Uint8Array, contentType: string): Promise<void> {
    const t = await this.signer();
    const url = objectUrl(t, key);
    const res = await this.fetchFn(url, { method: "PUT", headers: sign(t, "PUT", url, { "content-type": contentType }, sha256(body), this.now()), body });
    if (!res.ok) throw new S3Error(`PUT s3://${t.bucket}/${key}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}
