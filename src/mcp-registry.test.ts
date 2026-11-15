import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Ajv from "ajv";

// behold#1050: the official MCP Registry listing. server.json is what
// `mcp-publisher publish` sends; these checks keep it valid against the
// registry's published schema and in step with package.json and the listing
// copy, so a version bump or a copy change cannot leave the listing behind.

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const pkg = JSON.parse(read("package.json"));
const listing = JSON.parse(read("plugins/listing.json"));
const server = JSON.parse(read("server.json"));
const schema = JSON.parse(read("plugins/server.schema.2025-12-11.json"));

describe("MCP Registry listing (#1050)", () => {
  it("validates against the registry's published schema", () => {
    expect(server.$schema).toBe(schema.$id);
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    expect(validate(server), JSON.stringify(validate.errors)).toBe(true);
  });
  it("names the server with package.json's mcpName", () => {
    expect(pkg.mcpName).toBe(server.name);
  });
  it("uses the owner's GitHub spelling in the name (github-oidc grants it case-sensitively)", () => {
    expect(server.name).toBe("io.github.INTENTIUS/behold");
  });
  it("carries the listing's short form as the description", () => {
    expect(server.description).toBe(listing.short);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
  it("follows package.json's version and name", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    const [p] = server.packages;
    expect(p.registryType).toBe("npm");
    expect(p.identifier).toBe(pkg.name);
    expect(p.version).toBe(pkg.version);
  });
  it("starts the stdio server with `behold mcp`", () => {
    const [p] = server.packages;
    expect(p.transport.type).toBe("stdio");
    expect(p.packageArguments).toEqual([{ type: "positional", value: "mcp" }]);
    expect(Object.keys(pkg.bin)).toContain("behold");
  });
});
