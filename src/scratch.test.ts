import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertScratch, scratchNameProblem, scratchPortProblem, PROTECTED_INFRA } from "./scratch.js";
import { LIVE_CONTAINER, LIVE_PORT } from "./carve-live.js";
import { ASK_DEMO_CONTAINERS, ASK_DEMO_SCRATCH } from "../scripts/ask-demo/scratch.ts";

describe("scratch discipline — the denylist", () => {
  it("accepts behold-* names", () => {
    for (const n of ["behold-carve-floci", "behold-flux-e2e", "behold-argo-e2e"]) {
      expect(scratchNameProblem(n)).toBeUndefined();
    }
  });

  it("refuses every protected name, and anything not prefixed behold-", () => {
    for (const n of ["floci", "floci-az", "floci-gcp", "chant-floci", "chant-floci-az", "k3d-kubemicrovm-local", "k3d-fountain-local", "kubemicrovm-local", "fountain-local"]) {
      expect(scratchNameProblem(n), n).toMatch(/behold-\*|protected/);
    }
    // A protected name can't be smuggled in under the prefix either.
    expect(PROTECTED_INFRA.every((re) => !re.test("behold-floci"))).toBe(true);
    expect(scratchNameProblem("behold-floci")).toBeUndefined();
  });

  it("refuses the shared emulator ports", () => {
    for (const p of [4566, 4577, 4588]) expect(scratchPortProblem(p)).toMatch(/shared emulator/);
    expect(scratchPortProblem(4602)).toBeUndefined();
  });

  it("assertScratch throws with the reason", () => {
    expect(() => assertScratch("floci")).toThrow(/scratch discipline/);
    expect(() => assertScratch("behold-x", 4566)).toThrow(/4566/);
    expect(() => assertScratch("behold-x", 4602)).not.toThrow();
  });
});

describe("scratch discipline — every boot site honours it", () => {
  it("the carve --live tier's container and port pass", () => {
    expect(() => assertScratch(LIVE_CONTAINER, LIVE_PORT)).not.toThrow();
  });

  // behold#1161: the ask demo recorder boots three floci containers and a
  // kind cluster, named once in scripts/ask-demo/scratch.ts.
  it("the ask demo recorder's containers, cluster and serve port pass, and record.ts boots nothing else", () => {
    for (const c of ASK_DEMO_CONTAINERS) expect(() => assertScratch(c.name, c.port)).not.toThrow();
    expect(() => assertScratch(ASK_DEMO_SCRATCH.cluster.name)).not.toThrow();
    expect(() => assertScratch(`${ASK_DEMO_SCRATCH.cluster.name}-control-plane`)).not.toThrow();
    expect(scratchPortProblem(ASK_DEMO_SCRATCH.serve.port)).toBeUndefined();
    const text = readFileSync(join(import.meta.dirname, "..", "scripts", "ask-demo", "record.ts"), "utf8");
    // It refuses names that exist, asserts each before booting, and deletes only through the constants.
    expect(text).toMatch(/already exists/);
    expect(text).toMatch(/assertScratch\(c\.name, c\.port\)/);
    // The one removal not by name is the app containers the emulators started during the run: labelled floci=true, absent before it booted.
    for (const m of text.matchAll(/"(?:rm|delete)", (?:"-f", |"cluster", "--name", )([^\]),]+)/g)) expect(m[1], m[0]).toMatch(/ASK_DEMO_|^\.\.\.startedByRun$/);
    expect(text).toMatch(/const startedByRun = [^;]*label=floci=true[^;]*!made\.flociBefore\.has\(id\)/);
    expect(text).not.toMatch(/"behold-ask-demo-(?:floci|control)/);
  });

  // The e2e scripts are bash, so the discipline is asserted on their text:
  // each script that creates a k3d cluster names it behold-*, refuses when
  // the name is taken, and deletes only through the same variable.
  const e2eDir = join(import.meta.dirname, "..", "e2e");
  const scripts = readdirSync(e2eDir).filter((f) => f.endsWith(".sh"));
  const creators = scripts.filter((f) => /k3d cluster create/.test(readFileSync(join(e2eDir, f), "utf8")));

  it("finds the k3d-booting e2es (sanity: the flux and argo lanes)", () => {
    expect(creators).toEqual(expect.arrayContaining(["flux-estate-k3d-e2e.sh", "argo-estate-k3d-e2e.sh"]));
  });

  for (const f of creators) {
    it(`${f}: behold-* name, refuse-if-exists, delete-own-only`, () => {
      const text = readFileSync(join(e2eDir, f), "utf8");
      const assign = text.match(/^CLUSTER=(\S+)/m);
      expect(assign, "CLUSTER= is set once").not.toBeNull();
      const value = assign![1].replace(/["']/g, "");
      // An env override (behold#1032) keeps a literal default, and the script
      // refuses at run time any override that is not behold-*.
      const override = value.match(/^\$\{[A-Z0-9_]+:-([^}]+)\}$/);
      expect(scratchNameProblem(override ? override[1] : value)).toBeUndefined();
      if (override) expect(text).toMatch(/case "\$CLUSTER" in behold-\*\) ;; \*\)[^\n]*exit/);
      expect(text).toMatch(/k3d cluster list[^\n]*\n[^\n]*already exists/);
      expect(text).toMatch(/trap [^\n]*EXIT/);
      for (const del of text.matchAll(/k3d cluster delete\s+"?(\$\{?[A-Za-z_]+\}?|[A-Za-z0-9._-]+)/g)) {
        expect(del[1].replace(/[{}]/g, ""), `${f}: ${del[0]}`).toBe("$CLUSTER");
      }
    });
  }

  // Every literal name handed to a create/delete/--name in the e2es or the
  // (non-test) sources is checked against the denylist. Variables (`$CLUSTER`,
  // `LIVE_CONTAINER`) are covered by the assertions above.
  it("no e2e script or source file creates or deletes a protected name", () => {
    const srcDir = join(import.meta.dirname);
    const files = [
      ...scripts.map((f) => join(e2eDir, f)),
      ...readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(srcDir, f)),
    ];
    const targets = /(?:k3d cluster (?:create|delete)|--name)\s+"?([A-Za-z0-9._-]+)/g;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(targets)) {
        const hit = PROTECTED_INFRA.find((re) => re.test(m[1]));
        expect(hit, `${file}: ${m[0]}`).toBeUndefined();
      }
    }
  });
});
