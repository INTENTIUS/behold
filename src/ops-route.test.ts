import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./server.ts";
import { Broadcaster } from "./events.ts";
import { FrameBuffer } from "./frames.ts";
import { OpRunner } from "./op-runner.ts";
import type { GraphIR } from "@intentius/chant";

// The HTTP half of the ops lens (#284 item 1). src/ops-lens.test.ts covers the
// conversion itself against the same real fixtures; this proves the lens stop
// reaches a client through the route — SVG included — and, just as much, that
// it does NOT appear for a project that has emitted no Ops. A stop that is
// offered and then refuses is the defect this pair exists to prevent.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "__fixtures__", "ops-example-writes");

/** A project dir with the real emitted IR laid out where chant writes it —
 * `dist/ops/<name>/op.json` — plus the `chant.config.ts` a project needs to not
 * read as "you pointed behold at nothing" (#193). */
function opsProject(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "behold-ops-route-"));
  writeFileSync(join(dir, "chant.config.ts"), "export default { lexicons: [\"aws\", \"temporal\"] };\n");
  for (const name of names) {
    mkdirSync(join(dir, "dist", "ops", name), { recursive: true });
    cpSync(join(FIXTURES, `${name}.op.json`), join(dir, "dist", "ops", name, "op.json"));
  }
  return dir;
}

function appFor(dirs: string[]) {
  const broadcaster = new Broadcaster();
  return createApp(
    { projectDir: dirs[0], ...(dirs.length > 1 ? { projectDirs: dirs } : {}), port: 0 },
    broadcaster,
    new FrameBuffer(),
    new OpRunner({ projectDir: dirs[0], broadcaster, onDone: () => {} }),
  );
}

let built: string;
let unbuilt: string;
beforeAll(() => {
  built = opsProject(["floci-apply", "prod-apply", "prod-promote", "prod-reconcile"]);
  unbuilt = mkdtempSync(join(tmpdir(), "behold-ops-none-"));
  writeFileSync(join(unbuilt, "chant.config.ts"), "export default { lexicons: [\"aws\"] };\n");
});
afterAll(() => {
  rmSync(built, { recursive: true, force: true });
  rmSync(unbuilt, { recursive: true, force: true });
});

