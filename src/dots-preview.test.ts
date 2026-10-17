// #712: the dots preview's routes, which exist only when createApp is given
// `dotsPreview` (scripts/dots-preview.ts). `behold serve` never sets it.
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { ReadOnlyRunner } from "./public-mode.ts";
import { dotsIr, listRecordings, readDotsSource, showOf } from "./dots-preview.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const opts = { recordings: join(root, "scripts", "dot-bench"), walkthrough: join(root, "src", "__fixtures__", "terralith") };
const app = (preview = true) =>
  createApp({ projectDir: opts.recordings, port: 0, ...(preview ? { dotsPreview: opts } : {}) }, new Broadcaster(), new FrameBuffer(), new ReadOnlyRunner());

describe("the dots preview (#712)", () => {
  it("lists the committed recording", () => {
    expect(listRecordings(opts.recordings)).toContain("carve-terralith-14");
  });
  it("draws the carve's roster as one Terraform member, one card per resource", async () => {
    const res = await app().request("/api/graph?dots=carve:carve-terralith-14");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ir: { nodes: Array<{ id: string; lexicon: string }> }; svg: string; meta: { dots: { source: string; kind: string } } };
    expect(body.ir.nodes).toHaveLength(1041);
    expect(body.ir.nodes.every((n) => n.id.startsWith("behold-terralith-14/") && n.lexicon === "terraform")).toBe(true);
    expect(body.meta.dots).toEqual({ source: "carve:carve-terralith-14", kind: "carve" });
    expect((body.svg.match(/data-node-id=/g) ?? []).length).toBe(1041);
  });
  it("draws the walkthrough's 23 resources", async () => {
    const res = await app().request("/api/graph?dots=terralith");
    const body = (await res.json()) as { ir: { nodes: unknown[] } };
    expect(body.ir.nodes).toHaveLength(23);
  });
  it("orders the cards by unit, so a team's cards sit together", () => {
    const { order } = dotsIr(showOf(readDotsSource(opts, "carve:carve-terralith-14")));
    const i = order.indexOf("behold-terralith-14/aws_iam_role.team_0000_role");
    const j = order.indexOf("behold-terralith-14/aws_iam_instance_profile.team_0000_profile");
    expect(Math.abs(i - j)).toBeLessThan(6);
  });
  it("serves only the sources it lists, never a path", async () => {
    expect((await app().request("/api/dots/source?name=carve:../../package")).status).toBe(404);
    expect((await app().request("/api/dots/source?name=carve:nope")).status).toBe(404);
    expect((await app().request("/api/graph?dots=elsewhere")).status).toBe(404);
  });
  it("adds nothing to an app built without it", async () => {
    const res = await app(false).request("/api/dots/sources");
    expect(res.headers.get("content-type") ?? "").not.toMatch(/json/);
  });
});
