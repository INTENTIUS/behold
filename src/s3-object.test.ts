import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasEnvCredentials, objectUrl, S3Error, S3Object, s3FromEnv, sign } from "./s3-object.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("Signature Version 4 (#491)", () => {
  // AWS's own worked example: "GET Object" in "Examples: Signature Calculations
  // in AWS Signature Version 4" (Amazon S3 API reference).
  it("signs AWS's GET Object example to AWS's signature", () => {
    const headers = sign(
      { region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
      "GET",
      "https://examplebucket.s3.amazonaws.com/test.txt",
      { range: "bytes=0-9" },
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      new Date("2013-05-24T00:00:00Z"),
    );
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("addresses AWS virtual-hosted and a custom endpoint path-style", () => {
    expect(objectUrl({ bucket: "b", region: "eu-west-1" }, "p/views/behold/index.html")).toBe("https://b.s3.eu-west-1.amazonaws.com/p/views/behold/index.html");
    expect(objectUrl({ bucket: "b", region: "us-east-1", endpoint: "http://floci:4566" }, "a b/c.json")).toBe("http://floci:4566/b/a%20b/c.json");
  });
});

describe("credentials from the environment (#491)", () => {
  it("takes static keys, then a role with a web identity token, and nothing else", () => {
    expect(hasEnvCredentials({})).toBe(false);
    expect(hasEnvCredentials({ AWS_PROFILE: "sso" })).toBe(false);
    expect(hasEnvCredentials({ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "s" })).toBe(true);
    expect(hasEnvCredentials({ AWS_ROLE_ARN: "arn:aws:iam::1:role/r", AWS_WEB_IDENTITY_TOKEN_FILE: "/t" })).toBe(true);
    expect(s3FromEnv("b", { AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "s", AWS_SESSION_TOKEN: "t", AWS_ENDPOINT_URL: "http://floci:4566/" })).toEqual({
      bucket: "b",
      endpoint: "http://floci:4566",
      region: "us-east-1",
      accessKeyId: "a",
      secretAccessKey: "s",
      sessionToken: "t",
    });
    expect(() => s3FromEnv("b", {})).toThrow(/no AWS credentials/);
  });

  it("assumes the role with the job's OIDC token before the first request, and signs with what STS answered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "behold-s3-"));
    made.push(dir);
    writeFileSync(join(dir, "token"), "oidc-token\n");
    const calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = [];
    const fetchFn = async (url: string, init: { method: string; headers: Record<string, string>; body?: unknown }) => {
      calls.push({ url, ...init });
      if (url.startsWith("https://sts.")) {
        return { ok: true, status: 200, text: async () => "<AssumeRoleWithWebIdentityResponse><Credentials><AccessKeyId>ASIA1</AccessKeyId><SecretAccessKey>sec</SecretAccessKey><SessionToken>tok</SessionToken></Credentials></AssumeRoleWithWebIdentityResponse>" };
      }
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const client = new S3Object(s3FromEnv("b", { AWS_ROLE_ARN: "arn:aws:iam::1:role/estate", AWS_WEB_IDENTITY_TOKEN_FILE: join(dir, "token"), AWS_REGION: "us-east-2" }), fetchFn as never);
    expect(await client.get("index.json")).toBe("{}");
    expect(calls[0]!.url).toBe("https://sts.us-east-2.amazonaws.com/");
    expect(String(calls[0]!.body)).toContain("WebIdentityToken=oidc-token");
    expect(calls[1]!.url).toBe("https://b.s3.us-east-2.amazonaws.com/index.json");
    expect(calls[1]!.headers.authorization).toContain("Credential=ASIA1/");
    expect(calls[1]!.headers["x-amz-security-token"]).toBe("tok");
  });

  it("answers undefined for a missing object and throws on any other failure", async () => {
    const fetchFn = async (url: string) => ({ ok: false, status: url.endsWith("gone.json") ? 404 : 403, text: async () => "<Error><Code>AccessDenied</Code></Error>" });
    const client = new S3Object({ bucket: "b", region: "us-east-1", accessKeyId: "a", secretAccessKey: "s" }, fetchFn as never);
    expect(await client.get("gone.json")).toBeUndefined();
    await expect(client.get("index.json")).rejects.toThrow(/403 <Error><Code>AccessDenied/);
  });
});

describe("DELETE and Cache-Control (#500)", () => {
  const target = { bucket: "b", region: "us-east-1", endpoint: "http://s3.test", accessKeyId: "a", secretAccessKey: "s" };

  it("signs a DELETE like a GET, and takes a missing object as deleted", async () => {
    const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
    const fetchFn = async (url: string, init: { method: string; headers: Record<string, string> }) => {
      calls.push({ url, ...init });
      return { ok: url.endsWith("here.json"), status: url.endsWith("here.json") ? 204 : 404, text: async () => "" };
    };
    const client = new S3Object(target, fetchFn as never, () => new Date("2026-10-10T00:00:00Z"));
    await client.delete("views/behold/snapshots/here.json");
    await client.delete("views/behold/snapshots/gone.json");
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["DELETE", "http://s3.test/b/views/behold/snapshots/here.json"],
      ["DELETE", "http://s3.test/b/views/behold/snapshots/gone.json"],
    ]);
    const expected = sign(target, "DELETE", calls[0]!.url, {}, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", new Date("2026-10-10T00:00:00Z"));
    expect(calls[0]!.headers).toEqual(expected);
  });

  it("throws an S3Error carrying the status and S3's code when a DELETE is refused", async () => {
    const fetchFn = async () => ({ ok: false, status: 403, text: async () => "<Error><Code>AccessDenied</Code><Message>no</Message></Error>" });
    const client = new S3Object(target, fetchFn as never);
    const e = await client.delete("views/behold/a.json").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(S3Error);
    expect((e as S3Error).status).toBe(403);
    expect((e as S3Error).code).toBe("AccessDenied");
  });

  it("sends and signs Cache-Control on a PUT when given one", async () => {
    const calls: { headers: Record<string, string> }[] = [];
    const fetchFn = async (_url: string, init: { headers: Record<string, string> }) => {
      calls.push(init);
      return { ok: true, status: 200, text: async () => "" };
    };
    const client = new S3Object(target, fetchFn as never);
    await client.put("views/behold/index.html", "<html>", "text/html; charset=utf-8", "no-cache");
    await client.put("views/behold/app.js", "x", "text/javascript");
    expect(calls[0]!.headers["cache-control"]).toBe("no-cache");
    expect(calls[0]!.headers.authorization).toContain("SignedHeaders=cache-control;content-type;host;");
    expect(calls[1]!.headers).not.toHaveProperty("cache-control");
  });
});