describe("GET /api/graph?ops=1 (#284)", () => {
  it("renders the declared Ops: step cards, phase boxes, an SVG", async () => {
    const res = await appFor([built]).request("/api/graph?ops=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ir: GraphIR; svg: string; meta: Record<string, unknown> };

    expect(body.ir.nodes).toHaveLength(13);
    expect(body.ir.nodes.every((n) => n.lexicon === "op")).toBe(true);
    expect(body.meta.mode).toBe("ops");
    expect(body.meta.ops).toBe(4);

    // The phases are actually DRAWN, not merely present in the IR: the route
    // opts into `boxes: "byStack"` and pinhole labels each box.
    expect(body.svg).toContain("<svg");
    for (const box of ["floci-apply · Build", "prod-promote · Approve", "prod-reconcile · Snapshot"]) {
      expect(body.svg).toContain(box);
    }
    // The pinned card fields reach the card (the op presentation pack, src/render.ts).
    expect(body.svg).toContain("longInfra");
    expect(body.svg).toContain("approve-promote");
    expect(String(body.meta.note)).toContain("4 declared Ops");
    expect(String(body.meta.note)).toContain("No estate cross-links");
  });

  it("keeps a step's entities on the card and degrades the estate link to unresolved when no member can be graphed here (chant#2022)", async () => {
    // The fixture project has no chant of its own, so the member IR read fails;
    // the track still renders, the httpCheck card still says what it touches,
    // and the reference is stated as unresolved rather than the view refusing.
    const res = await appFor([built]).request("/api/graph?ops=1&entities=1");
    expect(res.status).toBe(200);
    const { ir, meta } = (await res.json()) as { ir: GraphIR; meta: { note: string } };
    const check = ir.nodes.find((n) => n.id === "floci-apply/Verify/httpCheck")!;
    expect(check.attrs.entities).toBe("http://localhost:4566/behold-floci-demo");
    expect(check.attrs._entityLinks).toEqual({ resolved: [], unresolved: ["http://localhost:4566/behold-floci-demo"] });
    expect(ir.nodes.every((n) => n.lexicon === "op")).toBe(true);
    expect(meta.note).toContain("2 entity refs, 0 linked");
    // Without the flag the branch shells nothing and attempts no link: the
    // card still names what the step touches, and the note counts it unlinked.
    const plain = (await (await appFor([built]).request("/api/graph?ops=1")).json()) as { ir: GraphIR; meta: { note: string } };
    const plainCheck = plain.ir.nodes.find((n) => n.id === "floci-apply/Verify/httpCheck")!;
    expect(plainCheck.attrs.entities).toBe("http://localhost:4566/behold-floci-demo");
    expect(plainCheck.attrs._entityLinks).toBeUndefined();
    expect(plain.meta.note).toContain("2 entity refs, 0 linked");
  });

  it("ignores the entity lenses the SPA sends along — an Op is source, not a tier of it", async () => {
    const res = await appFor([built]).request("/api/graph?ops=1&detail=3&components=1&logical=1&radial=1&tier=prod-ha");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ir: GraphIR; meta: { mode: string; tier: unknown; target: unknown } };
    expect(body.meta.mode).toBe("ops");
    expect(body.ir.nodes).toHaveLength(13);
    expect(body.meta.tier).toBeNull();
    expect(body.meta.target).toBeNull();
  });

  it("finds Ops across every member of a composed estate (#31)", async () => {
    const other = opsProject(["prod-reconcile"]);
    try {
      // The estate's PRIMARY has no Ops at all — the lens still finds the
      // member's, exactly as the delegated-write surface does.
      const res = await appFor([unbuilt, other]).request("/api/graph?ops=1");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ir: GraphIR; meta: { ops: number } };
      expect(body.meta.ops).toBe(1);
      expect(body.ir.nodes.every((n) => n.id.startsWith("prod-reconcile/"))).toBe(true);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("answers a project with no emitted Ops with a structured error, not a blank graph (#193)", async () => {
    const res = await appFor([unbuilt]).request("/api/graph?ops=1");
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; code: string; remedy: string };
    expect(body.code).toBe("op-ir");
    expect(body.error).toContain("dist/ops/<name>/op.json");
    expect(body.remedy).toContain("chant build --lexicon temporal");
  });

  it("refuses the whole view on one unreadable op.json rather than drawing a partial track", async () => {
    const broken = opsProject(["prod-apply"]);
    try {
      writeFileSync(join(broken, "dist", "ops", "prod-apply", "op.json"), "{ not json");
      const res = await appFor([broken]).request("/api/graph?ops=1");
      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe("op-ir");
      expect(body.error).toContain("isn't valid JSON");
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it("refuses an op.json whose format major it can't read", async () => {
    const future = opsProject(["prod-apply"]);
    try {
      const path = join(future, "dist", "ops", "prod-apply", "op.json");
      const ir = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      writeFileSync(path, JSON.stringify({ ...ir, formatVersion: "2.0" }));
      const res = await appFor([future]).request("/api/graph?ops=1");
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("behold reads version 1");
    } finally {
      rmSync(future, { recursive: true, force: true });
    }
  });

  it("leaves the entity graph alone when ops isn't asked for", async () => {
    // The stop is opt-in: the same project without `?ops=1` never sees an op node.
    const res = await appFor([built]).request("/api/graph");
    const body = (await res.json()) as { ir?: GraphIR; meta?: { mode?: string } };
    expect(body.meta?.mode).not.toBe("ops");
    expect((body.ir?.nodes ?? []).some((n) => n.lexicon === "op")).toBe(false);
  });
});

describe("GET /api/project — the ops stop's presence (#284)", () => {
  it("reports the emitted Op count, so the SPA offers the stop", async () => {
    const res = await appFor([built]).request("/api/project");
    const body = (await res.json()) as { ops?: number };
    expect(body.ops).toBe(4);
  });

  it("omits `ops` entirely for a project that has emitted none — no dead stop", async () => {
    const res = await appFor([unbuilt]).request("/api/project");
    const body = (await res.json()) as Record<string, unknown>;
    expect("ops" in body).toBe(false);
  });

  it("counts across the estate, not just the primary (#31)", async () => {
    const other = opsProject(["prod-apply", "prod-promote"]);
    try {
      const res = await appFor([unbuilt, other]).request("/api/project");
      const body = (await res.json()) as { ops?: number };
      expect(body.ops).toBe(2);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
