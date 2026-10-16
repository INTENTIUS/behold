// behold#571: the kiosk's and the tool pages' link-preview tags, and the share image they name.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./server.ts";
import { SHARE_IMAGE, VENDOR_NAMES, VENDOR_TOOLS, shareOrigin } from "./terragucci-demo.ts";
// @ts-expect-error web/ is plain JS with no types (tsconfig excludes it).
import { VENDORS } from "../web/kiosk-vendor.js";

const HOST = "demo.intentius.io";

// The demo host's serve: --public, --allow-host <its name>, --terragucci <reports>.
const app = () => {
  const dir = mkdtempSync(join(tmpdir(), "behold-share-"));
  return createApp({ projectDir: dir, projectDirs: [dir], port: 0, public: true, allowedHosts: [HOST], terragucci: { source: dir, pollSecs: 0 } } as Parameters<typeof createApp>[0]);
};

const metas = (html: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)" \/>/g)) out[m[1]!] = m[2]!;
  return out;
};

describe("link previews (behold#571)", () => {
  it("gives /kiosk absolute https og:url and og:image for the allowed host behind the proxy", async () => {
    const r = await app().request("https://x/kiosk", { headers: { host: HOST, "x-forwarded-proto": "https" } });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("<title>behold · live demo</title>");
    expect(metas(html)).toMatchObject({
      "og:title": "behold · live demo",
      "og:type": "website",
      "og:url": `https://${HOST}/kiosk`,
      "og:image": `https://${HOST}/share.png`,
      "og:image:width": "1200",
      "og:image:height": "630",
      "twitter:card": "summary_large_image",
      "twitter:image": `https://${HOST}/share.png`,
    });
    expect(metas(html)["og:image:alt"]).toBeTruthy();
    expect(metas(html)["og:description"]).toBeTruthy();
    expect(html.indexOf('property="og:image"')).toBeLessThan(html.indexOf("</head>"));
  });

  it("gives each tool's page its own title and URL, and the tool's tag stays", async () => {
    for (const tool of VENDOR_TOOLS) {
      const html = await (await app().request(`https://x/${tool}`, { headers: { host: HOST, "x-forwarded-proto": "https" } })).text();
      const m = metas(html);
      expect(m["og:title"]).toBe(`behold · ${VENDOR_NAMES[tool]}`);
      expect(m["og:url"]).toBe(`https://${HOST}/${tool}`);
      expect(m["og:image"]).toBe(`https://${HOST}/share.png`);
      expect(m["kiosk-tool"]).toBe(tool);
      expect(html).toContain(`<title>behold · ${VENDOR_NAMES[tool]}</title>`);
    }
  });

  it("writes no URL for a Host the serve doesn't answer to", async () => {
    // The request guard refuses such a request before any route.
    expect((await app().request("http://x/kiosk", { headers: { host: "evil.example" } })).status).toBe(421);
    // And the tags never echo one: loopback is let in, but isn't on the allowed list.
    for (const path of ["/kiosk", "/terragrunt"]) {
      const html = await (await app().request(`http://x${path}`, { headers: { host: "localhost:4600", "x-forwarded-proto": "https" } })).text();
      const m = metas(html);
      expect(m["og:title"]).toBeTruthy();
      expect(m["og:url"]).toBeUndefined();
      expect(m["og:image"]).toBeUndefined();
      expect(m["twitter:image"]).toBeUndefined();
      expect(html).not.toContain("localhost");
    }
  });

  it("builds the origin from an allowed name alone, https only when the proxy says so", () => {
    expect(shareOrigin(HOST, "https", [HOST])).toBe(`https://${HOST}`);
    expect(shareOrigin(`${HOST}:8443`, "https,http", [HOST])).toBe(`https://${HOST}:8443`);
    expect(shareOrigin(HOST, undefined, [HOST])).toBe(`http://${HOST}`);
    expect(shareOrigin("DEMO.intentius.io", "HTTPS", [HOST])).toBe(`https://${HOST}`);
    expect(shareOrigin("evil.example", "https", [HOST])).toBeUndefined();
    expect(shareOrigin(`${HOST}.evil.example`, "https", [HOST])).toBeUndefined();
    expect(shareOrigin(`${HOST}"><script>`, "https", [HOST])).toBeUndefined();
    expect(shareOrigin(`${HOST}:x`, "https", [HOST])).toBeUndefined();
    expect(shareOrigin(undefined, "https", [HOST])).toBeUndefined();
    expect(shareOrigin(HOST, "https", [])).toBeUndefined();
  });

  it("serves the share image in public mode, 1200x630, cacheable", async () => {
    const r = await app().request("https://x/share.png", { headers: { host: HOST } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("cache-control")).toMatch(/^public, max-age=\d+$/);
    const png = Buffer.from(await r.arrayBuffer());
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([SHARE_IMAGE.width, SHARE_IMAGE.height]);
    expect(png.length).toBeLessThan(1_000_000);
    expect((await app().request("https://x/share.png", { method: "POST", headers: { host: HOST } })).status).toBe(405);
  });

  it("keeps the tool names in step with web/kiosk-vendor.js, and the site's copy of the image the same file", () => {
    for (const tool of VENDOR_TOOLS) expect(VENDOR_NAMES[tool]).toBe((VENDORS as Record<string, { name: string }>)[tool]!.name);
    const web = readFileSync(join(import.meta.dirname, "..", "web", "share.png"));
    const site = readFileSync(join(import.meta.dirname, "..", "docs", "public", "brand", "share.png"));
    expect(web.equals(site)).toBe(true);
  });
});
