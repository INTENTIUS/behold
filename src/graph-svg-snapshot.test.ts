import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createApp } from "./server.ts";
import { localServeOptions } from "./shot-cli.ts";

// #1069 moved the painter's icons into a generated module and its imports off
// the modules that read disk, so it bundles for a browser. None of that may
// change a picture: the bundled Terraform estate's /api/graph SVG is held to
// the bytes it had before. The snapshot was taken on origin/main before the
// change; a change that means to repaint updates it with `vitest -u`.
const ESTATE = join(import.meta.dirname, "..", "example-terraform-estate");

describe("the example Terraform estate's picture (#1069)", () => {
  it("is byte-identical to the snapshot", { timeout: 120_000 }, async () => {
    const app = createApp(await localServeOptions(ESTATE));
    const res = await app.request("http://localhost/api/graph");
    expect(res.status).toBe(200);
    const { svg } = (await res.json()) as { svg: string };
    // The cards wear the vendored AWS icons, so the icons are inside the bytes compared.
    expect(svg).toContain('id="aws-vpc-');
    await expect(svg).toMatchFileSnapshot("__snapshots__/example-terraform-estate.graph.svg");
  });
});
